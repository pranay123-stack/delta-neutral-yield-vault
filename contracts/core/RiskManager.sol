// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {IEmergencyController} from "../interfaces/IEmergencyController.sol";
import {IPositionManager} from "../interfaces/IPositionManager.sol";
import {IRiskManager} from "../interfaces/IRiskManager.sol";
import {DeltaCalculator} from "../libraries/DeltaCalculator.sol";
import {PerpMath} from "../libraries/PerpMath.sol";
import {Types} from "../libraries/Types.sol";

/// @title RiskManager
/// @notice Classifies the portfolio into NORMAL / WARNING / HIGH_RISK / EMERGENCY, enforces hard limits
///         on every rebalance, and trips the deposit circuit breaker on EMERGENCY.
/// @dev Each metric has three thresholds (warn / high / critical). The portfolio state is the worst
///      metric's level. "high" is the hard limit a rebalance must end inside (or strictly improve
///      towards); "critical" escalates to EMERGENCY. Absolute bounds on the config are compile-time
///      constants so a misconfigured or malicious admin cannot switch risk controls off.
contract RiskManager is IRiskManager, Auth {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;
    /// @dev 8h funding periods per year: 3 * 365
    int256 internal constant FUNDING_PERIODS_PER_YEAR = 1095;
    int256 internal constant BPS_I = 10_000;

    uint256 public constant FLAG_LEVERAGE = 1 << 0;
    uint256 public constant FLAG_DELTA = 1 << 1;
    uint256 public constant FLAG_DRAWDOWN = 1 << 2;
    uint256 public constant FLAG_LIQUIDATION = 1 << 3;
    uint256 public constant FLAG_COLLATERAL = 1 << 4;
    uint256 public constant FLAG_FUNDING = 1 << 5;
    uint256 public constant FLAG_EXPOSURE = 1 << 6;
    uint256 public constant FLAG_ORACLE = 1 << 7;
    uint256 public constant FLAG_POSITION_SIZE = 1 << 8;

    // absolute sanity bounds on the config
    uint32 public constant MAX_LEVERAGE_LIMIT_BPS = 50_000; // 5x
    uint32 public constant MIN_LIQ_DISTANCE_LIMIT_BPS = 500; // 5%
    uint32 public constant MAX_SLIPPAGE_LIMIT_BPS = 500; // 5%

    IPositionManager public immutable positionManager;
    IDeltaNeutralVault public immutable vault;
    IEmergencyController public immutable emergency;
    address public rebalanceManager;

    RiskConfig internal _config;
    Types.RiskState public override currentState;
    uint256 public override peakSharePrice;

    error InvalidConfig();
    error AlreadyInitialized();
    error OnlyRebalanceManager();

    constructor(
        IAccessRegistry registry_,
        IPositionManager positionManager_,
        IDeltaNeutralVault vault_,
        IEmergencyController emergency_,
        RiskConfig memory config_
    ) Auth(registry_) {
        positionManager = positionManager_;
        vault = vault_;
        emergency = emergency_;
        _setConfig(config_);
    }

    function initialize(address rebalanceManager_) external onlyRole(Roles.ADMIN) {
        if (rebalanceManager != address(0)) revert AlreadyInitialized();
        if (rebalanceManager_ == address(0)) revert ZeroAddress();
        rebalanceManager = rebalanceManager_;
    }

    function setConfig(RiskConfig calldata config_) external onlyRole(Roles.ADMIN) {
        _setConfig(config_);
    }

    // ------------------------------------------------------------------
    // Assessment
    // ------------------------------------------------------------------

    function assess() external view override returns (RiskReport memory) {
        return assessSnapshot(positionManager.snapshot());
    }

    function assessSnapshot(Types.PositionSnapshot memory s) public view override returns (RiskReport memory) {
        return _assess(s, vault.sharePrice());
    }

    /// @dev `pps` is passed in so callers that already priced a share don't walk the NAV again.
    function _assess(Types.PositionSnapshot memory s, uint256 pps) internal view returns (RiskReport memory r) {
        RiskConfig memory c = _config;
        _fillMetrics(s, r);
        uint256 peak = Math.max(peakSharePrice, pps);
        r.drawdownBps = peak == 0 ? 0 : Math.mulDiv(peak - pps, BPS, peak);
        uint256 level;

        level = _max(level, _higherWorse(r.leverageBps, c.leverage), FLAG_LEVERAGE, r);
        level = _max(level, _higherWorse(r.absDeltaBps, c.delta), FLAG_DELTA, r);
        level = _max(level, _higherWorse(r.drawdownBps, c.drawdown), FLAG_DRAWDOWN, r);
        level = _max(level, _lowerWorse(r.liquidationDistanceBps, c.liquidationDistance), FLAG_LIQUIDATION, r);
        level = _max(level, _lowerWorse(r.collateralRatioBps, c.collateralRatio), FLAG_COLLATERAL, r);
        // Venue concentration is informational (capped at WARNING): with a single mock lending venue the
        // USDC reserve *is* concentrated by construction. With several LendingAdapters in production this
        // becomes a hard limit - see docs/risk-management.md.
        uint256 exposure = Math.max(r.lendingExposureBps, r.perpExposureBps);
        uint256 exposureLevel = _higherWorse(exposure, c.protocolExposure);
        if (exposureLevel > uint256(Types.RiskState.WARNING)) exposureLevel = uint256(Types.RiskState.WARNING);
        level = _max(level, exposureLevel, FLAG_EXPOSURE, r);

        uint256 fundingLevel;
        if (s.perpSize != 0) {
            if (r.fundingAprBps < c.fundingHighAprBps) fundingLevel = uint256(Types.RiskState.HIGH_RISK);
            else if (r.fundingAprBps < c.fundingWarnAprBps) fundingLevel = uint256(Types.RiskState.WARNING);
        }
        level = _max(level, fundingLevel, FLAG_FUNDING, r);

        if (s.shortNotional > c.maxPositionNotional) {
            level = _max(level, uint256(Types.RiskState.HIGH_RISK), FLAG_POSITION_SIZE, r);
        }
        // Unhealthy oracle while exposed: valuations can't be trusted -> HIGH_RISK
        if (!s.priceHealthy && (s.longQty > 0 || s.perpSize != 0)) {
            level = _max(level, uint256(Types.RiskState.HIGH_RISK), FLAG_ORACLE, r);
        }
        r.state = Types.RiskState(level);
    }

    /// @inheritdoc IRiskManager
    function checkpoint() external override returns (Types.RiskState) {
        if (msg.sender != rebalanceManager) _checkRole(Roles.KEEPER);
        return _checkpoint(positionManager.snapshot());
    }

    /// @inheritdoc IRiskManager
    function checkpointWith(Types.PositionSnapshot calldata post) external override returns (Types.RiskState) {
        if (msg.sender != rebalanceManager) revert OnlyRebalanceManager();
        return _checkpoint(post);
    }

    function _checkpoint(Types.PositionSnapshot memory s) internal returns (Types.RiskState state) {
        uint256 pps = vault.sharePrice();
        if (pps > peakSharePrice) {
            peakSharePrice = pps;
            emit PeakSharePriceUpdated(pps);
        }
        RiskReport memory r = _assess(s, pps);
        state = r.state;
        if (state != currentState) {
            emit RiskStateChanged(currentState, state, r.flags);
            currentState = state;
        }
        if (state == Types.RiskState.EMERGENCY) {
            emergency.tripCircuitBreaker(IEmergencyController.BreakerReason.RISK_EMERGENCY);
        }
    }

    /// @inheritdoc IRiskManager
    function validateRebalance(Types.PositionSnapshot memory pre, Types.PositionSnapshot memory post)
        external
        view
        override
    {
        RiskConfig memory c = _config;
        RiskReport memory a;
        RiskReport memory b;
        _fillMetrics(pre, a);
        _fillMetrics(post, b);
        uint256 breached;
        // a metric may end beyond its hard limit only if the rebalance moved it strictly in the right direction
        if (b.leverageBps > c.leverage.high && b.leverageBps >= a.leverageBps) breached |= FLAG_LEVERAGE;
        if (b.absDeltaBps > c.delta.high && b.absDeltaBps >= a.absDeltaBps) breached |= FLAG_DELTA;
        if (
            b.liquidationDistanceBps < c.liquidationDistance.high
                && b.liquidationDistanceBps <= a.liquidationDistanceBps
        ) {
            breached |= FLAG_LIQUIDATION;
        }
        if (b.collateralRatioBps < c.collateralRatio.high && b.collateralRatioBps <= a.collateralRatioBps) {
            breached |= FLAG_COLLATERAL;
        }
        if (post.shortNotional > c.maxPositionNotional && post.shortNotional >= pre.shortNotional) {
            breached |= FLAG_POSITION_SIZE;
        }
        if (breached != 0) revert RiskLimitBreached(breached);
    }

    function config() external view override returns (RiskConfig memory) {
        return _config;
    }

    function maxSlippageBps() external view override returns (uint256) {
        return _config.maxSlippageBps;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _fillMetrics(Types.PositionSnapshot memory s, RiskReport memory r) internal view {
        r.leverageBps = s.perpSize == 0
            ? 0
            : (s.perpEquity == 0 ? type(uint256).max : Math.mulDiv(s.shortNotional, BPS, s.perpEquity));
        r.absDeltaBps = DeltaCalculator.absDeltaBps(DeltaCalculator.compute(s, BPS));
        r.liquidationDistanceBps = PerpMath.distanceBps(s.markPrice, s.liquidationPrice, s.perpSize);
        r.collateralRatioBps =
            s.maintenanceMargin == 0 ? type(uint256).max : Math.mulDiv(s.perpEquity, BPS, s.maintenanceMargin);
        r.fundingAprBps = s.fundingRatePer8h * FUNDING_PERIODS_PER_YEAR * BPS_I / 1e18;
        if (s.totalNav > 0) {
            r.lendingExposureBps = Math.mulDiv(s.reserveAssets + s.longValue, BPS, s.totalNav);
            r.perpExposureBps = Math.mulDiv(s.perpEquity, BPS, s.totalNav);
        }
        r.oracleHealthy = s.priceHealthy;
    }

    function _higherWorse(uint256 v, Threshold memory t) internal pure returns (uint256) {
        if (v >= t.critical) return uint256(Types.RiskState.EMERGENCY);
        if (v >= t.high) return uint256(Types.RiskState.HIGH_RISK);
        if (v >= t.warn) return uint256(Types.RiskState.WARNING);
        return 0;
    }

    function _lowerWorse(uint256 v, Threshold memory t) internal pure returns (uint256) {
        if (v <= t.critical) return uint256(Types.RiskState.EMERGENCY);
        if (v <= t.high) return uint256(Types.RiskState.HIGH_RISK);
        if (v <= t.warn) return uint256(Types.RiskState.WARNING);
        return 0;
    }

    function _max(uint256 current, uint256 level, uint256 flag, RiskReport memory r) internal pure returns (uint256) {
        if (level > 0) r.flags |= flag;
        return level > current ? level : current;
    }

    function _setConfig(RiskConfig memory c) internal {
        if (
            !_ascending(c.leverage) || !_ascending(c.delta) || !_ascending(c.drawdown)
                || !_ascending(c.protocolExposure) || !_descending(c.liquidationDistance)
                || !_descending(c.collateralRatio) || c.leverage.high > MAX_LEVERAGE_LIMIT_BPS
                || c.liquidationDistance.high < MIN_LIQ_DISTANCE_LIMIT_BPS || c.maxSlippageBps == 0
                || c.maxSlippageBps > MAX_SLIPPAGE_LIMIT_BPS || c.maxPositionNotional == 0
                || c.fundingHighAprBps > c.fundingWarnAprBps || c.protocolExposure.critical > BPS
        ) revert InvalidConfig();
        _config = c;
        emit RiskConfigUpdated();
    }

    function _ascending(Threshold memory t) internal pure returns (bool) {
        return t.warn <= t.high && t.high <= t.critical && t.warn > 0;
    }

    function _descending(Threshold memory t) internal pure returns (bool) {
        return t.warn >= t.high && t.high >= t.critical;
    }
}
