// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../libraries/Types.sol";

/// @notice Keeper entry point. Implements the Chainlink Automation `checkUpkeep`/`performUpkeep`
///         shape so a decentralised keeper network can replace the demo keeper without code changes.
interface IRebalanceManager {
    struct Targets {
        uint32 targetLeverageBps; // perp notional / perp equity at target (e.g. 20000 = 2x)
        uint32 hedgeRatioBps; // |short qty| / long qty (10000 = fully hedged)
        uint32 reserveBps; // share of NAV kept as USDC in the lending reserve
        uint32 defensiveReserveBps; // reserve used when funding is below the floor
    }

    struct TargetBounds {
        uint32 minLeverageBps;
        uint32 maxLeverageBps;
        uint32 minHedgeRatioBps;
        uint32 maxHedgeRatioBps;
        uint32 minReserveBps;
        uint32 maxReserveBps;
    }

    struct Params {
        uint32 deltaBandBps; // re-hedge when |delta| / NAV exceeds this
        uint32 leverageBandBps; // re-margin when leverage deviates from target by more than this (relative)
        uint32 allocationBandBps; // resize basis when long leg deviates from target by this share of NAV
        uint32 minIntervalSec; // cooldown between non-urgent rebalances
        uint32 maxCostBps; // max estimated execution cost per non-urgent rebalance, share of NAV
        uint32 carryHorizonSec; // horizon over which added carry must pay back execution cost
        uint32 volRefBps; // reference annualised vol; above it leverage and delta band scale down
        int32 fundingFloorAprBps; // below this funding APR the strategy goes defensive
        uint256 minTradeUsd; // ignore adjustments smaller than this (usd6)
        uint256 minDeployUsd; // sweep vault idle once it exceeds this (usd6)
        uint256 gasCostUsd; // keeper gas per trading rebalance, priced in USD (usd6); chain-dependent
    }

    /// @notice Everything the backend needs to reconstruct a rebalance without extra reads.
    struct RebalanceRecord {
        uint32 triggers;
        bool urgent;
        int256 longUsdDelta;
        int256 marginDelta;
        int256 perpSizeChange;
        int256 preDeltaBps;
        int256 postDeltaBps;
        uint256 preLeverageBps;
        uint256 postLeverageBps;
        uint256 estimatedCost;
        uint256 realizedCost; // fees + slippage actually paid
    }

    event Rebalanced(uint256 indexed id, RebalanceRecord record);
    event TargetsUpdated(Targets targets);
    event ParamsUpdated(Params params);
    event VolatilityObserved(uint256 price, uint256 annualizedVolBps);

    error NothingToRebalance();
    error StrategyPaused();
    error OracleUnhealthy();

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData);

    function performUpkeep(bytes calldata) external;

    /// @return plan the plan that would execute now
    /// @return execute whether any trigger fired and passed the cooldown / cost filters
    function previewRebalance() external view returns (Types.RebalancePlan memory plan, bool execute);

    function targets() external view returns (Targets memory);

    function params() external view returns (Params memory);

    function effectiveLeverageBps() external view returns (uint256);

    function annualizedVolBps() external view returns (uint256);

    function lastRebalanceAt() external view returns (uint64);

    function rebalanceCount() external view returns (uint256);
}
