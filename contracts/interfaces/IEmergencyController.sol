// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEmergencyController {
    enum BreakerReason {
        NONE,
        RISK_EMERGENCY,
        ORACLE_FAILURE,
        MANUAL
    }

    event DepositsPaused(address indexed by, BreakerReason reason);
    event DepositsUnpaused(address indexed by);
    event StrategyPaused(address indexed by, BreakerReason reason);
    event StrategyUnpaused(address indexed by);
    event EmergencyUnwind(address indexed by, uint256 returned);

    function depositsPaused() external view returns (bool);

    function strategyPaused() external view returns (bool);

    /// @notice Terminal state after an emergency unwind: deposits and strategy permanently disabled,
    ///         withdrawals from the (now all-USDC) vault remain open.
    function isShutdown() external view returns (bool);

    /// @notice Called by RiskManager when the risk state reaches EMERGENCY.
    function tripCircuitBreaker(BreakerReason reason) external;
}
