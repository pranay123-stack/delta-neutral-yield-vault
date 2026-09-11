// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../libraries/Types.sol";
import {ILendingAdapter, IPerpAdapter, ISwapAdapter} from "./IAdapters.sol";
import {IOracleManager} from "./IOracleManager.sol";

interface IStrategyManager {
    /// @notice Strategy-side cumulative counters used for PnL attribution (all usd6).
    struct Accounting {
        int256 netCapital; // USDC in from vault - USDC back to vault
        uint256 spotCostBasis; // mid-price cost of WETH currently held
        int256 spotRealizedPnl; // realised on WETH sales vs cost basis
        uint256 swapFees;
        int256 swapSlippage; // + = cost (execution worse than oracle)
    }

    event CapitalReceived(uint256 amount);
    event CapitalReturned(uint256 amount);
    event RebalanceExecuted(
        int256 longUsdDelta, int256 marginDelta, int256 perpSizeChange, uint256 fees, uint256 slippage
    );
    event Unwound(uint256 requested, uint256 delivered, uint256 fractionWad);
    event EmergencyUnwound(uint256 returned);
    event SpotTrade(
        bool buy, uint256 usdcAmount, uint256 wethAmount, uint256 oraclePrice, uint256 fee, int256 slippage
    );

    function asset() external view returns (address);

    function weth() external view returns (address);

    function vault() external view returns (address);

    function oracle() external view returns (IOracleManager);

    function lendingAdapter() external view returns (ILendingAdapter);

    function perpAdapter() external view returns (IPerpAdapter);

    function swapAdapter() external view returns (ISwapAdapter);

    /// @notice Strategy NAV in USDC. Never reverts; uses last good price if the oracle is unhealthy.
    function totalAssets() external view returns (uint256);

    /// @notice True when NAV depends on the ETH price (any WETH held or perp position open).
    function isPriceDependent() external view returns (bool);

    /// @notice One-pass valuation for the vault: NAV, whether it depends on the ETH price, and
    ///         whether that price is currently trustworthy. Saves a second oracle validation.
    function valuation() external view returns (uint256 nav, bool priceDependent, bool priceHealthy);

    /// @notice USDC obtainable without trading (float + withdrawable reserve).
    function availableLiquidity() external view returns (uint256);

    function accounting() external view returns (Accounting memory);

    /// @notice Vault pushed `amount` USDC to the strategy; it is parked in the lending reserve.
    function onCapitalReceived(uint256 amount) external;

    /// @notice Return up to `amount` USDC to the vault from float + reserve (no trading).
    function withdrawLiquid(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Unwind the basis position pro-rata to raise `amount` USDC for an exiting depositor.
    ///         Execution costs are borne by the caller's user, not socialised.
    function unwindFor(uint256 amount) external returns (uint256 delivered);

    function executeRebalance(Types.RebalancePlan calldata plan) external returns (Types.ExecutionResult memory);

    /// @notice Close every position and return all USDC to the vault. Price bounds are supplied
    ///         explicitly by the guardian so the unwind works even when the oracle is down.
    function emergencyUnwind(uint256 minSellPrice, uint256 maxBuyPrice) external returns (uint256 returned);
}
