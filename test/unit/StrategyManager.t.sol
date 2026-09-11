// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {LendingAdapter} from "../../contracts/adapters/LendingAdapter.sol";
import {PerpAdapter} from "../../contracts/adapters/PerpAdapter.sol";
import {SwapAdapter} from "../../contracts/adapters/SwapAdapter.sol";
import {StrategyManager} from "../../contracts/core/StrategyManager.sol";
import {ILendingAdapter, IPerpAdapter, ISwapAdapter} from "../../contracts/interfaces/IAdapters.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract StrategyManagerTest is BaseTest {
    function _plan(int256 longUsd, int256 margin) internal pure returns (Types.RebalancePlan memory p) {
        p.longUsdDelta = longUsd;
        p.marginDelta = margin;
        p.hedgeRatioBps = 10_000;
        p.maxSlippageBps = 100;
    }

    // ---- access control ----------------------------------------------------

    function test_vaultOnlyEntrypoints() public {
        vm.expectRevert(StrategyManager.OnlyVault.selector);
        strategy.onCapitalReceived(1);
        vm.expectRevert(StrategyManager.OnlyVault.selector);
        strategy.withdrawLiquid(1);
        vm.expectRevert(StrategyManager.OnlyVault.selector);
        strategy.unwindFor(1);
    }

    function test_executeRebalance_onlyRebalanceManager() public {
        vm.prank(keeper); // even the keeper must go through the RebalanceManager
        vm.expectRevert(StrategyManager.OnlyRebalancer.selector);
        strategy.executeRebalance(_plan(0, 0));
    }

    function test_emergencyUnwind_onlyEmergencyController() public {
        vm.prank(guardian);
        vm.expectRevert(StrategyManager.OnlyEmergency.selector);
        strategy.emergencyUnwind(0, type(uint256).max);
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(StrategyManager.AlreadyInitialized.selector);
        strategy.initialize(lendingAdapter, perpAdapter, swapAdapter, address(rebalancer), riskManager);
    }

    function test_initialize_rejectsAdaptersBoundElsewhere() public {
        StrategyManager fresh = new StrategyManager(registry, address(vault), usdc, address(weth), oracle, emergency);
        vm.expectRevert(StrategyManager.AdapterMismatch.selector);
        fresh.initialize(lendingAdapter, perpAdapter, swapAdapter, address(rebalancer), riskManager);
    }

    function test_adapters_onlyStrategy() public {
        vm.expectRevert(LendingAdapter.OnlyStrategy.selector);
        lendingAdapter.withdraw(address(usdc), 1);
        vm.expectRevert(PerpAdapter.OnlyStrategy.selector);
        perpAdapter.withdrawMargin(1);
        vm.expectRevert(PerpAdapter.OnlyStrategy.selector);
        perpAdapter.trade(-1e18, 0);
        vm.expectRevert(SwapAdapter.OnlyStrategy.selector);
        swapAdapter.swap(address(usdc), address(weth), 1, 0);
    }

    function test_slippageBound_hardCapped() public {
        _deposit(alice, 10_000e6);
        Types.RebalancePlan memory p = _plan(0, 0);
        p.maxSlippageBps = 501;
        vm.prank(address(rebalancer));
        vm.expectPartialRevert(StrategyManager.SlippageTooHigh.selector);
        strategy.executeRebalance(p);
    }

    // ---- execution ----------------------------------------------------------

    function test_executeRebalance_buysHedgesAndParks() public {
        _deposit(alice, 100_000e6);
        vm.prank(address(rebalancer));
        vault.pushToStrategy(100_000e6);
        vm.prank(address(rebalancer));
        Types.ExecutionResult memory res = strategy.executeRebalance(_plan(60_000e6, 30_000e6));
        Types.PositionSnapshot memory s = _snap();
        assertEq(s.perpSize, -int256(s.longQty), "hedged 1:1 against the actual fill");
        assertEq(s.strategyFloat, 0, "no idle float left behind");
        assertGt(res.tradingFees, 0);
        assertEq(res.perpSizeChange, s.perpSize);
    }

    function test_executeRebalance_revertsWhenStrategyPaused() public {
        _bootstrap(100_000e6);
        vm.prank(guardian);
        emergency.pauseStrategy();
        vm.prank(address(rebalancer));
        vm.expectRevert(StrategyManager.StrategyIsPaused.selector);
        strategy.executeRebalance(_plan(0, 0));
    }

    function test_executeRebalance_insufficientReserveReverts() public {
        _deposit(alice, 10_000e6);
        vm.prank(address(rebalancer));
        vault.pushToStrategy(10_000e6);
        vm.prank(address(rebalancer));
        vm.expectPartialRevert(StrategyManager.InsufficientReserve.selector);
        strategy.executeRebalance(_plan(50_000e6, 0));
    }

    /// Slippage bounds are derived from the oracle: a DEX that fills far from oracle is rejected.
    function test_executeRebalance_dexWorseThanOracle_reverts() public {
        _deposit(alice, 100_000e6);
        vm.prank(address(rebalancer));
        vault.pushToStrategy(100_000e6);
        dex.setPoolParams(100, 500, 1_000_000e6, 900); // ~6% worse than oracle
        vm.prank(address(rebalancer));
        vm.expectRevert(); // MockSpotDEX.InsufficientOutput via minOut from oracle - 1%
        strategy.executeRebalance(_plan(60_000e6, 30_000e6));
    }

    function test_withdrawLiquid_takesFromReserveOnly() public {
        _bootstrap(100_000e6);
        uint256 perpBefore = uint256(-_snap().perpSize);
        vm.prank(address(vault));
        uint256 got = strategy.withdrawLiquid(5000e6);
        assertEq(got, 5000e6);
        assertEq(uint256(-_snap().perpSize), perpBefore, "no trading on liquid withdrawals");
    }

    function test_accounting_tracksCostBasisAndCosts() public {
        _bootstrap(100_000e6);
        StrategyManagerAccountingView.check(strategy);
    }

    function test_emergencyUnwind_bestEffort_whenDexBroken() public {
        _bootstrap(100_000e6);
        dex.setPoolParams(100, 500, 1000, 9000); // DEX so bad the swap fails the min-out
        vm.prank(guardian);
        uint256 returned = emergency.emergencyUnwind(2990e18, 3010e18);
        // perp closed + margin + reserve still came back even though the WETH sale failed
        assertEq(_snap().perpSize, 0);
        assertGt(returned, 35_000e6);
        assertGt(weth.balanceOf(address(strategy)), 0, "WETH stays in strategy, not stranded in adapter");
        assertEq(weth.balanceOf(address(swapAdapter)), 0);

        // guardian fixes routing and retries
        dex.setPoolParams(5, 2, 500_000_000e6, 200);
        vm.prank(guardian);
        emergency.emergencyUnwind(2990e18, 3010e18);
        assertEq(weth.balanceOf(address(strategy)), 0);
        assertFalse(strategy.isPriceDependent());
    }
}

library StrategyManagerAccountingView {
    function check(StrategyManager s) internal view {
        StrategyManager.Accounting memory a = s.accounting();
        require(a.netCapital == 100_000e6, "net capital");
        require(a.spotCostBasis > 59_000e6 && a.spotCostBasis < 60_000e6, "cost basis at mid");
        require(a.swapFees > 0, "fees");
        require(a.swapSlippage > 0, "slippage");
    }
}
