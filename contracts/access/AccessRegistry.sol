// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {Roles} from "./Roles.sol";

/// @title AccessRegistry
/// @notice Single source of truth for roles across all protocol modules, so a role grant/revoke
///         (e.g. rotating a compromised keeper) is one transaction instead of one per contract.
contract AccessRegistry is AccessControl, IAccessRegistry {
    constructor(address admin) {
        _grantRole(Roles.ADMIN, admin);
    }

    function hasRole(bytes32 role, address account)
        public
        view
        override(AccessControl, IAccessRegistry)
        returns (bool)
    {
        return super.hasRole(role, account);
    }
}
