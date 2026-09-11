// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {ILendingAdapter, IPerpAdapter, ISwapAdapter} from "../interfaces/IAdapters.sol";
import {IEmergencyController} from "../interfaces/IEmergencyController.sol";
import {IOracleManager} from "../interfaces/IOracleManager.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {IPerpMarket} from "../interfaces/external/IPerpMarket.sol";
import {GasGuard} from "../libraries/GasGuard.sol";
import {PerpMath} from "../libraries/PerpMath.sol";
import {Types} from "../libraries/Types.sol";

/// @title StrategyManager
/// @notice Owns the delta-neutral basis position and executes every movement of strategy capital.
/// @dev Capital layout (all targets are set by RebalanceManager, not here):
///        - USDC reserve  : supplied to the lending market. Liquidity buffer + defensive allocation.
///        - Long leg      : WETH bought on the spot venue and supplied to the lending market.
///        - Hedge leg     : USDC margin on the perp venue backing a short of ~equal ETH size.
///      This contract is deliberately a *dumb executor*: it decides nothing about targets, it only
///      executes plans with oracle-bounded slippage and keeps the accounting needed for PnL
///      attribution. Every path out of this contract ends in the vault; there is no function that
///      can send funds to an arbitrary address.
contract StrategyManager is IStrategyManager, Auth, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q = PerpMath.QTY_PRICE_TO_USD6; // qty18 * price18 / Q = usd6
    /// @dev Hedge adjustments below 0.001 ETH (~$3) are skipped: pure gas/fee waste.
    uint256 public constant MIN_HEDGE_TRADE_QTY = 1e15;
    /// @dev Hard ceiling on any slippage bound the rebalancer can request.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    IERC20 internal immutable _usdc;
    address public immutable override weth;
    address public immutable override vault;
    IOracleManager public immutable override oracle;
    IEmergencyController public immutable emergency;

    ILendingAdapter public override lendingAdapter;
    IPerpAdapter public override perpAdapter;
    ISwapAdapter public override swapAdapter;
    address public rebalanceManager;
    IRiskManager public riskManager;

    Accounting internal _acct;

    event Initialized(
        address indexed lending,
        address indexed perp,
        address indexed swap,
        address rebalanceManager,
        address riskManager
    );
    event EmergencyStepFailed(uint8 step, bytes reason);
    event PnlCrystallized(uint256 qty, uint256 profitRealized);

    error OnlyVault();
    error OnlyRebalancer();
    error OnlyEmergency();
    error AlreadyInitialized();
    error AdapterMismatch();
    error InsufficientReserve(uint256 needed, uint256 available);
    error StrategyIsPaused();
    error SlippageTooHigh(uint256 requested);

    modifier onlyVault() {
        _onlyVault();
        _;
    }

    function _onlyVault() internal view {
        if (msg.sender != vault) revert OnlyVault();
    }

    constructor(
        IAccessRegistry registry_,
        address vault_,
        IERC20 usdc_,
        address weth_,
        IOracleManager oracle_,
        IEmergencyController emergency_
    ) Auth(registry_) {
        if (
            vault_ == address(0) || address(usdc_) == address(0) || weth_ == address(0)
                || address(oracle_) == address(0) || address(emergency_) == address(0)
        ) revert ZeroAddress();
        vault = vault_;
        _usdc = usdc_;
        weth = weth_;
        oracle = oracle_;
        emergency = emergency_;
    }

    /// @notice One-time wiring. Adapters are deployed after this contract because they bind to it.
    function initialize(
        ILendingAdapter lending_,
        IPerpAdapter perp_,
        ISwapAdapter swap_,
        address rebalanceManager_,
        IRiskManager riskManager_
    ) external onlyRole(Roles.ADMIN) {
        if (address(lendingAdapter) != address(0)) revert AlreadyInitialized();
        if (
            address(lending_) == address(0) || address(perp_) == address(0) || address(swap_) == address(0)
                || rebalanceManager_ == address(0) || address(riskManager_) == address(0)
        ) revert ZeroAddress();
        // adapters must be bound to *this* strategy, otherwise funds pushed to them are unrecoverable
        if (
            _adapterStrategy(address(lending_)) != address(this) || _adapterStrategy(address(perp_)) != address(this)
                || _adapterStrategy(address(swap_)) != address(this)
        ) revert AdapterMismatch();
        lendingAdapter = lending_;
        perpAdapter = perp_;
        swapAdapter = swap_;
        // Adapters pull what they need inside their own call (atomic with the venue interaction).
        // They are immutable and bound to this strategy; float is ~0 between operations.
        _usdc.forceApprove(address(lending_), type(uint256).max);
        _usdc.forceApprove(address(perp_), type(uint256).max);
        _usdc.forceApprove(address(swap_), type(uint256).max);
        IERC20(weth).forceApprove(address(lending_), type(uint256).max);
        IERC20(weth).forceApprove(address(swap_), type(uint256).max);
        rebalanceManager = rebalanceManager_;
        riskManager = riskManager_;
        emit Initialized(address(lending_), address(perp_), address(swap_), rebalanceManager_, address(riskManager_));
    }

    // ------------------------------------------------------------------
    // Valuation
    // ------------------------------------------------------------------

    function asset() external view override returns (address) {
        return address(_usdc);
    }

    /// @inheritdoc IStrategyManager
    function totalAssets() external view override returns (uint256 nav) {
        (nav,,) = valuation();
    }

    /// @inheritdoc IStrategyManager
    function valuation() public view override returns (uint256 nav, bool priceDependent, bool priceHealthy) {
        uint256 price;
        (price, priceHealthy) = oracle.getPriceOrLastGood(weth);
        uint256 wethQty = _wethHeld();
        uint256 perpEq = _perpEquity(price);
        priceDependent = wethQty > 0 || perpAdapter.position().size != 0; // cash margin alone needs no price
        nav = _usdc.balanceOf(address(this)) + _lendingBalance(address(_usdc)) + Math.mulDiv(wethQty, price, Q) + perpEq;
    }

    function isPriceDependent() external view override returns (bool) {
        return _wethHeld() > 0 || perpAdapter.position().size != 0;
    }

    function availableLiquidity() external view override returns (uint256) {
        uint256 g = gasleft();
        try lendingAdapter.withdrawable(address(_usdc)) returns (uint256 w) {
            return _usdc.balanceOf(address(this)) + w;
        } catch {
            GasGuard.checkNotStarved(g);
            // An unreadable venue is treated as illiquid: `maxWithdraw` shrinks to the float, so nobody
            // is quoted liquidity the vault may not be able to deliver.
            return _usdc.balanceOf(address(this));
        }
    }

    function accounting() external view override returns (Accounting memory) {
        return _acct;
    }

    // ------------------------------------------------------------------
    // Vault flows
    // ------------------------------------------------------------------

    function onCapitalReceived(uint256 amount) external override onlyVault nonReentrant {
        _acct.netCapital += amount.toInt256();
        _parkFloat();
        emit CapitalReceived(amount);
    }

    function withdrawLiquid(uint256 amount) external override onlyVault nonReentrant returns (uint256 withdrawn) {
        uint256 float_ = _usdc.balanceOf(address(this));
        if (float_ < amount) {
            uint256 fromReserve = Math.min(amount - float_, lendingAdapter.withdrawable(address(_usdc)));
            if (fromReserve > 0) lendingAdapter.withdraw(address(_usdc), fromReserve);
        }
        withdrawn = Math.min(amount, _usdc.balanceOf(address(this)));
        _returnToVault(withdrawn);
    }

    /// @inheritdoc IStrategyManager
    /// @dev Unwinds fraction f = amount / (longValue + perpEquity) of *both* legs and of the margin,
    ///      so delta and leverage are unchanged for remaining depositors. Whatever the unwind costs in
    ///      fees and slippage is simply not delivered - the exiting user bears it.
    function unwindFor(uint256 amount) external override onlyVault nonReentrant returns (uint256 delivered) {
        if (emergency.strategyPaused()) revert StrategyIsPaused();
        uint256 price = oracle.getPrice(weth);
        uint256 slip = riskManager.maxSlippageBps();

        uint256 wethQty = _wethHeld();
        uint256 perpEq = _perpEquity(price);
        uint256 basis = Math.mulDiv(wethQty, price, Q) + perpEq;
        if (basis == 0 || amount == 0) return 0;
        uint256 f = Math.min(Math.mulDiv(amount, WAD, basis), WAD);

        // 1. buy back the same fraction of the short
        int256 size = perpAdapter.position().size;
        if (size < 0) {
            uint256 q = Math.mulDiv(PerpMath.abs(size), f, WAD);
            if (f == WAD) q = PerpMath.abs(size);
            if (q >= MIN_HEDGE_TRADE_QTY || f == WAD) _perpTrade(q.toInt256(), price, slip);
        }
        // 2. sell the same fraction of the long
        uint256 sellQty = f == WAD ? wethQty : Math.mulDiv(wethQty, f, WAD);
        if (sellQty > 0) _sellWeth(sellQty, price, slip);
        // 3. release perp equity so that exactly (1 - f) of the *pre-exit* equity stays behind: the
        //    hedge-close fee and slippage were taken out of equity, so they come out of this release
        //    (paid by the exiting user) rather than out of the remaining holders' share.
        IPerpMarket.Position memory p = perpAdapter.position();
        uint256 release;
        if (p.size == 0) {
            release = p.margin;
        } else {
            uint256 keep = Math.mulDiv(perpEq, WAD - f, WAD, Math.Rounding.Ceil);
            int256 eqNow = perpAdapter.equity();
            release = eqNow > keep.toInt256() ? Math.min((eqNow - keep.toInt256()).toUint256(), p.margin) : 0;
        }
        if (release > 0) perpAdapter.withdrawMargin(release);

        uint256 float_ = _usdc.balanceOf(address(this));
        delivered = Math.min(float_, amount);
        _returnToVault(delivered);
        _parkFloat(); // any price improvement beyond `amount` stays with remaining depositors
        emit Unwound(amount, delivered, f);
    }

    // ------------------------------------------------------------------
    // Rebalancing
    // ------------------------------------------------------------------

    function executeRebalance(Types.RebalancePlan calldata plan)
        external
        override
        nonReentrant
        returns (Types.ExecutionResult memory res)
    {
        if (msg.sender != rebalanceManager) revert OnlyRebalancer();
        if (emergency.strategyPaused()) revert StrategyIsPaused();
        if (plan.maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(plan.maxSlippageBps);
        uint256 price = oracle.getPrice(weth);

        // Ordering: raise cash first (sells, excess margin), then spend it (margin, buys), then hedge.
        // 1. shrink the long leg -> USDC float
        if (plan.longUsdDelta < 0) {
            uint256 qty = Math.min(Math.mulDiv((-plan.longUsdDelta).toUint256(), Q, price), _wethHeld());
            if (qty > 0) {
                (uint256 fee, int256 slip) = _sellWeth(qty, price, plan.maxSlippageBps);
                res.tradingFees += fee;
                res.slippage += _pos(slip);
            }
        }

        // 2. margin: deposit before any hedge increase (venue IMR check); withdraw what is free now
        uint256 marginOut = plan.marginDelta < 0 ? (-plan.marginDelta).toUint256() : 0;
        if (plan.marginDelta > 0) {
            uint256 m = plan.marginDelta.toUint256();
            _pullFromReserve(m);
            perpAdapter.depositMargin(m);
        } else if (marginOut > 0) {
            marginOut -= _withdrawFreeMargin(marginOut, price, plan.maxSlippageBps, res);
        }

        // 3. grow the long leg
        if (plan.longUsdDelta > 0) {
            uint256 x = plan.longUsdDelta.toUint256();
            _pullFromReserve(x);
            (uint256 fee, int256 slip) = _buyWeth(x, price, plan.maxSlippageBps);
            res.tradingFees += fee;
            res.slippage += _pos(slip);
        }

        // 4. re-hedge to exactly -hedgeRatio x actual long quantity (post-swap, so fills are matched)
        int256 target = -Math.mulDiv(_wethHeld(), plan.hedgeRatioBps, BPS).toInt256();
        int256 diff = target - perpAdapter.position().size;
        if (PerpMath.abs(diff) >= MIN_HEDGE_TRADE_QTY) {
            IPerpAdapter.TradeResult memory t = _perpTrade(diff, price, plan.maxSlippageBps);
            res.perpSizeChange = diff;
            res.tradingFees += t.fee;
            res.slippage += _pos(t.slippage);
        }

        // 5. any margin that only became free after the hedge reduction
        if (marginOut > 0) _withdrawFreeMargin(marginOut, price, plan.maxSlippageBps, res);

        // 6. everything left over earns in the reserve
        _parkFloat();
        emit RebalanceExecuted(plan.longUsdDelta, plan.marginDelta, res.perpSizeChange, res.tradingFees, res.slippage);
    }

    // ------------------------------------------------------------------
    // Emergency
    // ------------------------------------------------------------------

    /// @inheritdoc IStrategyManager
    /// @dev Best-effort: each step is isolated with try/catch so one broken venue cannot trap the
    ///      funds sitting in the others. Failures are emitted and the guardian can call again.
    function emergencyUnwind(uint256 minSellPrice, uint256 maxBuyPrice)
        external
        override
        nonReentrant
        returns (uint256 returned)
    {
        if (msg.sender != address(emergency)) revert OnlyEmergency();
        (uint256 refPrice,) = oracle.getPriceOrLastGood(weth);

        // A step is only skipped when its venue genuinely fails; an under-gassed call reverts the whole
        // unwind (GasGuard) so the guardian retries with more gas instead of silently leaving legs open.
        // 1. close the hedge
        int256 size = perpAdapter.position().size;
        uint256 g;
        if (size != 0) {
            uint256 bound = size < 0 ? maxBuyPrice : minSellPrice;
            g = gasleft();
            try perpAdapter.trade(-size, bound) {}
            catch (bytes memory reason) {
                GasGuard.checkNotStarved(g);
                emit EmergencyStepFailed(1, reason);
            }
        }
        // 2. withdraw all margin (only possible once flat, or up to the IMR-free amount)
        uint256 margin = perpAdapter.position().margin;
        if (margin > 0 && perpAdapter.position().size == 0) {
            g = gasleft();
            try perpAdapter.withdrawMargin(margin) {}
            catch (bytes memory reason) {
                GasGuard.checkNotStarved(g);
                emit EmergencyStepFailed(2, reason);
            }
        }
        // 3. pull and sell the long leg
        g = gasleft();
        try lendingAdapter.withdraw(weth, type(uint256).max) {}
        catch (bytes memory reason) {
            GasGuard.checkNotStarved(g);
            emit EmergencyStepFailed(3, reason);
        }
        uint256 wethBal = IERC20(weth).balanceOf(address(this));
        if (wethBal > 0) {
            uint256 heldBefore = _wethHeld();
            uint256 minOut = Math.mulDiv(wethBal, minSellPrice, Q);
            // the adapter pulls inside the call, so a failed swap leaves the WETH here, not stranded
            g = gasleft();
            try swapAdapter.swap(weth, address(_usdc), wethBal, minOut) returns (uint256 out, uint256 feeWeth) {
                _recordSale(heldBefore, wethBal, out, feeWeth, refPrice);
            } catch (bytes memory reason) {
                GasGuard.checkNotStarved(g);
                emit EmergencyStepFailed(4, reason);
            }
        }
        // 4. pull the USDC reserve (bounded by lending liquidity; the rest can be pulled on a later call)
        g = gasleft();
        try lendingAdapter.withdraw(address(_usdc), type(uint256).max) {}
        catch (bytes memory reason) {
            GasGuard.checkNotStarved(g);
            emit EmergencyStepFailed(5, reason);
        }
        returned = _usdc.balanceOf(address(this));
        _returnToVault(returned);
        emit EmergencyUnwound(returned);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _wethHeld() internal view returns (uint256) {
        return _lendingBalance(weth) + IERC20(weth).balanceOf(address(this));
    }

    /// @dev Venue balance, or the adapter's last checkpointed balance if the venue view reverts (a
    ///      paused/removed reserve, a bad upgrade). ERC-4626 requires `totalAssets` never to revert, and
    ///      the hedge leg already has this treatment (`_perpEquity`) - the lending leg needs it too.
    ///      The fallback understates by the interest accrued since the last interaction, which is the
    ///      conservative direction, and a starved call still reverts rather than being priced stale.
    function _lendingBalance(address token) internal view returns (uint256) {
        uint256 g = gasleft();
        try lendingAdapter.balanceOf(token) returns (uint256 b) {
            return b;
        } catch {
            GasGuard.checkNotStarved(g);
            return lendingAdapter.lastKnownBalance(token);
        }
    }

    /// @dev Perp equity floored at zero (isolated margin: losses beyond margin are the venue's).
    ///      Falls back to margin + uPnL at `price` if the venue cannot be read (e.g. its feed is down),
    ///      so that `totalAssets()` never reverts.
    function _perpEquity(uint256 price) internal view returns (uint256) {
        uint256 g = gasleft();
        try perpAdapter.equity() returns (int256 e) {
            return e > 0 ? e.toUint256() : 0;
        } catch {
            GasGuard.checkNotStarved(g); // a starved read must not be priced with the fallback formula
            IPerpMarket.Position memory p = perpAdapter.position();
            int256 e = p.margin.toInt256() + PerpMath.pnl(p.size, p.entryPrice, price);
            return e > 0 ? e.toUint256() : 0;
        }
    }

    /// @dev Withdraws up to `wanted` margin without breaching the venue's initial-margin requirement
    ///      (a 1% haircut on the free amount absorbs mark/funding drift within the block).
    function _withdrawFreeMargin(uint256 wanted, uint256 price, uint256 slip, Types.ExecutionResult memory res)
        internal
        returns (uint256 withdrawn)
    {
        (uint256 free, uint256 excess) = _freeMargin();
        // Excess equity that is not cash is unrealised profit on the short: realise just enough of it.
        if (free < wanted && excess > free) _crystallizePnl(Math.min(wanted, excess) - free, price, slip, res);
        (free,) = _freeMargin();
        withdrawn = Math.min(wanted, free);
        if (withdrawn > 0) perpAdapter.withdrawMargin(withdrawn);
    }

    /// @return free cash margin withdrawable without breaching IMR (1% haircut for in-block drift)
    /// @return excess equity above IMR, whether it is cash or unrealised PnL
    function _freeMargin() internal view returns (uint256 free, uint256 excess) {
        IPerpMarket.Position memory p = perpAdapter.position();
        if (p.size == 0) return (p.margin, p.margin);
        int256 eq = perpAdapter.equity();
        uint256 imr = Math.mulDiv(
            PerpMath.notional(p.size, perpAdapter.markPrice()), perpAdapter.initialMarginBps(), BPS, Math.Rounding.Ceil
        );
        excess = eq > imr.toInt256() ? Math.mulDiv((eq - imr.toInt256()).toUint256(), 99, 100) : 0;
        free = Math.min(p.margin, excess);
    }

    /// @dev Venues pay out *cash* margin only; profit on an open short stays unrealised until part of it
    ///      is closed. After a large ETH decline nearly all perp equity can be unrealised profit, and a
    ///      margin withdrawal would silently do nothing - the rebalancer would then re-fire every
    ///      interval without effect. Closing and immediately reopening the slice q = size * needed/uPnL
    ///      moves exactly that profit into cash margin, at the cost of two taker fees on the slice.
    function _crystallizePnl(uint256 needed, uint256 price, uint256 slip, Types.ExecutionResult memory res) internal {
        int256 size = perpAdapter.position().size;
        int256 upnl = perpAdapter.unrealizedPnl();
        if (size == 0 || upnl <= 0) return;
        uint256 u = upnl.toUint256();
        uint256 target = Math.min(Math.mulDiv(needed, 102, 100), u); // 2% over to cover the two fees
        uint256 q = Math.mulDiv(PerpMath.abs(size), target, u, Math.Rounding.Ceil);
        if (q < MIN_HEDGE_TRADE_QTY) return;
        int256 close = size < 0 ? q.toInt256() : -q.toInt256();
        IPerpAdapter.TradeResult memory a = _perpTrade(close, price, slip);
        IPerpAdapter.TradeResult memory b = _perpTrade(-close, price, slip);
        res.tradingFees += a.fee + b.fee;
        res.slippage += _pos(a.slippage) + _pos(b.slippage);
        emit PnlCrystallized(q, target);
    }

    function _pullFromReserve(uint256 amount) internal {
        uint256 float_ = _usdc.balanceOf(address(this));
        if (float_ >= amount) return;
        uint256 need = amount - float_;
        uint256 available = lendingAdapter.withdrawable(address(_usdc));
        if (available < need) revert InsufficientReserve(need, available);
        lendingAdapter.withdraw(address(_usdc), need);
    }

    function _parkFloat() internal {
        uint256 float_ = _usdc.balanceOf(address(this));
        if (float_ == 0) return;
        lendingAdapter.supply(address(_usdc), float_);
    }

    function _returnToVault(uint256 amount) internal {
        if (amount == 0) return;
        _acct.netCapital -= amount.toInt256();
        _usdc.safeTransfer(vault, amount);
        emit CapitalReturned(amount);
    }

    /// @dev Buys WETH with exactly `usdcIn`, supplies it, and books cost basis at the oracle mid.
    function _buyWeth(uint256 usdcIn, uint256 price, uint256 slip) internal returns (uint256 fee, int256 slippage) {
        uint256 expectedQty = Math.mulDiv(usdcIn, Q, price);
        uint256 minOut = Math.mulDiv(expectedQty, BPS - slip, BPS);
        uint256 qty;
        (qty, fee) = swapAdapter.swap(address(_usdc), weth, usdcIn, minOut);

        uint256 midValue = Math.mulDiv(qty, price, Q);
        // total execution cost vs oracle = usdcIn - midValue, of which `fee` is the LP fee
        slippage = usdcIn.toInt256() - midValue.toInt256() - fee.toInt256();
        _acct.spotCostBasis += midValue;
        _acct.swapFees += fee;
        _acct.swapSlippage += slippage;

        lendingAdapter.supply(weth, qty);
        emit SpotTrade(true, usdcIn, qty, price, fee, slippage);
    }

    /// @dev Withdraws `qty` WETH from lending (if needed), sells it, and realises spot PnL pro-rata.
    function _sellWeth(uint256 qty, uint256 price, uint256 slip) internal returns (uint256 feeUsd, int256 slippage) {
        uint256 held = _wethHeld();
        uint256 floatWeth = IERC20(weth).balanceOf(address(this));
        if (floatWeth < qty) lendingAdapter.withdraw(weth, qty - floatWeth);
        uint256 expectedOut = Math.mulDiv(qty, price, Q);
        uint256 minOut = Math.mulDiv(expectedOut, BPS - slip, BPS);
        (uint256 out, uint256 feeWeth) = swapAdapter.swap(weth, address(_usdc), qty, minOut);
        (feeUsd, slippage) = _recordSale(held, qty, out, feeWeth, price);
    }

    function _recordSale(uint256 heldBefore, uint256 qty, uint256 out, uint256 feeWeth, uint256 price)
        internal
        returns (uint256 feeUsd, int256 slippage)
    {
        uint256 midValue = Math.mulDiv(qty, price, Q);
        feeUsd = Math.mulDiv(feeWeth, price, Q);
        slippage = midValue.toInt256() - out.toInt256() - feeUsd.toInt256();
        // cost basis is spread over *all* WETH held, including interest-earned WETH (zero cost)
        uint256 basisPortion = heldBefore == 0 ? 0 : Math.mulDiv(_acct.spotCostBasis, qty, heldBefore);
        if (basisPortion > _acct.spotCostBasis) basisPortion = _acct.spotCostBasis;
        _acct.spotCostBasis -= basisPortion;
        _acct.spotRealizedPnl += midValue.toInt256() - basisPortion.toInt256();
        _acct.swapFees += feeUsd;
        _acct.swapSlippage += slippage;
        emit SpotTrade(false, out, qty, price, feeUsd, slippage);
    }

    function _perpTrade(int256 sizeDelta, uint256 price, uint256 slip)
        internal
        returns (IPerpAdapter.TradeResult memory)
    {
        uint256 bound = sizeDelta > 0 ? Math.mulDiv(price, BPS + slip, BPS) : Math.mulDiv(price, BPS - slip, BPS);
        return perpAdapter.trade(sizeDelta, bound);
    }

    function _pos(int256 x) internal pure returns (uint256) {
        return x > 0 ? x.toUint256() : 0;
    }

    function _adapterStrategy(address adapter) internal view returns (address s) {
        (bool ok, bytes memory data) = adapter.staticcall(abi.encodeWithSignature("strategy()"));
        if (ok && data.length == 32) s = abi.decode(data, (address));
    }
}
