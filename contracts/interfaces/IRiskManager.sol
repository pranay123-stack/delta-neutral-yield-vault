// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../libraries/Types.sol";

interface IRiskManager {
    /// @notice Three-level thresholds for one metric, in bps. For "higher is worse" metrics
    ///         warn < high < critical; for "lower is worse" metrics warn > high > critical.
    struct Threshold {
        uint32 warn;
        uint32 high;
        uint32 critical;
    }

    struct RiskConfig {
        Threshold leverage; // perp notional / perp equity (higher worse)
        Threshold delta; // |net delta| / NAV (higher worse)
        Threshold drawdown; // peak-to-current share price (higher worse)
        Threshold liquidationDistance; // |liq - mark| / mark (lower worse)
        Threshold collateralRatio; // perp equity / maintenance margin (lower worse)
        Threshold protocolExposure; // largest single-venue share of NAV (higher worse)
        int32 fundingWarnAprBps; // funding APR below this -> WARNING (e.g. 0)
        int32 fundingHighAprBps; // funding APR below this -> HIGH_RISK (e.g. -1000 = -10%)
        uint32 maxSlippageBps; // per-trade execution bound used by the strategy
        uint256 maxPositionNotional; // absolute cap on perp notional (usd6)
    }

    /// @notice Metric flags set in `RiskReport.flags` when the metric is at WARNING or worse.
    struct RiskReport {
        Types.RiskState state;
        uint256 flags;
        uint256 leverageBps;
        uint256 absDeltaBps;
        uint256 drawdownBps;
        uint256 liquidationDistanceBps;
        uint256 collateralRatioBps;
        int256 fundingAprBps;
        uint256 lendingExposureBps;
        uint256 perpExposureBps;
        bool oracleHealthy;
    }

    event RiskStateChanged(Types.RiskState previous, Types.RiskState current, uint256 flags);
    event PeakSharePriceUpdated(uint256 peak);
    event RiskConfigUpdated();

    error RiskLimitBreached(uint256 flags);

    function assess() external view returns (RiskReport memory);

    function assessSnapshot(Types.PositionSnapshot memory snap) external view returns (RiskReport memory);

    /// @notice Persist peak share price + risk state; trips the circuit breaker on EMERGENCY.
    function checkpoint() external returns (Types.RiskState);

    /// @notice Reverts unless `post` is within hard limits, or strictly de-risks every breached metric vs `pre`.
    function validateRebalance(Types.PositionSnapshot memory pre, Types.PositionSnapshot memory post) external view;

    function config() external view returns (RiskConfig memory);

    function currentState() external view returns (Types.RiskState);

    function peakSharePrice() external view returns (uint256);

    function maxSlippageBps() external view returns (uint256);
}
