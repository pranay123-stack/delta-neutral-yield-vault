// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPerpMarket} from "./external/IPerpMarket.sol";

/// @notice Strategy-facing lending leg. One adapter per lending venue; it holds the venue position.
/// @dev Funds flow "pull": the adapter `transferFrom`s the strategy inside its own call, so the token
///      movement is atomic with the venue interaction (a reverting venue call moves nothing).
///      Withdrawals always return to the strategy - an adapter can never send funds elsewhere.
interface ILendingAdapter {
    event Supplied(address indexed asset, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount);

    function supply(address asset, uint256 amount) external;

    /// @dev `amount == type(uint256).max` withdraws everything that is currently withdrawable.
    function withdraw(address asset, uint256 amount) external returns (uint256 withdrawn);

    function balanceOf(address asset) external view returns (uint256);

    /// @return Net amount supplied (supplies - withdrawals of principal), for analytics.
    function principalOf(address asset) external view returns (uint256);

    /// @return The venue balance recorded at the last interaction. Reads adapter storage only, so it
    ///         answers even when the venue itself is unreadable; used as a valuation fallback.
    function lastKnownBalance(address asset) external view returns (uint256);

    /// @return Interest materialised up to the last interaction (storage only, same fallback role).
    function checkpointedInterest(address asset) external view returns (uint256);

    /// @return Lifetime interest earned, including interest accrued since the last interaction.
    function cumulativeInterest(address asset) external view returns (uint256);

    /// @return min(balance, venue available liquidity) - what can be pulled out right now.
    function withdrawable(address asset) external view returns (uint256);

    function supplyRate(address asset) external view returns (uint256);

    function utilization(address asset) external view returns (uint256);

    function venue() external view returns (address);
}

/// @notice Strategy-facing hedge leg. Holds the perp account on the venue.
interface IPerpAdapter {
    /// @dev Adapter-side accounting that measures trading PnL against the venue *mark* at execution,
    ///      so execution cost (slippage) is attributed separately from price PnL. Realised PnL at
    ///      mark is derived as a residual (venue total + slippage - unrealised at mark), which stays
    ///      correct even when the venue changes the position without the adapter (ADL, liquidation).
    struct MarkAccounting {
        uint256 markEntryPrice; // average mark price at execution for the open position (price18)
        int256 cumulativeSlippage; // usd6, + = cost
    }

    struct TradeResult {
        int256 sizeDelta;
        uint256 execPrice;
        uint256 markPrice;
        uint256 fee;
        int256 slippage; // usd6, + = cost
        int256 venueRealizedPnl; // usd6, vs execution prices
    }

    function depositMargin(uint256 amount) external;

    function withdrawMargin(uint256 amount) external returns (uint256);

    function trade(int256 sizeDelta, uint256 acceptablePrice) external returns (TradeResult memory);

    function position() external view returns (IPerpMarket.Position memory);

    function accountStats() external view returns (IPerpMarket.AccountStats memory);

    function markAccounting() external view returns (MarkAccounting memory);

    function equity() external view returns (int256);

    function unrealizedPnl() external view returns (int256);

    function pendingFunding() external view returns (int256);

    function markPrice() external view returns (uint256);

    function fundingRatePer8h() external view returns (int256);

    function liquidationPrice() external view returns (uint256);

    function maintenanceMargin() external view returns (uint256);

    function quoteExecutionPrice(int256 sizeDelta) external view returns (uint256);

    function takerFeeBps() external view returns (uint256);

    function initialMarginBps() external view returns (uint256);

    function maintenanceMarginBps() external view returns (uint256);

    function venue() external view returns (address);
}

/// @notice Strategy-facing spot swap leg.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut, uint256 fee);

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 fee);

    function feeBps() external view returns (uint256);

    function venue() external view returns (address);
}
