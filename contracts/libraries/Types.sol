// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Types
/// @notice Shared data structures. Unit conventions used everywhere in the protocol:
///         - USDC amounts / USD values: 6 decimals ("usd6")
///         - ETH quantities: 18 decimals ("qty18")
///         - Prices: USD per 1 ETH, 18 decimals ("price18"), always normalised by OracleManager
///         - Ratios: basis points (1e4 = 100%) unless the name ends in `Wad` (1e18 = 100%)
///         - Rates: annualised, WAD (1e18 = 100%/yr) unless stated as `Per8h`
library Types {
    enum RiskState {
        NORMAL,
        WARNING,
        HIGH_RISK,
        EMERGENCY
    }

    /// @notice Health classification returned by OracleManager for a single asset.
    enum OracleStatus {
        OK,
        FALLBACK,
        STALE,
        INVALID_PRICE,
        INCOMPLETE_ROUND,
        DEVIATION,
        DECIMALS_MISMATCH,
        FEED_FAILURE,
        SHUTDOWN,
        NOT_CONFIGURED
    }

    /// @notice Point-in-time view of every strategy position, valued in USDC.
    /// @dev Produced by PositionManager; consumed by the vault, risk engine, rebalancer and backend.
    struct PositionSnapshot {
        uint256 price; // oracle ETH/USD (price18); last good price if unhealthy
        bool priceHealthy;
        uint256 vaultIdle; // USDC sitting in the vault (usd6)
        uint256 strategyFloat; // USDC sitting in the strategy contract (usd6)
        uint256 reserveAssets; // USDC supplied to the lending market, incl. interest (usd6)
        uint256 longQty; // WETH supplied to the lending market, incl. interest (qty18)
        uint256 longValue; // longQty valued at `price` (usd6)
        int256 perpSize; // signed perp position (qty18); the strategy only ever shorts
        uint256 markPrice; // perp venue mark (price18)
        uint256 shortNotional; // |perpSize| * markPrice (usd6)
        uint256 perpMargin; // posted collateral incl. settled PnL/funding (usd6)
        int256 perpUnrealizedPnl; // (usd6)
        int256 perpPendingFunding; // unsettled funding, + = receivable (usd6)
        uint256 perpEquity; // max(margin + uPnL + pendingFunding, 0) (usd6)
        uint256 liquidationPrice; // price18, 0 when flat
        uint256 maintenanceMargin; // venue MMR for the current position (usd6)
        int256 fundingRatePer8h; // WAD per 8h, + = longs pay shorts
        uint256 usdcSupplyRate; // WAD APR
        uint256 wethSupplyRate; // WAD APR
        uint256 strategyNav; // float + reserve + longValue + perpEquity (usd6)
        uint256 totalNav; // strategyNav + vaultIdle (usd6)
    }

    /// @notice Output of DeltaCalculator.
    struct DeltaReport {
        uint256 longExposureUsd; // usd6
        uint256 shortExposureUsd; // usd6
        uint256 grossExposureUsd; // usd6
        int256 netDeltaQty; // qty18, + = net long
        int256 netDeltaUsd; // usd6
        int256 deltaBps; // netDeltaUsd / totalNav in bps
        uint256 hedgeRatioBps; // short / long in bps
        int256 targetPerpSize; // qty18 (negative = short)
        int256 requiredPerpSizeChange; // qty18, what the hedge must trade to reach target
    }

    /// @notice Liquidation-risk metrics for the perp leg.
    struct LiquidationReport {
        uint256 markPrice;
        uint256 liquidationPrice;
        uint256 distanceBps; // |liq - mark| / mark in bps, type(uint256).max when flat
        uint256 leverageBps; // notional / equity in bps
        uint256 collateralRatioBps; // equity / maintenance margin in bps
        uint256 safetyBufferBps; // distanceBps - configured minimum (0 if below)
    }

    /// @notice A fully specified rebalance, computed on-chain by RebalanceManager.
    struct RebalancePlan {
        uint256 sweepIdle; // USDC to move vault -> strategy reserve (usd6)
        int256 longUsdDelta; // + buy WETH with this much USDC, - sell WETH worth this much (usd6)
        int256 marginDelta; // + post margin, - withdraw margin (usd6)
        uint256 hedgeRatioBps; // perp is re-hedged to -hedgeRatio * longQty after long adjustments
        uint256 maxSlippageBps; // slippage bound applied to every trade
        uint256 estimatedCost; // fees + slippage estimate (usd6)
        uint32 triggers; // bitmask of RebalanceManager.TRIGGER_* that fired
        bool urgent; // bypassed cooldown / cost filters because risk was elevated
    }

    /// @notice Result of executing a plan on the strategy.
    struct ExecutionResult {
        int256 perpSizeChange; // qty18 traded on the perp
        uint256 tradingFees; // usd6 (swap + perp fees)
        uint256 slippage; // usd6 (swap + perp price impact vs oracle/mark)
    }

    /// @notice Full strategy PnL attribution. Every line is cumulative since inception, in usd6.
    /// @dev Reconciles by construction (up to integer rounding):
    ///        strategyNav - netCapital == netPnl
    ///      Trading PnL is measured against the *oracle/mark* price at execution, so execution
    ///      cost shows up only in `tradingFees` and `slippage`, never inside the price PnL lines.
    ///      Supplied-WETH interest is valued at the current price and carved out of spot PnL;
    ///      spot unrealized PnL is the residual. See docs/pnl-accounting.md.
    struct PnLBreakdown {
        int256 lendingIncomeUsdc; // interest earned on the USDC reserve
        int256 lendingIncomeWeth; // interest earned on supplied WETH, valued at current price
        int256 fundingIncome; // settled + pending funding (+ = received)
        int256 spotRealizedPnl; // realised on WETH sales vs mid-price cost basis
        int256 spotUnrealizedPnl; // mark-to-market of held WETH vs cost basis, net of WETH interest
        int256 perpRealizedPnl; // realised vs mark-price entry
        int256 perpUnrealizedPnl; // open position vs mark-price entry
        int256 tradingFees; // swap fees + perp taker fees + liquidation penalties (+ = cost)
        int256 slippage; // price impact vs oracle/mark on swaps and perp trades (+ = cost)
        int256 badDebtAbsorbed; // loss beyond posted margin absorbed by the perp venue (+ = gain to us)
        int256 netPnl; // income + trading PnL - costs + badDebtAbsorbed
        int256 netCapital; // USDC received from the vault minus USDC returned to it
        uint256 strategyNav;
    }
}
