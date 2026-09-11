// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../libraries/Types.sol";

interface IOracleManager {
    struct FeedConfig {
        address primary; // Chainlink-style aggregator
        address secondary; // optional fallback aggregator (address(0) = none)
        uint32 heartbeat; // max seconds since `updatedAt` before a price is stale
        uint8 decimals; // expected feed decimals; a mismatch is treated as a failure
        uint16 maxDeviationBps; // max move between consecutive rounds before the round is rejected
    }

    event FeedConfigured(
        address indexed asset,
        address primary,
        address secondary,
        uint32 heartbeat,
        uint8 decimals,
        uint16 maxDeviationBps
    );
    event PricePoked(address indexed asset, uint256 price, Types.OracleStatus status);
    event OracleShutdown(bool shutdown);

    error OracleUnhealthy(address asset, Types.OracleStatus status);

    /// @notice Validated, 18-decimal price. Reverts with `OracleUnhealthy` unless status is OK/FALLBACK.
    function getPrice(address asset) external view returns (uint256);

    /// @notice Non-reverting variant used by monitoring and view paths.
    function tryGetPrice(address asset) external view returns (uint256 price, Types.OracleStatus status);

    /// @notice Validated price if healthy, otherwise the last recorded good price.
    /// @dev Only for *valuation in views* (ERC-4626 `totalAssets` must not revert). Any state-changing
    ///      path must use `getPrice`.
    function getPriceOrLastGood(address asset) external view returns (uint256 price, bool healthy);

    /// @notice Record the current price as last-good if healthy. Permissionless.
    function poke(address asset) external returns (uint256 price, Types.OracleStatus status);

    function lastGoodPrice(address asset) external view returns (uint256 price, uint64 timestamp);

    function isShutdown() external view returns (bool);

    function feedConfig(address asset) external view returns (FeedConfig memory);
}
