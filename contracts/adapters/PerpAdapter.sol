// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPerpAdapter} from "../interfaces/IAdapters.sol";
import {IPerpMarket} from "../interfaces/external/IPerpMarket.sol";
import {PerpMath} from "../libraries/PerpMath.sol";

/// @title PerpAdapter
/// @notice Holds the strategy's hedge account on the perp venue and adds mark-price accounting.
/// @dev The venue measures PnL against execution prices. The adapter additionally tracks the
///      average *mark* at execution, which splits "the hedge moved against us" (price PnL) from
///      "we paid to get filled" (slippage). A production adapter for an async venue (e.g. GMX v2)
///      would add a pending-order state machine here; the strategy-facing interface would not change.
contract PerpAdapter is IPerpAdapter {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IPerpMarket public immutable market;
    address public immutable strategy;
    IERC20 public immutable collateral;

    MarkAccounting internal _acct;

    event MarginDeposited(uint256 amount);
    event MarginWithdrawn(uint256 amount);
    event HedgeTraded(int256 sizeDelta, uint256 execPrice, uint256 markPrice, uint256 fee, int256 slippage);

    error OnlyStrategy();
    error ZeroAddress();

    modifier onlyStrategy() {
        _onlyStrategy();
        _;
    }

    function _onlyStrategy() internal view {
        if (msg.sender != strategy) revert OnlyStrategy();
    }

    constructor(IPerpMarket market_, address strategy_, IERC20 collateral_) {
        if (address(market_) == address(0) || strategy_ == address(0) || address(collateral_) == address(0)) {
            revert ZeroAddress();
        }
        market = market_;
        strategy = strategy_;
        collateral = collateral_;
        collateral_.forceApprove(address(market_), type(uint256).max);
    }

    function depositMargin(uint256 amount) external override onlyStrategy {
        collateral.safeTransferFrom(strategy, address(this), amount);
        market.depositMargin(amount);
        emit MarginDeposited(amount);
    }

    function withdrawMargin(uint256 amount) external override onlyStrategy returns (uint256) {
        market.withdrawMargin(amount);
        collateral.safeTransfer(strategy, amount);
        emit MarginWithdrawn(amount);
        return amount;
    }

    function trade(int256 sizeDelta, uint256 acceptablePrice)
        external
        override
        onlyStrategy
        returns (TradeResult memory r)
    {
        int256 sizeBefore = market.getPosition(address(this)).size;
        r.markPrice = market.markPrice();
        (r.execPrice, r.venueRealizedPnl, r.fee) = market.trade(sizeDelta, acceptablePrice);
        r.sizeDelta = sizeDelta;

        // + = cost: buying above mark or selling below mark
        uint256 gap = r.execPrice > r.markPrice ? r.execPrice - r.markPrice : r.markPrice - r.execPrice;
        int256 mag = PerpMath.notional(sizeDelta, gap).toInt256();
        bool adverse = sizeDelta > 0 ? r.execPrice >= r.markPrice : r.execPrice <= r.markPrice;
        r.slippage = adverse ? mag : -mag;
        _acct.cumulativeSlippage += r.slippage;

        (, uint256 newMarkEntry,) = PerpMath.applyTrade(sizeBefore, _acct.markEntryPrice, sizeDelta, r.markPrice);
        _acct.markEntryPrice = newMarkEntry;

        emit HedgeTraded(sizeDelta, r.execPrice, r.markPrice, r.fee, r.slippage);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function position() external view override returns (IPerpMarket.Position memory) {
        return market.getPosition(address(this));
    }

    function accountStats() external view override returns (IPerpMarket.AccountStats memory) {
        return market.getAccountStats(address(this));
    }

    function markAccounting() external view override returns (MarkAccounting memory a) {
        a = _acct;
        // a venue-side liquidation can flatten us without a trade through the adapter
        if (market.getPosition(address(this)).size == 0) a.markEntryPrice = 0;
    }

    function equity() external view override returns (int256) {
        return market.accountEquity(address(this));
    }

    function unrealizedPnl() external view override returns (int256) {
        return market.unrealizedPnl(address(this));
    }

    function pendingFunding() external view override returns (int256) {
        return market.pendingFunding(address(this));
    }

    function markPrice() external view override returns (uint256) {
        return market.markPrice();
    }

    function fundingRatePer8h() external view override returns (int256) {
        return market.fundingRatePer8h();
    }

    function liquidationPrice() external view override returns (uint256) {
        return market.liquidationPrice(address(this));
    }

    function maintenanceMargin() external view override returns (uint256) {
        return market.maintenanceMargin(address(this));
    }

    function quoteExecutionPrice(int256 sizeDelta) external view override returns (uint256) {
        return market.quoteExecutionPrice(sizeDelta);
    }

    function takerFeeBps() external view override returns (uint256) {
        return market.takerFeeBps();
    }

    function initialMarginBps() external view override returns (uint256) {
        return market.initialMarginBps();
    }

    function maintenanceMarginBps() external view override returns (uint256) {
        return market.maintenanceMarginBps();
    }

    function venue() external view override returns (address) {
        return address(market);
    }
}
