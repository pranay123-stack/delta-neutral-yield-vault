// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {IEmergencyController} from "../interfaces/IEmergencyController.sol";
import {IPositionManager} from "../interfaces/IPositionManager.sol";
import {IRebalanceManager} from "../interfaces/IRebalanceManager.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {DeltaCalculator} from "../libraries/DeltaCalculator.sol";
import {PerpMath} from "../libraries/PerpMath.sol";
import {Types} from "../libraries/Types.sol";

/// @title RebalanceManager
/// @notice Decides *whether* and *how* to rebalance, entirely from on-chain state, then has the
///         strategy execute and the risk manager validate the result.
/// @dev Target state (everything derived from total NAV N):
///        reserve R* = N * reserveBps                (defensiveReserveBps when funding < floor)
///        basis   B* = N - R*
///        long    L* = B* * lev / (lev + h)          (so that L* + h*L*/lev = B*)
///        equity  E* = h * L* / lev                  (perp margin at target leverage)
///        short     = -h * longQty                   (re-hedged against the actual post-trade long)
///      where `lev` is the vol-scaled target leverage and `h` the hedge ratio.
///      Triggers (any one fires a rebalance): delta outside the vol-scaled band, leverage outside its
///      band, long leg drifted from L*, idle cash to deploy, liquidation distance below the warn level.
///      Filters for non-urgent rebalances: cooldown, max execution cost, and for *relevering*, the
///      extra carry over `carryHorizonSec` must exceed the execution cost. Urgent rebalances (risk at
///      HIGH levels) bypass the filters - the point of them is to not get liquidated.
///      When a trigger fires the plan moves all the way to target (not just to the band edge): fewer
///      follow-up rebalances at the cost of slightly larger trades. See docs/rebalancing.md.
contract RebalanceManager is IRebalanceManager, Auth {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    int256 internal constant FUNDING_PERIODS_PER_YEAR = 1095;
    int256 internal constant BPS_I = 10_000;
    int256 internal constant WAD_I = 1e18;

    uint32 public constant TRIGGER_DELTA = 1 << 0;
    uint32 public constant TRIGGER_LEVERAGE_HIGH = 1 << 1;
    uint32 public constant TRIGGER_LEVERAGE_LOW = 1 << 2;
    uint32 public constant TRIGGER_ALLOCATION = 1 << 3;
    uint32 public constant TRIGGER_IDLE = 1 << 4;
    uint32 public constant TRIGGER_LIQUIDATION = 1 << 5;
    uint32 public constant TRIGGER_FUNDING_DEFENSIVE = 1 << 6;

    /// @dev RiskMetrics-style EWMA decay per observation.
    uint256 public constant EWMA_LAMBDA_WAD = 0.94e18;
    /// @dev Observations closer together than this are ignored (a spammed feed can't distort vol).
    uint256 public constant MIN_OBSERVATION_INTERVAL = 1 hours;

    IStrategyManager public immutable strategy;
    IPositionManager public immutable positionManager;
    IRiskManager public immutable riskManager;
    IDeltaNeutralVault public immutable vault;
    IEmergencyController public immutable emergency;

    Targets internal _targets;
    TargetBounds internal _bounds;
    Params internal _params;

    uint64 public override lastRebalanceAt;
    uint256 public override rebalanceCount;

    uint256 public lastObservedPrice;
    uint64 public lastObservedAt;
    uint256 public ewmaVarianceWad; // annualised variance, WAD (0.36e18 == 60% vol)

    error InvalidTargets();
    error InvalidParams();

    constructor(
        IAccessRegistry registry_,
        IStrategyManager strategy_,
        IPositionManager positionManager_,
        IRiskManager riskManager_,
        IDeltaNeutralVault vault_,
        IEmergencyController emergency_,
        TargetBounds memory bounds_,
        Targets memory targets_,
        Params memory params_
    ) Auth(registry_) {
        strategy = strategy_;
        positionManager = positionManager_;
        riskManager = riskManager_;
        vault = vault_;
        emergency = emergency_;
        _bounds = bounds_;
        _setTargets(targets_);
        _setParams(params_);
        // seed the vol estimate at the reference level until real observations arrive
        ewmaVarianceWad = Math.mulDiv(uint256(params_.volRefBps) * 1e14, uint256(params_.volRefBps) * 1e14, WAD);
    }

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    /// @notice Strategist moves targets within admin bounds (e.g. following the off-chain optimizer).
    function setTargets(Targets calldata t) external onlyRole(Roles.STRATEGIST) {
        _setTargets(t);
    }

    function setBounds(TargetBounds calldata b) external onlyRole(Roles.ADMIN) {
        if (
            b.minLeverageBps < BPS / 2 || b.minLeverageBps > b.maxLeverageBps || b.maxLeverageBps > 50_000
                || b.minHedgeRatioBps > b.maxHedgeRatioBps || b.maxHedgeRatioBps > 12_000
                || b.minReserveBps > b.maxReserveBps || b.maxReserveBps > BPS
        ) revert InvalidTargets();
        _bounds = b;
        _setTargets(_targets); // re-validate current targets against the new bounds
    }

    function setParams(Params calldata p) external onlyRole(Roles.ADMIN) {
        _setParams(p);
    }

    // ------------------------------------------------------------------
    // Keeper surface (Chainlink Automation compatible)
    // ------------------------------------------------------------------

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        (, upkeepNeeded) = _plan(positionManager.snapshot());
        return (upkeepNeeded, "");
    }

    /// @dev Recomputes the plan from state instead of trusting `performData`, so a keeper can't
    ///      inject a plan; the keeper only chooses *when* to call.
    function performUpkeep(bytes calldata) external override onlyRole(Roles.KEEPER) {
        if (emergency.strategyPaused()) revert StrategyPaused();
        _observe();
        Types.PositionSnapshot memory pre = positionManager.snapshot();
        if (!pre.priceHealthy) revert OracleUnhealthy();
        (Types.RebalancePlan memory plan, bool execute) = _plan(pre);
        if (!execute) revert NothingToRebalance();

        if (plan.sweepIdle > 0) vault.pushToStrategy(plan.sweepIdle);
        Types.ExecutionResult memory res;
        bool trades = plan.longUsdDelta != 0 || plan.marginDelta != 0 || plan.triggers & ~TRIGGER_IDLE != 0;
        if (trades) res = strategy.executeRebalance(plan);

        Types.PositionSnapshot memory post = positionManager.snapshot();
        riskManager.validateRebalance(pre, post);
        riskManager.checkpoint();

        // only trading resets the cooldown; a cost-free idle sweep must not starve risk rebalances
        if (trades) lastRebalanceAt = uint64(block.timestamp);
        emit Rebalanced(++rebalanceCount, _record(plan, res, pre, post));
    }

    function _record(
        Types.RebalancePlan memory plan,
        Types.ExecutionResult memory res,
        Types.PositionSnapshot memory pre,
        Types.PositionSnapshot memory post
    ) internal pure returns (RebalanceRecord memory r) {
        r.triggers = plan.triggers;
        r.urgent = plan.urgent;
        r.longUsdDelta = plan.longUsdDelta;
        r.marginDelta = plan.marginDelta;
        r.perpSizeChange = res.perpSizeChange;
        r.preDeltaBps = DeltaCalculator.compute(pre, plan.hedgeRatioBps).deltaBps;
        r.postDeltaBps = DeltaCalculator.compute(post, plan.hedgeRatioBps).deltaBps;
        r.preLeverageBps = _leverage(pre);
        r.postLeverageBps = _leverage(post);
        r.estimatedCost = plan.estimatedCost;
        r.realizedCost = res.tradingFees + res.slippage;
    }

    /// @notice Record a price observation for the volatility estimate. Keeper calls this every tick.
    function observeVolatility() external onlyRole(Roles.KEEPER) {
        _observe();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function previewRebalance() external view override returns (Types.RebalancePlan memory, bool) {
        return _plan(positionManager.snapshot());
    }

    function targets() external view override returns (Targets memory) {
        return _targets;
    }

    function bounds() external view returns (TargetBounds memory) {
        return _bounds;
    }

    function params() external view override returns (Params memory) {
        return _params;
    }

    /// @notice Annualised EWMA volatility in bps, including any observation that is due now.
    function annualizedVolBps() public view override returns (uint256) {
        return Math.sqrt(_projectedVariance(_currentPriceOrZero()) * WAD) / 1e14;
    }

    /// @notice Target leverage scaled down when realised vol exceeds the reference:
    ///         lev = target * volRef / max(vol, volRef), floored at the admin minimum.
    function effectiveLeverageBps() public view override returns (uint256) {
        uint256 lev = _targets.targetLeverageBps;
        uint256 vol = annualizedVolBps();
        uint256 ref = _params.volRefBps;
        if (vol > ref && ref > 0) lev = Math.mulDiv(lev, ref, vol);
        return Math.max(lev, _bounds.minLeverageBps);
    }

    function fundingAprBps() public view returns (int256) {
        return strategy.perpAdapter().fundingRatePer8h() * FUNDING_PERIODS_PER_YEAR * BPS_I / 1e18;
    }

    // ------------------------------------------------------------------
    // Planning
    // ------------------------------------------------------------------

    struct Ctx {
        uint256 nav;
        uint256 lev;
        uint256 h;
        uint256 targetLong;
        uint256 curLev;
        uint256 absDelta;
        uint256 deltaBand;
        uint256 liqDist;
        bool defensive;
    }

    function _plan(Types.PositionSnapshot memory s)
        internal
        view
        returns (Types.RebalancePlan memory plan, bool execute)
    {
        if (!s.priceHealthy || s.totalNav == 0 || emergency.strategyPaused()) return (plan, false);
        IRiskManager.RiskConfig memory rc = riskManager.config();
        Params memory p = _params;
        Ctx memory c = _context(s, p);

        plan.hedgeRatioBps = c.h;
        plan.maxSlippageBps = rc.maxSlippageBps;
        plan.triggers = _triggers(s, p, c, rc);
        if (plan.triggers == 0) return (plan, false);

        plan.urgent =
            plan.triggers & TRIGGER_LIQUIDATION != 0 || c.curLev > rc.leverage.high || c.absDelta > rc.delta.high;
        if (s.vaultIdle > 0) plan.sweepIdle = s.vaultIdle;

        bool cooling = block.timestamp < uint256(lastRebalanceAt) + p.minIntervalSec;
        if (!plan.urgent && cooling) {
            // cost-free idle sweep is allowed during cooldown; trading is not
            return (_sweepOnly(plan), plan.triggers & TRIGGER_IDLE != 0);
        }

        _sizeTrades(s, p, c, plan);

        if (!plan.urgent) {
            plan.estimatedCost = _estimateCost(s, plan);
            if (plan.estimatedCost > Math.mulDiv(c.nav, p.maxCostBps, BPS)) {
                return (_sweepOnly(plan), plan.triggers & TRIGGER_IDLE != 0);
            }
            if (plan.longUsdDelta > 0 && !_carryPaysForCost(s, p, c, plan)) {
                // don't add basis exposure that won't earn back its entry cost; keep risk-driven parts
                plan.longUsdDelta = 0;
                _sizeMargin(s, p, c, plan, s.longValue);
                plan.estimatedCost = _estimateCost(s, plan);
                bool riskParts = plan.triggers & (TRIGGER_DELTA | TRIGGER_LEVERAGE_HIGH | TRIGGER_LEVERAGE_LOW) != 0;
                if (!riskParts && plan.marginDelta == 0) {
                    return (_sweepOnly(plan), plan.triggers & TRIGGER_IDLE != 0);
                }
            }
        } else {
            plan.estimatedCost = _estimateCost(s, plan);
        }
        execute = true;
    }

    function _context(Types.PositionSnapshot memory s, Params memory p) internal view returns (Ctx memory c) {
        Targets memory t = _targets;
        c.nav = s.totalNav;
        c.lev = effectiveLeverageBps();
        c.h = t.hedgeRatioBps;
        int256 fundingApr = s.fundingRatePer8h * FUNDING_PERIODS_PER_YEAR * BPS_I / 1e18;
        c.defensive = fundingApr < p.fundingFloorAprBps;
        uint256 reserveBps = c.defensive ? Math.max(t.reserveBps, t.defensiveReserveBps) : t.reserveBps;
        uint256 basis = Math.mulDiv(c.nav, BPS - reserveBps, BPS);
        c.targetLong = Math.mulDiv(basis, c.lev, c.lev + c.h);
        c.curLev = _leverage(s);
        c.absDelta = DeltaCalculator.absDeltaBps(DeltaCalculator.compute(s, c.h));
        c.deltaBand = DeltaCalculator.scaledBand(p.deltaBandBps, annualizedVolBps(), p.volRefBps, p.deltaBandBps / 4);
        c.liqDist = PerpMath.distanceBps(s.markPrice, s.liquidationPrice, s.perpSize);
    }

    function _triggers(
        Types.PositionSnapshot memory s,
        Params memory p,
        Ctx memory c,
        IRiskManager.RiskConfig memory rc
    ) internal pure returns (uint32 t) {
        if (c.absDelta > c.deltaBand) t |= TRIGGER_DELTA;
        if (s.perpSize != 0) {
            if (c.curLev > Math.mulDiv(c.lev, BPS + p.leverageBandBps, BPS)) t |= TRIGGER_LEVERAGE_HIGH;
            else if (c.curLev < Math.mulDiv(c.lev, BPS - p.leverageBandBps, BPS)) t |= TRIGGER_LEVERAGE_LOW;
        }
        uint256 drift = c.targetLong > s.longValue ? c.targetLong - s.longValue : s.longValue - c.targetLong;
        uint256 allocBand = Math.mulDiv(c.nav, p.allocationBandBps, BPS);
        if (drift > allocBand && drift >= p.minTradeUsd) {
            t |= TRIGGER_ALLOCATION;
            if (c.defensive && s.longValue > c.targetLong) t |= TRIGGER_FUNDING_DEFENSIVE;
        }
        if (s.vaultIdle >= p.minDeployUsd && s.vaultIdle > 0) t |= TRIGGER_IDLE;
        if (s.perpSize != 0 && c.liqDist < rc.liquidationDistance.warn) t |= TRIGGER_LIQUIDATION;
    }

    function _sizeTrades(
        Types.PositionSnapshot memory s,
        Params memory p,
        Ctx memory c,
        Types.RebalancePlan memory plan
    ) internal view {
        // long leg: move to target when allocation drifted or risk is urgent
        if (plan.triggers & TRIGGER_ALLOCATION != 0 || plan.urgent) {
            int256 d = c.targetLong.toInt256() - s.longValue.toInt256();
            if (PerpMath.abs(d) >= p.minTradeUsd) plan.longUsdDelta = d;
        }
        // Cash the strategy can spend on buys + margin. The strategy raises cash before spending it
        // (sells, then releases excess margin, then deposits/buys), so both count as sources.
        uint256 cash = strategy.lendingAdapter().withdrawable(strategy.asset()) + s.strategyFloat + plan.sweepIdle;
        if (plan.longUsdDelta < 0) cash += PerpMath.abs(plan.longUsdDelta);
        if (plan.longUsdDelta > 0) {
            // buy dL and re-margin to h*(L+dL)/lev:  dL + h*(L+dL)/lev - E <= cash
            //   =>  max dL = (cash + E - h*L/lev) * lev / (lev + h)
            int256 hl = Math.mulDiv(Math.mulDiv(s.longValue, c.h, BPS), BPS, c.lev).toInt256();
            int256 dl = uint256(plan.longUsdDelta).toInt256();
            int256 need = dl + Math.mulDiv(Math.mulDiv(dl.toUint256(), c.h, BPS), BPS, c.lev).toInt256() + hl
                - s.perpEquity.toInt256();
            if (need > cash.toInt256()) {
                int256 room = cash.toInt256() + s.perpEquity.toInt256() - hl;
                plan.longUsdDelta = room > 0 ? Math.mulDiv(room.toUint256(), c.lev, c.lev + c.h).toInt256() : int256(0);
                if (PerpMath.abs(plan.longUsdDelta) < p.minTradeUsd) plan.longUsdDelta = 0;
            }
        }
        _sizeMargin(s, p, c, plan, (s.longValue.toInt256() + plan.longUsdDelta).toUint256());
        if (plan.marginDelta > 0) {
            uint256 spentOnBuys = plan.longUsdDelta > 0 ? plan.longUsdDelta.toUint256() : 0;
            uint256 left = cash > spentOnBuys ? cash - spentOnBuys : 0;
            if (plan.marginDelta.toUint256() > left) plan.marginDelta = left.toInt256();
        }
    }

    function _sizeMargin(
        Types.PositionSnapshot memory s,
        Params memory p,
        Ctx memory c,
        Types.RebalancePlan memory plan,
        uint256 newLong
    ) internal pure {
        bool resize = plan.triggers
                    & (TRIGGER_LEVERAGE_HIGH | TRIGGER_LEVERAGE_LOW | TRIGGER_ALLOCATION | TRIGGER_LIQUIDATION) != 0
            || plan.urgent || (s.perpSize == 0 && newLong > 0);
        plan.marginDelta = 0;
        if (!resize) return;
        uint256 targetEquity = Math.mulDiv(Math.mulDiv(newLong, c.h, BPS), BPS, c.lev);
        int256 d = targetEquity.toInt256() - s.perpEquity.toInt256();
        if (PerpMath.abs(d) >= p.minTradeUsd) plan.marginDelta = d;
    }

    /// @dev Fees + price impact for the swap and the implied hedge trade, from live venue quotes.
    function _estimateCost(Types.PositionSnapshot memory s, Types.RebalancePlan memory plan)
        internal
        view
        returns (uint256 cost)
    {
        address usdc = strategy.asset();
        address weth = strategy.weth();
        int256 newLongQty = s.longQty.toInt256();
        if (plan.longUsdDelta > 0) {
            uint256 x = plan.longUsdDelta.toUint256();
            (uint256 out,) = strategy.swapAdapter().quote(usdc, weth, x);
            cost += _posDiff(x, Math.mulDiv(out, s.price, PerpMath.QTY_PRICE_TO_USD6));
            newLongQty += out.toInt256();
        } else if (plan.longUsdDelta < 0) {
            uint256 qty =
                Math.min(Math.mulDiv(PerpMath.abs(plan.longUsdDelta), PerpMath.QTY_PRICE_TO_USD6, s.price), s.longQty);
            if (qty > 0) {
                (uint256 out,) = strategy.swapAdapter().quote(weth, usdc, qty);
                cost += _posDiff(Math.mulDiv(qty, s.price, PerpMath.QTY_PRICE_TO_USD6), out);
                newLongQty -= qty.toInt256();
            }
        }
        int256 target = -PerpMath.mulDivSigned(newLongQty, plan.hedgeRatioBps, BPS);
        int256 hedgeDelta = target - s.perpSize;
        if (hedgeDelta != 0) {
            uint256 exec = strategy.perpAdapter().quoteExecutionPrice(hedgeDelta);
            uint256 gap = exec > s.markPrice ? exec - s.markPrice : s.markPrice - exec;
            cost += PerpMath.notional(hedgeDelta, gap);
            cost += Math.mulDiv(PerpMath.notional(hedgeDelta, exec), strategy.perpAdapter().takerFeeBps(), BPS);
        }
    }

    /// @dev Carry gained by moving dL from the USDC reserve into the basis trade:
    ///        dL*wethApr + h*dL*fundingApr - dL*(1 + h/lev)*usdcApr   (per year)
    ///      must exceed the execution cost within `carryHorizonSec`.
    function _carryPaysForCost(
        Types.PositionSnapshot memory s,
        Params memory p,
        Ctx memory c,
        Types.RebalancePlan memory plan
    ) internal pure returns (bool) {
        int256 dL = plan.longUsdDelta;
        int256 fundingAprWad = s.fundingRatePer8h * FUNDING_PERIODS_PER_YEAR;
        int256 carryWad = s.wethSupplyRate.toInt256() + fundingAprWad * c.h.toInt256() / BPS_I
            - (s.usdcSupplyRate * (BPS + Math.mulDiv(c.h, BPS, c.lev)) / BPS).toInt256();
        int256 benefit = PerpMath.mulDivSigned(dL * carryWad / WAD_I, p.carryHorizonSec, YEAR);
        return benefit > plan.estimatedCost.toInt256();
    }

    function _sweepOnly(Types.RebalancePlan memory plan) internal pure returns (Types.RebalancePlan memory) {
        plan.longUsdDelta = 0;
        plan.marginDelta = 0;
        plan.estimatedCost = 0;
        plan.triggers &= TRIGGER_IDLE;
        return plan;
    }

    function _leverage(Types.PositionSnapshot memory s) internal pure returns (uint256) {
        if (s.perpSize == 0) return 0;
        if (s.perpEquity == 0) return type(uint256).max;
        return Math.mulDiv(s.shortNotional, BPS, s.perpEquity);
    }

    function _posDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _observe() internal {
        uint256 price = strategy.oracle().getPrice(strategy.weth());
        if (lastObservedPrice != 0 && block.timestamp - lastObservedAt < MIN_OBSERVATION_INTERVAL) return;
        ewmaVarianceWad = _projectedVariance(price);
        lastObservedPrice = price;
        lastObservedAt = uint64(block.timestamp);
        emit VolatilityObserved(price, annualizedVolBps());
    }

    /// @dev EWMA variance *including* the observation that `_observe` would record right now.
    ///      Views use this so `checkUpkeep` sees exactly what `performUpkeep` will act on (otherwise
    ///      the in-perform observation could change the plan and waste a keeper transaction).
    function _projectedVariance(uint256 price) internal view returns (uint256) {
        uint256 last = lastObservedPrice;
        uint256 dt = block.timestamp - lastObservedAt;
        if (last == 0 || price == 0 || dt < MIN_OBSERVATION_INTERVAL) return ewmaVarianceWad;
        uint256 move = price > last ? price - last : last - price;
        uint256 r = Math.mulDiv(move, WAD, last); // simple return, WAD
        uint256 sampleVar = Math.mulDiv(Math.mulDiv(r, r, WAD), YEAR, dt); // annualised r^2
        return Math.mulDiv(ewmaVarianceWad, EWMA_LAMBDA_WAD, WAD) + Math.mulDiv(sampleVar, WAD - EWMA_LAMBDA_WAD, WAD);
    }

    function _currentPriceOrZero() internal view returns (uint256 price) {
        Types.OracleStatus st;
        (price, st) = strategy.oracle().tryGetPrice(strategy.weth());
        if (st != Types.OracleStatus.OK && st != Types.OracleStatus.FALLBACK) price = 0;
    }

    function _setTargets(Targets memory t) internal {
        TargetBounds memory b = _bounds;
        if (
            t.targetLeverageBps < b.minLeverageBps || t.targetLeverageBps > b.maxLeverageBps
                || t.hedgeRatioBps < b.minHedgeRatioBps || t.hedgeRatioBps > b.maxHedgeRatioBps
                || t.reserveBps < b.minReserveBps || t.reserveBps > b.maxReserveBps
                || t.defensiveReserveBps < t.reserveBps || t.defensiveReserveBps > BPS
        ) revert InvalidTargets();
        _targets = t;
        emit TargetsUpdated(t);
    }

    function _setParams(Params memory p) internal {
        if (
            p.deltaBandBps == 0 || p.deltaBandBps > 2000 || p.leverageBandBps == 0 || p.leverageBandBps >= BPS
                || p.allocationBandBps == 0 || p.maxCostBps > 500 || p.volRefBps == 0 || p.carryHorizonSec == 0
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }
}
