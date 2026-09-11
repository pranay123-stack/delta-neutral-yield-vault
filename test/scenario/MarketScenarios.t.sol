// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {MockPerpetualMarket} from "../../contracts/mocks/MockPerpetualMarket.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice The scenario catalogue from the spec (A-H plus venue events), run against the full system.
///         Each scenario starts from a deployed $100k vault and asserts the economically meaningful
///         outcome, not just "didn't revert".
contract MarketScenariosTest is BaseTest {
    uint256 internal constant TVL = 100_000e6;

    function setUp() public override {
        super.setUp();
        _bootstrap(TVL);
    }

    /// @dev A keeper tick: observe vol, then rebalance if the on-chain planner says so.
    function _tick(uint256 dt) internal returns (bool rebalanced) {
        _warp(dt);
        vm.prank(keeper);
        rebalancer.observeVolatility();
        rebalanced = _tryRebalance();
    }

    function _navChangeBps(uint256 before) internal view returns (int256) {
        return (int256(vault.totalAssets()) - int256(before)) * 10_000 / int256(before);
    }

    // ------------------------------------------------------------------
    // A / B / C - price moves
    // ------------------------------------------------------------------

    /// Scenario A: ETH +20% over four days (5%/day) with the keeper running. The hedge keeps NAV flat and the
    /// rebalancer moves cash from the long leg into margin to keep leverage near 2x.
    function test_scenarioA_ethUp20_keeperKeepsLeverageAndDelta() public {
        uint256 nav0 = vault.totalAssets();
        uint256 rebalances;
        for (uint256 i; i < 4; ++i) {
            _movePrice(500);
            if (_tick(1 days)) ++rebalances;
            assertLe(_abs(_deltaBps()), 200, "delta within band after each tick");
        }
        assertGt(rebalances, 0, "leverage drift must trigger at least one rebalance");
        assertLt(_leverageBps(), 25_000, "leverage back under warn level");
        assertLt(_abs(_navChangeBps(nav0)), 50, "NAV moves < 0.5% on a 20% ETH move");
        assertEq(uint256(riskManager.assess().state) <= uint256(Types.RiskState.WARNING), true, "no high risk");
    }

    /// Scenario A': a single +19% jump with no keeper in between pushes leverage past the hard limit;
    /// the next rebalance is *urgent* (bypasses cooldown) and restores it.
    function test_scenarioA_ethJump_triggersUrgentRebalance() public {
        _movePrice(1900);
        IRiskManager.RiskReport memory r = riskManager.assess();
        assertGe(uint256(r.state), uint256(Types.RiskState.HIGH_RISK), "jump -> HIGH_RISK");
        assertGt(r.leverageBps, 35_000, "leverage above hard limit");

        (Types.RebalancePlan memory plan, bool execute) = rebalancer.previewRebalance();
        assertTrue(execute && plan.urgent, "urgent rebalance planned despite cooldown");
        _rebalance();
        assertLt(_leverageBps(), 25_000, "leverage restored");
        assertLe(_abs(_deltaBps()), 50, "delta restored");
    }

    /// Scenario B: ETH -20%. The short gains, margin piles up, leverage falls; the rebalancer
    /// withdraws surplus margin and re-levers the long leg.
    function test_scenarioB_ethDown20_relevers() public {
        uint256 nav0 = vault.totalAssets();
        for (uint256 i; i < 4; ++i) {
            _movePrice(-500);
            _tick(1 days);
            assertLe(_abs(_deltaBps()), 200, "delta within band");
        }
        uint256 lev = _leverageBps();
        assertGt(lev, 15_000, "re-levered towards target");
        assertLt(lev, 25_000, "not over-levered");
        assertLt(_abs(_navChangeBps(nav0)), 50, "NAV flat");
    }

    /// Scenario C: ETH -40% (short leg only gains, no liquidation risk) with keeper.
    function test_scenarioC_ethDown40_navStable() public {
        uint256 nav0 = vault.totalAssets();
        for (uint256 i; i < 8; ++i) {
            _movePrice(-620); // ~ -40% compounded over 8 days
            _tick(1 days);
        }
        assertLt(_price(), 1850e18, "price fell ~40%");
        assertLt(_abs(_navChangeBps(nav0)), 100, "NAV within 1% after -40%");
        assertLe(_abs(_deltaBps()), 200, "still neutral");
    }

    // ------------------------------------------------------------------
    // D / E - carry regime changes
    // ------------------------------------------------------------------

    /// Scenario D: funding flips to -0.03%/8h (~ -33% APR). The short now *pays*; the strategy goes
    /// defensive (reserve 70%), shrinking the basis trade.
    function test_scenarioD_negativeFunding_goesDefensive() public {
        uint256 longBefore = _snap().longValue;
        perp.setFundingRate(-0.0003e18);
        _tick(8 hours);
        Types.PositionSnapshot memory s = _snap();
        assertLt(s.longValue, longBefore / 2, "basis shrunk");
        assertGt(s.reserveAssets, s.totalNav / 2, "capital parked in USDC lending");
        assertLe(_abs(_deltaBps()), 200, "still neutral while shrinking");

        uint256 fundingBefore = uint256(positionManager.pnl().fundingIncome);
        _warp(1 days);
        int256 fundingAfter = positionManager.pnl().fundingIncome;
        assertLt(fundingAfter, int256(fundingBefore), "short pays negative funding");
    }

    /// Scenario E: lending APY collapses (utilisation 80% -> 5%). Yield falls but nothing breaks.
    function test_scenarioE_lendingApyDrop() public {
        Types.PositionSnapshot memory s0 = _snap();
        lendingPool.setUtilization(address(usdc), 0.05e18);
        lendingPool.setUtilization(address(weth), 0.05e18);
        Types.PositionSnapshot memory s1 = _snap();
        assertLt(s1.usdcSupplyRate, s0.usdcSupplyRate / 10, "usdc APY collapsed");
        uint256 nav0 = vault.totalAssets();
        _warp(30 days);
        assertGt(vault.totalAssets(), nav0, "funding still carries the vault");
    }

    // ------------------------------------------------------------------
    // F - volatility regime
    // ------------------------------------------------------------------

    /// Scenario F: hourly +/-6% chop. The EWMA vol estimate rises above the 60% reference and the
    /// effective target leverage is scaled down, lengthening distance to liquidation.
    function test_scenarioF_highVolatility_scalesLeverageDown() public {
        uint256 lev0 = rebalancer.effectiveLeverageBps();
        for (uint256 i; i < 24; ++i) {
            _movePrice(i % 2 == 0 ? int256(600) : int256(-566));
            _tick(1 hours);
        }
        uint256 vol = rebalancer.annualizedVolBps();
        assertGt(vol, 10_000, "realised vol > 100%");
        assertLt(rebalancer.effectiveLeverageBps(), lev0, "target leverage scaled down");
        assertLt(_leverageBps(), lev0, "actual leverage followed");
    }

    // ------------------------------------------------------------------
    // G - oracle failure
    // ------------------------------------------------------------------

    /// Scenario G: the oracle goes stale (no update for > heartbeat) and the fallback too. Share
    /// operations are blocked (NAV unknown) and no rebalance can trade; recovery is automatic.
    function test_scenarioG_staleOracle_blocksShareOpsAndTrading() public {
        vm.warp(block.timestamp + 2 hours); // no feed update
        (, Types.OracleStatus st) = oracle.tryGetPrice(address(weth));
        assertEq(uint256(st), uint256(Types.OracleStatus.STALE));
        assertFalse(vault.isOperational());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        (, bool execute) = rebalancer.previewRebalance();
        assertFalse(execute, "no trading on a stale price");
        assertGt(vault.totalAssets(), 0, "totalAssets still answers (last good price)");

        _setPrice(3000e8);
        assertTrue(vault.isOperational(), "recovers on fresh round");
    }

    // ------------------------------------------------------------------
    // H - execution cost
    // ------------------------------------------------------------------

    /// Scenario H: venues become shallow. A non-urgent rebalance is *skipped* by the cost filter,
    /// whereas an urgent one still executes.
    function test_scenarioH_largeSlippage_costFilter() public {
        dex.setPoolParams(30, 50, 2_000_000e6, 500); // 30 bps fee, 50 bps spread, $2M depth
        perp.setParams(
            MockPerpetualMarket.MarketParams({
                takerFeeBps: 5,
                spreadBps: 50,
                maxImpactBps: 500,
                initialMarginBps: 1000,
                maintenanceMarginBps: 500,
                liquidationPenaltyBps: 100,
                depthUsd: 2_000_000e6
            })
        );
        _movePrice(-800); // allocation drift over a day (moderate vol), not urgent
        _warp(1 days);
        (Types.RebalancePlan memory plan, bool execute) = rebalancer.previewRebalance();
        assertFalse(plan.urgent);
        assertTrue(!execute || plan.longUsdDelta == 0, "costly non-urgent re-lever skipped");
    }

    // ------------------------------------------------------------------
    // Venue events
    // ------------------------------------------------------------------

    /// The perp venue auto-deleverages 12% of the hedge. Delta jumps above the hard limit and the
    /// next rebalance restores it (urgent, bypasses cooldown).
    function test_venueAdl_restoresHedge() public {
        perp.simulateAdl(address(perpAdapter), 1200);
        assertGt(_deltaBps(), 500, "delta blown out by ADL");
        (Types.RebalancePlan memory plan, bool execute) = rebalancer.previewRebalance();
        assertTrue(execute && plan.urgent);
        _rebalance();
        assertLe(_abs(_deltaBps()), 20, "hedge restored");
    }

    /// Keeper offline + ETH +60%: the short is liquidated by the venue. Accounting stays exact and
    /// the next rebalance re-hedges from what is left.
    function test_perpLiquidation_accountingConsistent_andRehedge() public {
        _movePrice(6000);
        assertTrue(perp.isLiquidatable(address(perpAdapter)), "short liquidatable");
        perp.liquidate(address(perpAdapter));
        assertEq(_snap().perpSize, 0);

        Types.PnLBreakdown memory p = positionManager.pnl();
        assertApproxEqAbs(int256(p.strategyNav) - p.netCapital, p.netPnl, 20, "PnL reconciles after liquidation");
        assertGt(_deltaBps(), 1000, "naked long after liquidation");

        _rebalance();
        assertLe(_abs(_deltaBps()), 50, "re-hedged");
    }

    // ------------------------------------------------------------------
    // Exits
    // ------------------------------------------------------------------

    function test_emergencyUnwind_returnsEverythingToVault() public {
        _deposit(bob, 50_000e6);
        _warp(2 hours); // past the rebalance cooldown so bob's deposit is deployed, not just swept
        _rebalance();
        uint256 navBefore = vault.totalAssets();
        vm.prank(guardian);
        emergency.emergencyUnwind(2900e18, 3100e18);
        Types.PositionSnapshot memory s = _snap();
        assertEq(s.perpSize, 0);
        assertEq(s.longQty, 0);
        assertEq(s.strategyNav, 0);
        assertApproxEqRel(vault.totalAssets(), navBefore, 0.003e18, "unwind cost < 0.3%");
        assertFalse(strategy.isPriceDependent());

        // oracle can be completely dead now - exits still work because NAV is pure USDC
        feed.setShouldRevert(true);
        fallbackFeed.setShouldRevert(true);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqRel(usdc.balanceOf(bob), 50_000e6, 0.004e18);
        assertEq(vault.maxDeposit(carol), 0, "shutdown: no new deposits");
    }

    function test_redeemWithUnwind_exitingUserPaysOwnCost() public {
        _deposit(bob, 100_000e6);
        _warp(2 hours);
        _rebalance();
        uint256 aliceValueBefore = vault.convertToAssets(vault.balanceOf(alice));

        uint256 shares = vault.balanceOf(bob);
        uint256 gross = vault.previewRedeem(shares);
        vm.prank(bob);
        uint256 got = vault.redeemWithUnwind(shares, bob, bob, gross * 99 / 100);
        assertLt(got, gross, "bob paid his unwind cost");
        assertGt(got, gross * 998 / 1000, "cost is small (< 20 bps)");

        uint256 aliceValueAfter = vault.convertToAssets(vault.balanceOf(alice));
        assertApproxEqRel(aliceValueAfter, aliceValueBefore, 0.0002e18, "remaining holder unaffected");
        assertLe(_abs(_deltaBps()), 20, "remaining book still neutral");
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
