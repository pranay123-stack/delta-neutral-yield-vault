// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Isolated-margin, single-market (ETH-USD) perpetual venue with synchronous execution.
/// @dev Deliberately venue-agnostic: size is signed ETH (18d), prices are USD (18d), collateral is USDC (6d).
///      Real venues differ (GMX v2 executes orders asynchronously via keepers, Hyperliquid/dYdX are
///      off-chain order books); PerpAdapter is the seam where that difference would be absorbed.
interface IPerpMarket {
    struct Position {
        int256 size; // + long, - short (qty18)
        uint256 entryPrice; // average execution price (price18)
        uint256 margin; // posted collateral incl. settled PnL / funding / fees (usd6)
        int256 lastFundingIndex; // cumulative funding index at last settlement
    }

    /// @notice Lifetime per-account statistics maintained by the venue.
    struct AccountStats {
        int256 realizedPnl; // trading PnL settled into margin (usd6), vs execution prices
        int256 fundingPnl; // funding settled into margin (usd6), + = received
        uint256 feesPaid; // taker fees (usd6)
        uint256 liquidationPenalties; // (usd6)
        uint256 badDebt; // loss beyond margin absorbed by the insurance pool (usd6)
    }

    event MarginDeposited(address indexed account, uint256 amount);
    event MarginWithdrawn(address indexed account, uint256 amount);
    event Trade(
        address indexed account, int256 sizeDelta, uint256 execPrice, uint256 markPrice, int256 realizedPnl, uint256 fee
    );
    event FundingSettled(address indexed account, int256 fundingPnl, int256 fundingIndex);
    event Liquidated(
        address indexed account,
        address indexed liquidator,
        int256 size,
        uint256 markPrice,
        uint256 penalty,
        uint256 badDebt
    );
    event FundingRateUpdated(int256 ratePer8h);

    function depositMargin(uint256 amount) external;

    function withdrawMargin(uint256 amount) external;

    /// @param sizeDelta signed change in position (qty18)
    /// @param acceptablePrice worst execution price: max for buys, min for sells
    function trade(int256 sizeDelta, uint256 acceptablePrice)
        external
        returns (uint256 execPrice, int256 realizedPnl, uint256 fee);

    function liquidate(address account) external;

    function getPosition(address account) external view returns (Position memory);

    function getAccountStats(address account) external view returns (AccountStats memory);

    function markPrice() external view returns (uint256);

    /// @return WAD per 8 hours; positive means longs pay shorts.
    function fundingRatePer8h() external view returns (int256);

    function unrealizedPnl(address account) external view returns (int256);

    function pendingFunding(address account) external view returns (int256);

    function accountEquity(address account) external view returns (int256);

    function maintenanceMargin(address account) external view returns (uint256);

    function liquidationPrice(address account) external view returns (uint256);

    function isLiquidatable(address account) external view returns (bool);

    /// @return execPrice price a trade of `sizeDelta` would execute at right now
    function quoteExecutionPrice(int256 sizeDelta) external view returns (uint256 execPrice);

    function takerFeeBps() external view returns (uint256);

    function maintenanceMarginBps() external view returns (uint256);

    function initialMarginBps() external view returns (uint256);
}
