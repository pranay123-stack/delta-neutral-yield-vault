// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {RebalanceManager} from "../../contracts/core/RebalanceManager.sol";
import {IRebalanceManager} from "../../contracts/interfaces/IRebalanceManager.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract RebalanceManagerTest is BaseTest {
    function _preview() internal view returns (Types.RebalancePlan memory p, bool ex) {
        return rebalancer.previewRebalance();
    }

    function test_idleDeposit_triggersDeployment() public {
        _deposit(alice, 100_000e6);
        (Types.RebalancePlan memory p, bool ex) = _preview();
        assertTrue(ex);
        assertTrue(p.triggers & rebalancer.TRIGGER_IDLE() != 0);
        assertTrue(p.triggers & rebalancer.TRIGGER_ALLOCATION() != 0);
        assertApproxEqRel(uint256(p.longUsdDelta), 60_000e6, 0.001e18);
        assertApproxEqRel(uint256(p.marginDelta), 30_000e6, 0.001e18);
        assertEq(p.sweepIdle, 100_000e6);
        assertGt(p.estimatedCost, 0);
    }

    function test_noTriggers_noUpkeep() public {
        _bootstrap(100_000e6);
        _warp(2 hours);
        (bool needed,) = rebalancer.checkUpkeep("");
        assertFalse(needed);
        vm.prank(keeper);
        vm.expectRevert(IRebalanceManager.NothingToRebalance.selector);
        rebalancer.performUpkeep("");
    }

    function test_smallMove_insideBands_noRebalance() public {
        _bootstrap(100_000e6);
        _movePrice(300); // +3% over a day: leverage 2.2x, allocation drift 1.8% of NAV - inside bands
        _warp(1 days);
        (, bool ex) = _preview();
        assertFalse(ex, "avoid churn inside the no-trade band");
    }

    function test_cooldown_blocksNonUrgent_allowsUrgent() public {
        _bootstrap(100_000e6);
        _movePrice(800); // allocation + leverage drift, but not urgent
        (Types.RebalancePlan memory p, bool ex) = _preview();
        assertFalse(p.urgent);
        assertFalse(ex, "cooldown holds non-urgent trades");

        _movePrice(1100); // now leverage > hard limit -> urgent
        (p, ex) = _preview();
        assertTrue(p.urgent && ex, "urgent bypasses cooldown");
    }

    function test_cooldown_idleSweepStillAllowed() public {
        _bootstrap(100_000e6);
        _deposit(bob, 50_000e6);
        (Types.RebalancePlan memory p, bool ex) = _preview();
        assertTrue(ex);
        assertEq(p.longUsdDelta, 0, "no trading in cooldown");
        assertEq(p.sweepIdle, 50_000e6, "cost-free sweep into the reserve");
        uint64 last = rebalancer.lastRebalanceAt();
        _rebalance();
        assertEq(rebalancer.lastRebalanceAt(), last, "sweep does not reset the trading cooldown");
    }

    function test_carryFilter_blocksUnprofitableRelever() public {
        perp.setFundingRate(-0.00001e18); // ~ -1% APR: carry < usdc lending yield
        _deposit(alice, 100_000e6);
        (Types.RebalancePlan memory p, bool ex) = _preview();
        assertEq(p.longUsdDelta, 0, "won't open a basis that can't pay for itself");
        assertTrue(ex, "still sweeps idle");
    }

    function test_defensiveMode_shrinksTargetOnNegativeFunding() public {
        _bootstrap(100_000e6);
        perp.setFundingRate(-0.0002e18); // -22% APR < -5% floor
        _warp(2 hours);
        (Types.RebalancePlan memory p, bool ex) = _preview();
        assertTrue(ex);
        assertTrue(p.triggers & rebalancer.TRIGGER_FUNDING_DEFENSIVE() != 0);
        assertLt(p.longUsdDelta, -30_000e6, "delever towards 30% basis");
    }

    function test_volatility_observationAndScaling() public {
        assertEq(rebalancer.annualizedVolBps(), 6000, "seeded at reference");
        assertEq(rebalancer.effectiveLeverageBps(), 20_000);
        vm.prank(keeper);
        rebalancer.observeVolatility(); // first observation just records the price
        for (uint256 i; i < 10; ++i) {
            _movePrice(i % 2 == 0 ? int256(400) : int256(-385));
            _warp(1 hours);
            vm.prank(keeper);
            rebalancer.observeVolatility();
        }
        assertGt(rebalancer.annualizedVolBps(), 6000);
        assertLt(rebalancer.effectiveLeverageBps(), 20_000);
        assertGe(rebalancer.effectiveLeverageBps(), 10_000, "floored at min leverage");
    }

    function test_volatility_ignoresTooFrequentObservations() public {
        vm.prank(keeper);
        rebalancer.observeVolatility();
        _movePrice(1000);
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(keeper);
        rebalancer.observeVolatility();
        assertEq(rebalancer.annualizedVolBps(), 6000, "sub-interval observation ignored");
    }

    function test_strategist_setsTargetsWithinBounds() public {
        IRebalanceManager.Targets memory t = rebalancer.targets();
        t.targetLeverageBps = 15_000;
        vm.prank(strategist);
        rebalancer.setTargets(t);
        assertEq(rebalancer.targets().targetLeverageBps, 15_000);

        t.targetLeverageBps = 40_000; // above the 3x bound
        vm.prank(strategist);
        vm.expectRevert(RebalanceManager.InvalidTargets.selector);
        rebalancer.setTargets(t);

        vm.prank(keeper);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.setTargets(t);
    }

    function test_params_validated() public {
        IRebalanceManager.Params memory p = rebalancer.params();
        p.maxCostBps = 1000;
        vm.expectRevert(RebalanceManager.InvalidParams.selector);
        rebalancer.setParams(p);
    }

    function test_performUpkeep_onlyKeeper() public {
        _deposit(alice, 100_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.performUpkeep("");
    }

    function test_performUpkeep_revertsWhenStrategyPaused() public {
        _deposit(alice, 100_000e6);
        vm.prank(guardian);
        emergency.pauseStrategy();
        vm.prank(keeper);
        vm.expectRevert(IRebalanceManager.StrategyPaused.selector);
        rebalancer.performUpkeep("");
    }

    function test_performUpkeep_revertsOnStaleOracle() public {
        _deposit(alice, 100_000e6);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(keeper);
        vm.expectRevert(); // OracleUnhealthy from observe/getPrice
        rebalancer.performUpkeep("");
    }

    function test_rebalanceRecord_emitted() public {
        _deposit(alice, 100_000e6);
        vm.recordLogs();
        _rebalance();
        assertEq(rebalancer.rebalanceCount(), 1);
        assertEq(rebalancer.lastRebalanceAt(), block.timestamp);
    }

    /// Delta after *any* successful rebalance is within the configured hard limit.
    function testFuzz_postRebalanceDeltaWithinLimit(int256 moveBps, uint256 dt) public {
        moveBps = bound(moveBps, -3000, 3000);
        dt = bound(dt, 1 hours, 3 days);
        _bootstrap(100_000e6);
        _movePrice(moveBps);
        _warp(dt);
        (, bool ex) = _preview();
        if (!ex) return;
        _rebalance();
        int256 dBps = _deltaBps();
        assertLe(dBps < 0 ? -dBps : dBps, 500, "|delta| <= hard limit after rebalance");
    }
}
