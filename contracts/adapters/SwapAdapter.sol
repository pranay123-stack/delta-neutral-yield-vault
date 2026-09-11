// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapAdapter} from "../interfaces/IAdapters.sol";
import {ISpotDEX} from "../interfaces/external/ISpotDEX.sol";

/// @title SwapAdapter
/// @notice Routes the strategy's USDC <-> WETH conversions. Output always goes back to the strategy.
contract SwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    ISpotDEX public immutable dex;
    address public immutable strategy;

    error OnlyStrategy();
    error ZeroAddress();

    constructor(ISpotDEX dex_, address strategy_, address[] memory tokens) {
        if (address(dex_) == address(0) || strategy_ == address(0)) revert ZeroAddress();
        dex = dex_;
        strategy = strategy_;
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i]).forceApprove(address(dex_), type(uint256).max);
        }
    }

    /// @dev Pulls `amountIn` from the strategy inside the call, so a failed swap moves nothing.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        override
        returns (uint256 amountOut, uint256 fee)
    {
        if (msg.sender != strategy) revert OnlyStrategy();
        IERC20(tokenIn).safeTransferFrom(strategy, address(this), amountIn);
        (, fee) = dex.quote(tokenIn, tokenOut, amountIn);
        amountOut = dex.swapExactIn(tokenIn, tokenOut, amountIn, minAmountOut, strategy);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        override
        returns (uint256 amountOut, uint256 fee)
    {
        return dex.quote(tokenIn, tokenOut, amountIn);
    }

    function feeBps() external view override returns (uint256) {
        return dex.feeBps();
    }

    function venue() external view override returns (address) {
        return address(dex);
    }
}
