// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lending-market surface the LendingAdapter depends on.
/// @dev `supply` / `withdraw` / `getReserveNormalizedIncome` match the Aave V3 Pool signatures exactly.
///      The remaining views stand in for things Aave exposes through aTokens and `getReserveData`
///      (aToken.balanceOf, currentLiquidityRate, available liquidity); a production Aave adapter
///      would read those instead. MockLendingProtocol implements this interface.
interface ILendingPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @dev `amount == type(uint256).max` withdraws the full balance (Aave semantics).
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @return Liquidity index, WAD. Supplied balances grow proportionally to it.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);

    /// @return Underlying balance of `user` including accrued interest.
    function balanceOf(address asset, address user) external view returns (uint256);

    /// @return Current supply APR, WAD.
    function supplyRate(address asset) external view returns (uint256);

    /// @return Current borrow APR, WAD.
    function borrowRate(address asset) external view returns (uint256);

    /// @return Borrowed / supplied, WAD.
    function utilization(address asset) external view returns (uint256);

    /// @return Underlying that can be withdrawn right now (supplied - borrowed).
    function availableLiquidity(address asset) external view returns (uint256);
}
