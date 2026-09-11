// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IAggregatorV3} from "../interfaces/external/IAggregatorV3.sol";
import {ISpotDEX} from "../interfaces/external/ISpotDEX.sol";

/// @title MockSpotDEX
/// @notice USDC/WETH swap venue for the spot (long) leg.
/// @dev Simulated as an oracle-priced RFQ venue: output = oracle price, less an LP fee, less linear
///      price impact (spread + notional/depth). This keeps swap cost deterministic and tunable for
///      the "large slippage" scenario. A production SwapAdapter would route through an AMM or
///      aggregator, where execution can deviate from the oracle in either direction - which is why
///      the strategy always enforces an oracle-derived `minAmountOut`.
contract MockSpotDEX is ISpotDEX, Ownable {
    using SafeERC20 for IERC20;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IAggregatorV3 public immutable priceFeed;
    uint8 internal immutable _feedDecimals;

    uint256 public override feeBps;
    uint256 public spreadBps;
    uint256 public depthUsd; // usd6; impact = notional / depth
    uint256 public maxImpactBps;

    event PoolParamsUpdated(uint256 feeBps, uint256 spreadBps, uint256 depthUsd, uint256 maxImpactBps);

    error UnsupportedPair();
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error InvalidPrice();
    error InvalidParams();

    constructor(IERC20 usdc_, IERC20 weth_, IAggregatorV3 feed_, uint256 feeBps_, uint256 spreadBps_, uint256 depthUsd_)
        Ownable(msg.sender)
    {
        usdc = usdc_;
        weth = weth_;
        priceFeed = feed_;
        _feedDecimals = feed_.decimals();
        _setParams(feeBps_, spreadBps_, depthUsd_, 500);
    }

    function setPoolParams(uint256 feeBps_, uint256 spreadBps_, uint256 depthUsd_, uint256 maxImpactBps_)
        external
        onlyOwner
    {
        _setParams(feeBps_, spreadBps_, depthUsd_, maxImpactBps_);
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        override
        returns (uint256 amountOut)
    {
        uint256 fee;
        (amountOut, fee) = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        override
        returns (uint256 amountOut, uint256 fee)
    {
        bool buyWeth = tokenIn == address(usdc) && tokenOut == address(weth);
        bool sellWeth = tokenIn == address(weth) && tokenOut == address(usdc);
        if (!buyWeth && !sellWeth) revert UnsupportedPair();

        fee = Math.mulDiv(amountIn, feeBps, BPS, Math.Rounding.Ceil);
        uint256 net = amountIn - fee;
        uint256 price = _price();
        // notional in usd6 and output at the oracle price before impact
        uint256 notionalUsd;
        uint256 rawOut;
        if (buyWeth) {
            notionalUsd = net;
            rawOut = Math.mulDiv(net, 1e30, price); // usd6 -> qty18
        } else {
            notionalUsd = Math.mulDiv(net, price, 1e30); // qty18 -> usd6
            rawOut = notionalUsd;
        }
        uint256 impactWad = spreadBps * 1e14;
        if (depthUsd > 0) impactWad += Math.mulDiv(notionalUsd, WAD, depthUsd);
        uint256 cap = maxImpactBps * 1e14;
        if (impactWad > cap) impactWad = cap;
        amountOut = Math.mulDiv(rawOut, WAD - impactWad, WAD);
    }

    function _price() internal view returns (uint256) {
        (, int256 answer,,,) = priceFeed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        uint8 d = _feedDecimals;
        return d <= 18 ? answer.toUint256() * 10 ** (18 - d) : answer.toUint256() / 10 ** (d - 18);
    }

    function _setParams(uint256 feeBps_, uint256 spreadBps_, uint256 depthUsd_, uint256 maxImpactBps_) internal {
        if (feeBps_ > 100 || spreadBps_ > 500 || maxImpactBps_ >= BPS) revert InvalidParams();
        feeBps = feeBps_;
        spreadBps = spreadBps_;
        depthUsd = depthUsd_;
        maxImpactBps = maxImpactBps_;
        emit PoolParamsUpdated(feeBps_, spreadBps_, depthUsd_, maxImpactBps_);
    }
}
