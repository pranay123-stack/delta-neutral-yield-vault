// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Roles
/// @notice Role identifiers shared by every module via AccessRegistry.
/// @dev Separation of duties:
///      ADMIN      - parameter changes within hard-coded bounds. Intended holder: TimelockController.
///      GUARDIAN   - can only *reduce* risk: pause, trip breakers, emergency-unwind to USDC in the vault.
///                   Cannot move funds anywhere except back to the vault.
///      KEEPER     - runs mechanical upkeep: rebalance, oracle pokes, fee accrual, risk checkpoints.
///      STRATEGIST - sets strategy targets (leverage, hedge ratio, reserve) inside ADMIN-set bounds.
library Roles {
    bytes32 internal constant ADMIN = 0x00; // == AccessControl.DEFAULT_ADMIN_ROLE
    bytes32 internal constant GUARDIAN = keccak256("GUARDIAN_ROLE");
    bytes32 internal constant KEEPER = keccak256("KEEPER_ROLE");
    bytes32 internal constant STRATEGIST = keccak256("STRATEGIST_ROLE");
}
