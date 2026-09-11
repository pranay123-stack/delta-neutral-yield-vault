// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal exact-input swap venue (Uniswap-style `exactInputSingle` shape, flattened).
interface ISpotDEX {
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut);

    /// @return amountOut output after fee and price impact
    /// @return feeInTokenIn portion of `amountIn` taken as LP fee
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 feeInTokenIn);

    function feeBps() external view returns (uint256);
}
