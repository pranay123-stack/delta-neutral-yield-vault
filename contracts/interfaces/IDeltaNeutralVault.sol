// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

interface IDeltaNeutralVault is IERC4626 {
    event RedeemWithUnwind(
        address indexed owner, address indexed receiver, uint256 shares, uint256 grossAssets, uint256 netAssets
    );
    event PushedToStrategy(uint256 amount);
    event DepositCapUpdated(uint256 cap);
    event FeeSharesMinted(address indexed recipient, uint256 shares);

    error DepositsPaused();
    error OracleUnhealthy();
    error SlippageExceeded(uint256 received, uint256 minimum);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error AlreadyInitialized();

    /// @notice Exit beyond the liquid buffer: burns `shares`, unwinds the basis position pro-rata and
    ///         pays the redeemer net of the execution cost that *their* exit caused.
    function redeemWithUnwind(uint256 shares, address receiver, address owner, uint256 minAssetsOut)
        external
        returns (uint256 assets);

    /// @notice Crystallise management/performance fees. Permissionless.
    function accrueFees() external;

    /// @notice Move idle USDC into the strategy reserve. Only the RebalanceManager.
    function pushToStrategy(uint256 amount) external;

    /// @return USDC value of one whole share, 18 decimals (1e18 == 1.0 USDC).
    function sharePrice() external view returns (uint256);

    function idleAssets() external view returns (uint256);

    /// @return USDC withdrawable without trading: idle + strategy float + withdrawable reserve.
    function availableLiquidity() external view returns (uint256);

    /// @return false when NAV cannot be trusted (oracle unhealthy while positions are open).
    function isOperational() external view returns (bool);
}
