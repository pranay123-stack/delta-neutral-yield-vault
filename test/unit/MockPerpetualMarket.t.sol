// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPerpMarket} from "../../contracts/interfaces/external/IPerpMarket.sol";
import {PerpMath} from "../../contracts/libraries/PerpMath.sol";
import {MockPerpetualMarket} from "../../contracts/mocks/MockPerpetualMarket.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract MockPerpetualMarketTest is BaseTest {
    function setUp() public override {
        super.setUp();
        usdc.mint(alice, 10_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(perp), type(uint256).max);
        perp.depositMargin(30_000e6);
        vm.stopPrank();
    }

    function _short(uint256 qty) internal {
        vm.prank(alice);
        perp.trade(-int256(qty), 0);
    }

    function _conservation() internal view {
        IPerpMarket.Position memory p = perp.getPosition(alice);
        uint256 lhs = usdc.balanceOf(address(perp));
        uint256 rhs = p.margin + perp.lpPool() + perp.insuranceFund();
        assertEq(lhs, rhs, "balance == margins + pool + insurance");
    }

    function test_openShort_entryBelowMarkByImpact() public {
        _short(20e18);
        IPerpMarket.Position memory p = perp.getPosition(alice);
        assertEq(p.size, -20e18);
        assertLt(p.entryPrice, 3000e18, "sells fill below mark");
        assertGt(p.entryPrice, 2999e18, "~2.6 bps impact on $60k");
        // fee = 5 bps of notional
        IPerpMarket.AccountStats memory st = perp.getAccountStats(alice);
        assertApproxEqRel(st.feesPaid, 30e6, 0.01e18);
        _conservation();
    }

    function test_shortPnl_signs() public {
        _short(20e18);
        IPerpMarket.Position memory p = perp.getPosition(alice);
        _setPrice(3300e8);
        int256 u = perp.unrealizedPnl(alice);
        assertEq(u, PerpMath.pnl(-20e18, p.entryPrice, 3300e18));
        assertLt(u, 0, "short loses when price rises");
        _setPrice(2700e8);
        assertGt(perp.unrealizedPnl(alice), 0, "short gains when price falls");
    }

    function test_funding_positiveRatePaysShorts() public {
        _short(10e18);
        vm.warp(block.timestamp + 8 hours);
        _setPrice(3000e8);
        // 0.01% * $3000 * 10 ETH = $3 per 8h
        assertApproxEqAbs(perp.pendingFunding(alice), 3e6, 1);
    }

    function test_funding_negativeRateChargesShorts() public {
        _short(10e18);
        perp.setFundingRate(-0.0002e18);
        vm.warp(block.timestamp + 8 hours);
        _setPrice(3000e8);
        assertApproxEqAbs(perp.pendingFunding(alice), -6e6, 1);
    }

    function test_funding_settlesIntoMarginOnInteraction() public {
        _short(10e18);
        uint256 m0 = perp.getPosition(alice).margin;
        vm.warp(block.timestamp + 24 hours);
        _setPrice(3000e8);
        vm.prank(alice);
        perp.depositMargin(1e6);
        IPerpMarket.Position memory p = perp.getPosition(alice);
        assertApproxEqAbs(p.margin, m0 + 1e6 + 9e6, 2, "3 periods * $3 settled");
        assertEq(perp.pendingFunding(alice), 0);
        assertApproxEqAbs(perp.getAccountStats(alice).fundingPnl, 9e6, 2);
        _conservation();
    }

    function test_initialMargin_blocksOverLeverage() public {
        // $30k margin, 10% IM -> max ~$300k notional (100 ETH)
        vm.prank(alice);
        vm.expectPartialRevert(MockPerpetualMarket.InsufficientMargin.selector);
        perp.trade(-110e18, 0);
    }

    function test_withdrawMargin_respectsInitialMargin() public {
        _short(80e18); // $240k notional, IMR $24k
        vm.prank(alice);
        vm.expectPartialRevert(MockPerpetualMarket.InsufficientMargin.selector);
        perp.withdrawMargin(10_000e6);
    }

    function test_priceLimit_enforced() public {
        vm.prank(alice);
        vm.expectPartialRevert(MockPerpetualMarket.PriceLimitExceeded.selector);
        perp.trade(-1e18, 3000e18); // sell must fill >= 3000: impossible with spread
    }

    function test_reduceRealisesPnl_andFlip() public {
        _short(10e18);
        _setPrice(2700e8);
        vm.prank(alice);
        (, int256 realized,) = perp.trade(15e18, type(uint256).max); // close 10, open 5 long
        assertGt(realized, 0, "closing a winning short realises profit");
        IPerpMarket.Position memory p = perp.getPosition(alice);
        assertEq(p.size, 5e18, "flipped long");
        assertGt(p.entryPrice, 2700e18, "new long entry = buy exec (above mark)");
        _conservation();
    }

    /// The analytic liquidation price is exactly the equity == MMR boundary.
    function test_liquidationPrice_matchesBoundary() public {
        _short(20e18);
        uint256 liq = perp.liquidationPrice(alice);
        // just below liq: safe; just above: liquidatable
        int256 below = int256(liq / 1e10) - 100; // 8-dec feed
        int256 above = int256(liq / 1e10) + 100;
        _setPrice(below * 10 / 10);
        _setPrice(below); // confirm round (deviation guard irrelevant for the raw venue feed)
        assertFalse(perp.isLiquidatable(alice));
        _setPrice(above);
        assertTrue(perp.isLiquidatable(alice));
    }

    function test_liquidation_withBadDebt_absorbedByInsurance() public {
        _short(90e18); // ~9x leverage
        _setPrice(3700e8); // +23% -> deeply underwater
        int256 eq = perp.accountEquity(alice);
        assertLt(eq, 0, "negative equity");
        uint256 insBefore = perp.insuranceFund();
        perp.liquidate(alice);
        IPerpMarket.Position memory p = perp.getPosition(alice);
        assertEq(p.size, 0);
        assertEq(p.margin, 0);
        IPerpMarket.AccountStats memory st = perp.getAccountStats(alice);
        assertGt(st.badDebt, 0);
        assertLe(perp.insuranceFund(), insBefore, "insurance drew down");
        _conservation();
    }

    function test_liquidate_revertsWhenHealthy() public {
        _short(10e18);
        vm.expectPartialRevert(MockPerpetualMarket.NotLiquidatable.selector);
        perp.liquidate(alice);
    }

    function test_adl_reducesPositionAtMark() public {
        _short(20e18);
        perp.simulateAdl(alice, 2500);
        assertEq(perp.getPosition(alice).size, -15e18);
        _conservation();
    }

    function test_fundingRateCap() public {
        vm.expectRevert(MockPerpetualMarket.FundingRateTooLarge.selector);
        perp.setFundingRate(0.02e18);
    }

    function testFuzz_conservation(uint256 qty, uint256 moveBps, uint256 dt) public {
        qty = bound(qty, 1e16, 90e18);
        moveBps = bound(moveBps, 8500, 11_500);
        dt = bound(dt, 0, 3 days);
        _short(qty);
        vm.warp(block.timestamp + dt);
        _setPrice(int256(3000e8 * moveBps / 10_000));
        if (perp.isLiquidatable(alice)) {
            perp.liquidate(alice);
        } else {
            vm.prank(alice);
            perp.trade(int256(qty), type(uint256).max);
        }
        _conservation();
    }
}
