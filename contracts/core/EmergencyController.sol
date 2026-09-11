// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IEmergencyController} from "../interfaces/IEmergencyController.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";

/// @title EmergencyController
/// @notice Central pause/shutdown state and the emergency unwind.
/// @dev Asymmetric by design: the guardian (fast, e.g. a monitoring multisig) can only make the
///      system *safer* - pause deposits, pause strategy trading, unwind everything back into the vault.
///      Undoing a pause needs ADMIN (slow, timelocked). Notably there is no way to pause withdrawals:
///      depositors can always exit from idle/reserve liquidity. Emergency unwind is terminal: the vault
///      becomes a plain USDC pool that only allows exits.
contract EmergencyController is IEmergencyController, Auth {
    bool public override depositsPaused;
    bool public override strategyPaused;
    bool public override isShutdown;

    IStrategyManager public strategy;
    address public riskManager;

    event Initialized(address indexed strategy, address indexed riskManager);

    error AlreadyInitialized();
    error OnlyRiskManager();
    error SystemShutdown();

    constructor(IAccessRegistry registry_) Auth(registry_) {}

    function initialize(IStrategyManager strategy_, address riskManager_) external onlyRole(Roles.ADMIN) {
        if (address(strategy) != address(0)) revert AlreadyInitialized();
        if (address(strategy_) == address(0) || riskManager_ == address(0)) revert ZeroAddress();
        strategy = strategy_;
        riskManager = riskManager_;
        emit Initialized(address(strategy_), riskManager_);
    }

    function pauseDeposits() external {
        _checkGuardian();
        depositsPaused = true;
        emit DepositsPaused(msg.sender, BreakerReason.MANUAL);
    }

    function unpauseDeposits() external onlyRole(Roles.ADMIN) {
        if (isShutdown) revert SystemShutdown();
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    function pauseStrategy() external {
        _checkGuardian();
        strategyPaused = true;
        emit StrategyPaused(msg.sender, BreakerReason.MANUAL);
    }

    function unpauseStrategy() external onlyRole(Roles.ADMIN) {
        if (isShutdown) revert SystemShutdown();
        strategyPaused = false;
        emit StrategyUnpaused(msg.sender);
    }

    /// @inheritdoc IEmergencyController
    function tripCircuitBreaker(BreakerReason reason) external override {
        if (msg.sender != riskManager) revert OnlyRiskManager();
        if (!depositsPaused) {
            depositsPaused = true;
            emit DepositsPaused(msg.sender, reason);
        }
    }

    /// @notice Close every position and return all USDC to the vault. Repeatable (e.g. if lending
    ///         liquidity was insufficient the first time).
    /// @param minSellPrice lowest acceptable ETH price (price18) when selling the long leg
    /// @param maxBuyPrice highest acceptable ETH price (price18) when buying back the short
    function emergencyUnwind(uint256 minSellPrice, uint256 maxBuyPrice) external returns (uint256 returned) {
        _checkGuardian();
        depositsPaused = true;
        strategyPaused = true;
        isShutdown = true;
        returned = strategy.emergencyUnwind(minSellPrice, maxBuyPrice);
        emit EmergencyUnwind(msg.sender, returned);
    }
}
