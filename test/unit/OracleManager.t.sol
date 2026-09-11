// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {OracleManager} from "../../contracts/core/OracleManager.sol";
import {IOracleManager} from "../../contracts/interfaces/IOracleManager.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {MockAggregatorV3} from "../../contracts/mocks/MockAggregatorV3.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract OracleManagerTest is BaseTest {
    address internal asset;

    function setUp() public override {
        super.setUp();
        asset = address(weth);
    }

    function _status() internal view returns (Types.OracleStatus s) {
        (, s) = oracle.tryGetPrice(asset);
    }

    // ---- happy path & normalisation ----------------------------------

    function test_normalisesEightDecimalsTo18() public view {
        assertEq(oracle.getPrice(asset), 3000e18);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.OK));
    }

    function test_normalises18And20DecimalFeeds() public {
        MockAggregatorV3 f18 = new MockAggregatorV3(18, "18d", 3000e18);
        MockAggregatorV3 f20 = new MockAggregatorV3(20, "20d", 3000e20);
        address a18 = makeAddr("a18");
        address a20 = makeAddr("a20");
        oracle.setFeed(a18, IOracleManager.FeedConfig(address(f18), address(0), 1 hours, 18, 2000));
        oracle.setFeed(a20, IOracleManager.FeedConfig(address(f20), address(0), 1 hours, 20, 2000));
        assertEq(oracle.getPrice(a18), 3000e18);
        assertEq(oracle.getPrice(a20), 3000e18);
    }

    // ---- failure modes -------------------------------------------------

    function test_stalePrice_detected() public {
        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.STALE));
        vm.expectRevert(
            abi.encodeWithSelector(IOracleManager.OracleUnhealthy.selector, asset, Types.OracleStatus.STALE)
        );
        oracle.getPrice(asset);
    }

    function test_stalePrice_exactlyAtHeartbeatIsFresh() public {
        vm.warp(block.timestamp + 1 hours);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.OK));
    }

    function test_zeroPrice_invalid() public {
        _setPrice(0);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.INVALID_PRICE));
    }

    function test_negativePrice_invalid() public {
        _setPrice(-1);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.INVALID_PRICE));
    }

    function test_futureTimestamp_invalid() public {
        feed.setAnswerAt(3000e8, block.timestamp + 60);
        fallbackFeed.setAnswerAt(3000e8, block.timestamp + 60);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.INVALID_PRICE));
    }

    function test_incompleteRound_detected() public {
        uint80 next = feed.latestRound() + 1;
        feed.setRawRound(next, 3000e8, block.timestamp, block.timestamp, next - 1);
        fallbackFeed.setShouldRevert(true);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.INCOMPLETE_ROUND));
    }

    function test_extremeJump_rejectedUntilConfirmed() public {
        _setPrice(3000e8 * 13 / 10); // +30% in one round, guard is 20%
        assertEq(uint256(_status()), uint256(Types.OracleStatus.DEVIATION));
        // a second round at the same level confirms the move
        _setPrice(3000e8 * 13 / 10);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.OK));
        assertEq(oracle.getPrice(asset), 3900e18);
    }

    function test_crashJump_rejected() public {
        _setPrice(3000e8 / 2); // -50%
        assertEq(uint256(_status()), uint256(Types.OracleStatus.DEVIATION));
    }

    function test_decimalMismatch_detected() public {
        feed.setDecimals(18);
        fallbackFeed.setDecimals(18);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.DECIMALS_MISMATCH));
    }

    function test_decimalMismatch_rejectedAtConfiguration() public {
        MockAggregatorV3 f = new MockAggregatorV3(18, "x", 1e18);
        vm.expectRevert(OracleManager.InvalidConfig.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(f), address(0), 1 hours, 8, 2000));
    }

    function test_feedRevert_isFeedFailure() public {
        feed.setShouldRevert(true);
        fallbackFeed.setShouldRevert(true);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.FEED_FAILURE));
    }

    function test_fallbackUsedWhenPrimaryFails() public {
        feed.setShouldRevert(true);
        (uint256 p, Types.OracleStatus s) = oracle.tryGetPrice(asset);
        assertEq(uint256(s), uint256(Types.OracleStatus.FALLBACK));
        assertEq(p, 3000e18);
        assertEq(oracle.getPrice(asset), 3000e18, "FALLBACK is usable");
    }

    function test_fallbackAlsoBad_reportsPrimaryReason() public {
        vm.warp(block.timestamp + 2 hours);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.STALE));
    }

    function test_notConfigured() public {
        (, Types.OracleStatus s) = oracle.tryGetPrice(makeAddr("unknown"));
        assertEq(uint256(s), uint256(Types.OracleStatus.NOT_CONFIGURED));
    }

    // ---- emergency shutdown -------------------------------------------

    function test_shutdown_guardianCanShutAdminRestores() public {
        vm.prank(guardian);
        oracle.setShutdown(true);
        assertEq(uint256(_status()), uint256(Types.OracleStatus.SHUTDOWN));

        vm.prank(guardian);
        vm.expectRevert();
        oracle.setShutdown(false); // guardian cannot re-enable

        oracle.setShutdown(false); // admin (test contract)
        assertEq(uint256(_status()), uint256(Types.OracleStatus.OK));
    }

    function test_shutdown_randomCannotShut() public {
        vm.prank(alice);
        vm.expectRevert();
        oracle.setShutdown(true);
    }

    // ---- last good price ------------------------------------------------

    function test_poke_recordsLastGood_andIsUsedWhenUnhealthy() public {
        oracle.poke(asset);
        (uint256 lg, uint64 at) = oracle.lastGoodPrice(asset);
        assertEq(lg, 3000e18);
        assertEq(at, block.timestamp);

        _setPrice(3100e8);
        vm.warp(block.timestamp + 2 hours); // stale
        (uint256 p, bool healthy) = oracle.getPriceOrLastGood(asset);
        assertFalse(healthy);
        assertEq(p, 3000e18, "falls back to last *poked* good price");
    }

    function test_poke_doesNotRecordBadPrice() public {
        oracle.poke(asset);
        _setPrice(0);
        oracle.poke(asset);
        (uint256 lg,) = oracle.lastGoodPrice(asset);
        assertEq(lg, 3000e18);
    }

    // ---- configuration --------------------------------------------------

    function test_setFeed_onlyAdmin() public {
        vm.prank(alice);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(feed), address(0), 1 hours, 8, 2000));
    }

    function test_setFeed_validatesBounds() public {
        vm.expectRevert(OracleManager.InvalidConfig.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(feed), address(0), 0, 8, 2000));
        vm.expectRevert(OracleManager.InvalidConfig.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(feed), address(0), 3 days, 8, 2000));
        vm.expectRevert(OracleManager.InvalidConfig.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(feed), address(0), 1 hours, 8, 0));
        vm.expectRevert(OracleManager.InvalidConfig.selector);
        oracle.setFeed(asset, IOracleManager.FeedConfig(address(feed), address(0), 1 hours, 8, 6000));
    }

    // ---- fuzz -------------------------------------------------------------

    /// Any positive, fresh answer within the deviation guard normalises exactly.
    function testFuzz_normalisation(uint256 bps) public {
        bps = bound(bps, 8000, 12_000); // within +/-20%
        int256 p = int256(3000e8 * bps / 10_000);
        _setPrice(p);
        assertEq(oracle.getPrice(asset), uint256(p) * 1e10);
    }

    /// Deviation guard fires exactly above the configured bound.
    function testFuzz_deviationBoundary(uint256 bps) public {
        bps = bound(bps, 1, 5000);
        int256 p = int256(3000e8 + 3000e8 * bps / 10_000);
        _setPrice(p);
        Types.OracleStatus s = _status();
        if (bps > 2000) assertEq(uint256(s), uint256(Types.OracleStatus.DEVIATION));
        else assertEq(uint256(s), uint256(Types.OracleStatus.OK));
    }
}
