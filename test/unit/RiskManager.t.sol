// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {RiskManager} from "../../contracts/core/RiskManager.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract RiskManagerTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _bootstrap(100_000e6);
    }

    function _state() internal view returns (Types.RiskState) {
        return riskManager.assess().state;
    }

    function test_healthyBook_isNormalOrWarning() public view {
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertLe(uint256(r.state), uint256(Types.RiskState.WARNING));
        assertApproxEqRel(r.leverageBps, 20_000, 0.01e18);
        assertLe(r.absDeltaBps, 5);
        assertGt(r.liquidationDistanceBps, 4000, "2x short: ~43% to liquidation");
        assertTrue(r.oracleHealthy);
    }

    function test_leverage_escalatesThroughStates() public {
        _movePrice(1000); // lev ~2.75x -> WARNING
        assertEq(uint256(_state()), uint256(Types.RiskState.WARNING));
        _movePrice(900); // lev > 3.5x and liq distance < 20% -> HIGH_RISK
        assertEq(uint256(_state()), uint256(Types.RiskState.HIGH_RISK));
        _movePrice(1200); // lev > 5x, liq distance < 10% -> EMERGENCY
        assertEq(uint256(_state()), uint256(Types.RiskState.EMERGENCY));
    }

    function test_checkpoint_emergencyTripsDepositBreaker() public {
        _movePrice(1000);
        _movePrice(900);
        _movePrice(1200);
        vm.prank(keeper);
        riskManager.checkpoint();
        assertEq(uint256(riskManager.currentState()), uint256(Types.RiskState.EMERGENCY));
        assertTrue(emergency.depositsPaused(), "circuit breaker tripped");
        assertEq(vault.maxDeposit(bob), 0);
    }

    function test_checkpoint_tracksPeakAndDrawdown() public {
        _warp(10 days);
        vm.prank(keeper);
        riskManager.checkpoint();
        uint256 peak = riskManager.peakSharePrice();
        assertGt(peak, 0);
        perp.setFundingRate(-0.01e18); // brutal negative funding
        _warp(1 days);
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertGt(r.drawdownBps, 0, "drawdown measured vs stored peak");
        assertTrue(r.flags & riskManager.FLAG_DRAWDOWN() != 0 || r.drawdownBps < 200);
    }

    function test_negativeFunding_flagged() public {
        perp.setFundingRate(-0.0001e18); // ~ -11% APR
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertLt(r.fundingAprBps, -1000);
        assertTrue(r.flags & riskManager.FLAG_FUNDING() != 0);
        assertGe(uint256(r.state), uint256(Types.RiskState.HIGH_RISK));
    }

    function test_oracleUnhealthy_whilePositioned_isHighRisk() public {
        vm.warp(block.timestamp + 2 hours);
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertFalse(r.oracleHealthy);
        assertTrue(r.flags & riskManager.FLAG_ORACLE() != 0);
        assertGe(uint256(r.state), uint256(Types.RiskState.HIGH_RISK));
    }

    function test_exposure_isWarningOnlyInSingleVenueDemo() public {
        perp.setFundingRate(-0.0003e18);
        _warp(2 hours);
        _rebalance(); // goes defensive -> ~all capital in the lending venue
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertGt(r.lendingExposureBps, 8500);
        assertTrue(r.flags & riskManager.FLAG_EXPOSURE() != 0);
    }

    function test_validateRebalance_rejectsWorseningBreach() public {
        Types.PositionSnapshot memory pre = _snap();
        Types.PositionSnapshot memory post = _snap(); // separate copy (memory structs alias on `=`)
        post.perpEquity = pre.perpEquity / 4; // leverage 8x
        vm.expectPartialRevert(IRiskManager.RiskLimitBreached.selector);
        riskManager.validateRebalance(pre, post);
    }

    function test_validateRebalance_allowsImprovingBreach() public {
        Types.PositionSnapshot memory pre = _snap();
        pre.perpEquity = pre.perpEquity / 5; // 10x
        pre.liquidationPrice = pre.markPrice * 105 / 100;
        pre.maintenanceMargin = pre.shortNotional * 500 / 10_000;
        Types.PositionSnapshot memory post = _snap();
        post.perpEquity = pre.perpEquity * 2; // 5x - still above limit but strictly better
        post.liquidationPrice = pre.markPrice * 110 / 100;
        post.maintenanceMargin = pre.maintenanceMargin;
        riskManager.validateRebalance(pre, post); // does not revert
    }

    function test_validateRebalance_positionSizeCap() public {
        Types.PositionSnapshot memory pre = _snap();
        Types.PositionSnapshot memory post = _snap();
        post.shortNotional = 9_000_000e6;
        post.perpEquity = 4_500_000e6;
        post.totalNav = 15_000_000e6;
        vm.expectPartialRevert(IRiskManager.RiskLimitBreached.selector);
        riskManager.validateRebalance(pre, post);
    }

    function test_config_boundsEnforced() public {
        IRiskManager.RiskConfig memory c = riskManager.config();
        c.leverage.high = 60_000; // above the 5x hard ceiling
        c.leverage.critical = 70_000;
        vm.expectRevert(RiskManager.InvalidConfig.selector);
        riskManager.setConfig(c);

        c = riskManager.config();
        c.maxSlippageBps = 0;
        vm.expectRevert(RiskManager.InvalidConfig.selector);
        riskManager.setConfig(c);

        c = riskManager.config();
        c.liquidationDistance = IRiskManager.Threshold(1000, 2000, 500); // not descending
        vm.expectRevert(RiskManager.InvalidConfig.selector);
        riskManager.setConfig(c);
    }

    function test_checkpoint_onlyKeeperOrRebalancer() public {
        vm.prank(alice);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        riskManager.checkpoint();
    }
}
