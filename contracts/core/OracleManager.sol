// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IOracleManager} from "../interfaces/IOracleManager.sol";
import {IAggregatorV3} from "../interfaces/external/IAggregatorV3.sol";
import {GasGuard} from "../libraries/GasGuard.sol";
import {Types} from "../libraries/Types.sol";

/// @title OracleManager
/// @notice Validates Chainlink-style feeds and normalises every price to 18 decimals.
/// @dev Checks, in order, for the primary feed (then the secondary if the primary fails):
///        1. feed call must not revert                                   -> FEED_FAILURE
///        2. feed `decimals()` must equal the configured decimals        -> DECIMALS_MISMATCH
///        3. answer must be > 0                                          -> INVALID_PRICE
///        4. updatedAt must be non-zero and not in the future            -> INVALID_PRICE
///        5. answeredInRound >= roundId                                  -> INCOMPLETE_ROUND
///        6. now - updatedAt <= heartbeat                                -> STALE
///        7. |answer - previousRound| / previousRound <= maxDeviation   -> DEVIATION
///      Check 7 is stateless (Liquity-style): it compares consecutive rounds of the feed itself, so a
///      single manipulated or fat-fingered round is rejected, while a genuine move is accepted as soon
///      as the next round confirms it. Nothing needs to be "poked" for the check to work.
///      A guardian can shut the oracle down entirely; every consumer then treats prices as unusable
///      and the protocol falls back to its oracle-free paths (withdraw idle USDC, emergency unwind with
///      guardian-supplied price bounds).
contract OracleManager is IOracleManager, Auth {
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;
    uint32 public constant MAX_HEARTBEAT = 2 days;
    uint16 public constant MAX_DEVIATION_BPS = 5000;

    mapping(address asset => FeedConfig) internal _configs;
    mapping(address asset => uint256) internal _lastGoodPrice;
    mapping(address asset => uint64) internal _lastGoodAt;
    bool public override isShutdown;

    error InvalidConfig();

    constructor(IAccessRegistry registry_) Auth(registry_) {}

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setFeed(address asset, FeedConfig calldata cfg) external onlyRole(Roles.ADMIN) {
        if (
            asset == address(0) || cfg.primary == address(0) || cfg.heartbeat == 0 || cfg.heartbeat > MAX_HEARTBEAT
                || cfg.maxDeviationBps == 0 || cfg.maxDeviationBps > MAX_DEVIATION_BPS || cfg.decimals > 36
        ) revert InvalidConfig();
        if (IAggregatorV3(cfg.primary).decimals() != cfg.decimals) revert InvalidConfig();
        if (cfg.secondary != address(0) && IAggregatorV3(cfg.secondary).decimals() != cfg.decimals) {
            revert InvalidConfig();
        }
        _configs[asset] = cfg;
        emit FeedConfigured(asset, cfg.primary, cfg.secondary, cfg.heartbeat, cfg.decimals, cfg.maxDeviationBps);
    }

    /// @notice Guardian can shut the oracle down; only admin can bring it back (asymmetric on purpose).
    function setShutdown(bool shutdown) external {
        if (shutdown) _checkGuardian();
        else _checkRole(Roles.ADMIN);
        isShutdown = shutdown;
        emit OracleShutdown(shutdown);
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function getPrice(address asset) external view override returns (uint256) {
        (uint256 price, Types.OracleStatus status) = tryGetPrice(asset);
        if (status != Types.OracleStatus.OK && status != Types.OracleStatus.FALLBACK) {
            revert OracleUnhealthy(asset, status);
        }
        return price;
    }

    function tryGetPrice(address asset) public view override returns (uint256 price, Types.OracleStatus status) {
        if (isShutdown) return (0, Types.OracleStatus.SHUTDOWN);
        FeedConfig memory cfg = _configs[asset];
        if (cfg.primary == address(0)) return (0, Types.OracleStatus.NOT_CONFIGURED);

        (price, status) = _readFeed(cfg.primary, cfg);
        if (status == Types.OracleStatus.OK || cfg.secondary == address(0)) return (price, status);

        (uint256 fallbackPrice, Types.OracleStatus fallbackStatus) = _readFeed(cfg.secondary, cfg);
        if (fallbackStatus == Types.OracleStatus.OK) return (fallbackPrice, Types.OracleStatus.FALLBACK);
        return (0, status); // report the primary's failure reason
    }

    function getPriceOrLastGood(address asset) external view override returns (uint256 price, bool healthy) {
        Types.OracleStatus status;
        (price, status) = tryGetPrice(asset);
        healthy = status == Types.OracleStatus.OK || status == Types.OracleStatus.FALLBACK;
        if (!healthy) price = _lastGoodPrice[asset];
    }

    function poke(address asset) external override returns (uint256 price, Types.OracleStatus status) {
        (price, status) = tryGetPrice(asset);
        if (status == Types.OracleStatus.OK || status == Types.OracleStatus.FALLBACK) {
            _lastGoodPrice[asset] = price;
            _lastGoodAt[asset] = uint64(block.timestamp);
        }
        emit PricePoked(asset, price, status);
    }

    function lastGoodPrice(address asset) external view override returns (uint256 price, uint64 timestamp) {
        return (_lastGoodPrice[asset], _lastGoodAt[asset]);
    }

    function feedConfig(address asset) external view override returns (FeedConfig memory) {
        return _configs[asset];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _readFeed(address feed, FeedConfig memory cfg)
        internal
        view
        returns (uint256 price, Types.OracleStatus status)
    {
        uint80 roundId;
        int256 answer;
        uint256 updatedAt;
        uint80 answeredInRound;
        // GasGuard: a starved feed call must revert, not be reported as FEED_FAILURE (which would steer
        // callers to the fallback feed or the last-good price) or silently skip the deviation check.
        uint256 g = gasleft();
        try IAggregatorV3(feed).latestRoundData() returns (uint80 r, int256 a, uint256, uint256 u, uint80 ar) {
            (roundId, answer, updatedAt, answeredInRound) = (r, a, u, ar);
        } catch {
            GasGuard.checkNotStarved(g);
            return (0, Types.OracleStatus.FEED_FAILURE);
        }

        g = gasleft();
        try IAggregatorV3(feed).decimals() returns (uint8 d) {
            if (d != cfg.decimals) return (0, Types.OracleStatus.DECIMALS_MISMATCH);
        } catch {
            GasGuard.checkNotStarved(g);
            return (0, Types.OracleStatus.FEED_FAILURE);
        }

        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (0, Types.OracleStatus.INVALID_PRICE);
        if (answeredInRound < roundId) return (0, Types.OracleStatus.INCOMPLETE_ROUND);
        if (block.timestamp - updatedAt > cfg.heartbeat) return (0, Types.OracleStatus.STALE);

        if (roundId > 1) {
            g = gasleft();
            try IAggregatorV3(feed).getRoundData(roundId - 1) returns (
                uint80, int256 prev, uint256, uint256 prevAt, uint80
            ) {
                if (prev > 0 && prevAt != 0) {
                    uint256 cur = answer.toUint256();
                    uint256 p = prev.toUint256();
                    uint256 diff = cur > p ? cur - p : p - cur;
                    if (Math.mulDiv(diff, BPS, p) > cfg.maxDeviationBps) return (0, Types.OracleStatus.DEVIATION);
                }
            } catch {
                GasGuard.checkNotStarved(g); // never let a starved call skip the deviation check
                // Previous round unavailable (e.g. new aggregator phase): skip the deviation check
                // rather than bricking the feed; staleness and sanity checks above still apply.
            }
        }

        price = _normalize(answer.toUint256(), cfg.decimals);
        status = Types.OracleStatus.OK;
    }

    function _normalize(uint256 value, uint8 decimals_) internal pure returns (uint256) {
        if (decimals_ == 18) return value;
        if (decimals_ < 18) return value * 10 ** (18 - decimals_);
        return value / 10 ** (decimals_ - 18);
    }
}
