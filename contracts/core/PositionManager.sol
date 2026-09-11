// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ILendingAdapter, IPerpAdapter} from "../interfaces/IAdapters.sol";
import {IPositionManager} from "../interfaces/IPositionManager.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {IPerpMarket} from "../interfaces/external/IPerpMarket.sol";
import {DeltaCalculator} from "../libraries/DeltaCalculator.sol";
import {GasGuard} from "../libraries/GasGuard.sol";
import {PerpMath} from "../libraries/PerpMath.sol";
import {Types} from "../libraries/Types.sol";

/// @title PositionManager
/// @notice Read-only aggregation of every position into a single snapshot plus the derived delta,
///         liquidation and PnL reports. Used by the risk engine, the rebalancer, the backend and UI.
/// @dev Never reverts on a broken venue feed: perp reads are wrapped and fall back to local maths at
///      the oracle's last good price, so monitoring keeps working exactly when it matters most.
contract PositionManager is IPositionManager {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;

    IStrategyManager public immutable strategy;
    address public immutable vault;
    IERC20 internal immutable _usdc;
    address internal immutable _weth;

    constructor(IStrategyManager strategy_, address vault_) {
        strategy = strategy_;
        vault = vault_;
        _usdc = IERC20(strategy_.asset());
        _weth = strategy_.weth();
    }

    function snapshot() public view override returns (Types.PositionSnapshot memory s) {
        ILendingAdapter lending = strategy.lendingAdapter();
        IPerpAdapter perp = strategy.perpAdapter();

        (s.price, s.priceHealthy) = strategy.oracle().getPriceOrLastGood(_weth);
        s.vaultIdle = _usdc.balanceOf(vault);
        s.strategyFloat = _usdc.balanceOf(address(strategy));
        s.reserveAssets = lending.balanceOf(address(_usdc));
        s.longQty = lending.balanceOf(_weth) + IERC20(_weth).balanceOf(address(strategy));
        s.longValue = Math.mulDiv(s.longQty, s.price, PerpMath.QTY_PRICE_TO_USD6);
        s.usdcSupplyRate = lending.supplyRate(address(_usdc));
        s.wethSupplyRate = lending.supplyRate(_weth);

        IPerpMarket.Position memory p = perp.position();
        s.perpSize = p.size;
        s.perpMargin = p.margin;
        s.fundingRatePer8h = perp.fundingRatePer8h();
        _fillPerp(s, perp, p);

        s.strategyNav = s.strategyFloat + s.reserveAssets + s.longValue + s.perpEquity;
        s.totalNav = s.strategyNav + s.vaultIdle;
    }

    function deltaReport(uint256 hedgeRatioBps) external view override returns (Types.DeltaReport memory) {
        return DeltaCalculator.compute(snapshot(), hedgeRatioBps);
    }

    function liquidationReport(uint256 minDistanceBps)
        external
        view
        override
        returns (Types.LiquidationReport memory r)
    {
        Types.PositionSnapshot memory s = snapshot();
        r.markPrice = s.markPrice;
        r.liquidationPrice = s.liquidationPrice;
        r.distanceBps = PerpMath.distanceBps(s.markPrice, s.liquidationPrice, s.perpSize);
        r.leverageBps = leverageBps(s);
        r.collateralRatioBps =
            s.maintenanceMargin == 0 ? type(uint256).max : Math.mulDiv(s.perpEquity, BPS, s.maintenanceMargin);
        r.safetyBufferBps = r.distanceBps > minDistanceBps ? r.distanceBps - minDistanceBps : 0;
    }

    /// @inheritdoc IPositionManager
    function pnl() external view override returns (Types.PnLBreakdown memory b) {
        Types.PositionSnapshot memory s = snapshot();
        IStrategyManager.Accounting memory a = strategy.accounting();
        _incomeAndSpot(b, s, a);
        _perpAndCosts(b, s, a);
        b.netPnl = _net(b);
        b.netCapital = a.netCapital;
        b.strategyNav = s.strategyNav;
    }

    function _incomeAndSpot(
        Types.PnLBreakdown memory b,
        Types.PositionSnapshot memory s,
        IStrategyManager.Accounting memory a
    ) internal view {
        ILendingAdapter lending = strategy.lendingAdapter();
        b.lendingIncomeUsdc = lending.cumulativeInterest(address(_usdc)).toInt256();
        b.lendingIncomeWeth =
            Math.mulDiv(lending.cumulativeInterest(_weth), s.price, PerpMath.QTY_PRICE_TO_USD6).toInt256();
        // spot leg (vs oracle mid); WETH interest is carved out, unrealised is the residual
        b.spotRealizedPnl = a.spotRealizedPnl;
        b.spotUnrealizedPnl = s.longValue.toInt256() - a.spotCostBasis.toInt256() - b.lendingIncomeWeth;
    }

    function _perpAndCosts(
        Types.PnLBreakdown memory b,
        Types.PositionSnapshot memory s,
        IStrategyManager.Accounting memory a
    ) internal view {
        IPerpAdapter perp = strategy.perpAdapter();
        IPerpMarket.AccountStats memory st = perp.accountStats();
        IPerpAdapter.MarkAccounting memory ma = perp.markAccounting();

        b.fundingIncome = st.fundingPnl + s.perpPendingFunding;
        // perp leg (vs mark at execution); realised is the residual so venue-side ADL/liquidation is covered
        b.perpUnrealizedPnl = PerpMath.pnl(s.perpSize, ma.markEntryPrice, s.markPrice);
        b.perpRealizedPnl = st.realizedPnl + s.perpUnrealizedPnl + ma.cumulativeSlippage - b.perpUnrealizedPnl;

        b.tradingFees = (a.swapFees + st.feesPaid + st.liquidationPenalties).toInt256();
        b.slippage = a.swapSlippage + ma.cumulativeSlippage;

        // losses beyond margin that the venue ate (written off) or would eat (negative equity, floored in NAV)
        int256 rawEquity = _rawEquity(perp, s);
        b.badDebtAbsorbed = st.badDebt.toInt256() + (rawEquity < 0 ? -rawEquity : int256(0));
    }

    function _net(Types.PnLBreakdown memory b) internal pure returns (int256) {
        int256 income = b.lendingIncomeUsdc + b.lendingIncomeWeth + b.fundingIncome;
        int256 trading = b.spotRealizedPnl + b.spotUnrealizedPnl + b.perpRealizedPnl + b.perpUnrealizedPnl;
        return income + trading - b.tradingFees - b.slippage + b.badDebtAbsorbed;
    }

    /// @return notional / equity in bps; max when a position exists with no equity, 0 when flat
    function leverageBps(Types.PositionSnapshot memory s) public pure returns (uint256) {
        if (s.perpSize == 0) return 0;
        if (s.perpEquity == 0) return type(uint256).max;
        return Math.mulDiv(s.shortNotional, BPS, s.perpEquity);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _fillPerp(Types.PositionSnapshot memory s, IPerpAdapter perp, IPerpMarket.Position memory p)
        internal
        view
    {
        // every fallback below is only taken for a *genuine* venue failure, never for a starved call
        uint256 g = gasleft();
        try perp.markPrice() returns (uint256 m) {
            s.markPrice = m;
        } catch {
            GasGuard.checkNotStarved(g);
            s.markPrice = s.price;
        }
        s.shortNotional = PerpMath.notional(p.size, s.markPrice);
        s.perpUnrealizedPnl = PerpMath.pnl(p.size, p.entryPrice, s.markPrice);
        g = gasleft();
        try perp.pendingFunding() returns (int256 f) {
            s.perpPendingFunding = f;
        } catch {
            GasGuard.checkNotStarved(g);
        }
        int256 eq = _rawEquity(perp, s);
        s.perpEquity = eq > 0 ? eq.toUint256() : 0;
        g = gasleft();
        try perp.liquidationPrice() returns (uint256 lp) {
            s.liquidationPrice = lp;
        } catch {
            GasGuard.checkNotStarved(g);
            s.liquidationPrice = PerpMath.liquidationPrice(
                p.size, p.entryPrice, p.margin.toInt256() + s.perpPendingFunding, perp.maintenanceMarginBps()
            );
        }
        s.maintenanceMargin = Math.mulDiv(s.shortNotional, perp.maintenanceMarginBps(), BPS, Math.Rounding.Ceil);
    }

    function _rawEquity(IPerpAdapter perp, Types.PositionSnapshot memory s) internal view returns (int256) {
        uint256 g = gasleft();
        try perp.equity() returns (int256 e) {
            return e;
        } catch {
            GasGuard.checkNotStarved(g);
            return s.perpMargin.toInt256() + s.perpUnrealizedPnl + s.perpPendingFunding;
        }
    }
}
