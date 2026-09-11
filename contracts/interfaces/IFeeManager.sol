// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeeManager {
    event FeesAccrued(
        uint256 managementShares,
        uint256 performanceShares,
        uint256 managementAssets,
        uint256 performanceAssets,
        uint256 highWaterMark
    );
    event FeeConfigUpdated(uint16 managementFeeBps, uint16 performanceFeeBps, uint16 withdrawalFeeBps);
    event FeeRecipientUpdated(address indexed recipient);

    /// @return mgmtShares shares to mint for the time-based management fee
    /// @return perfShares shares to mint for the performance fee above the high-water mark
    function previewAccrual(uint256 totalAssets, uint256 totalSupply)
        external
        view
        returns (uint256 mgmtShares, uint256 perfShares);

    /// @notice Crystallise fees. Only callable by the vault, which mints the returned shares.
    function accrue(uint256 totalAssets, uint256 totalSupply) external returns (uint256 mgmtShares, uint256 perfShares);

    function feeRecipient() external view returns (address);

    function managementFeeBps() external view returns (uint16);

    function performanceFeeBps() external view returns (uint16);

    function withdrawalFeeBps() external view returns (uint16);

    function highWaterMark() external view returns (uint256);

    function lastAccrual() external view returns (uint64);

    function totalManagementFeesAssets() external view returns (uint256);

    function totalPerformanceFeesAssets() external view returns (uint256);
}
