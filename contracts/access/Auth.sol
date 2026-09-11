// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {Roles} from "./Roles.sol";

/// @title Auth
/// @notice Role-gating mixin that defers to the shared AccessRegistry.
abstract contract Auth {
    IAccessRegistry public immutable accessRegistry;

    error Unauthorized(bytes32 role, address account);
    error ZeroAddress();

    constructor(IAccessRegistry registry_) {
        if (address(registry_) == address(0)) revert ZeroAddress();
        accessRegistry = registry_;
    }

    modifier onlyRole(bytes32 role) {
        _checkRole(role);
        _;
    }

    function _checkRole(bytes32 role) internal view {
        if (!accessRegistry.hasRole(role, msg.sender)) revert Unauthorized(role, msg.sender);
    }

    /// @dev Admin is always allowed to act as guardian (it could grant itself the role anyway).
    function _checkGuardian() internal view {
        if (!accessRegistry.hasRole(Roles.GUARDIAN, msg.sender) && !accessRegistry.hasRole(Roles.ADMIN, msg.sender)) {
            revert Unauthorized(Roles.GUARDIAN, msg.sender);
        }
    }
}
