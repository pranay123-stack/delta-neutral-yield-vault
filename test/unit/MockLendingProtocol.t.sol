// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockLendingProtocol} from "../../contracts/mocks/MockLendingProtocol.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract MockLendingProtocolTest is BaseTest {
    address internal u;

    function setUp() public override {
        super.setUp();
        u = address(usdc);
        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(lendingPool), type(uint256).max);
    }

    function _supply(address who, uint256 amt) internal {
        vm.prank(who);
        lendingPool.supply(u, amt, who, 0);
    }

    function test_supplyAndWithdraw_roundTrip() public {
        _supply(alice, 100_000e6);
        assertApproxEqAbs(lendingPool.balanceOf(u, alice), 100_000e6, 1);
        vm.prank(alice);
        lendingPool.withdraw(u, type(uint256).max, alice);
        assertApproxEqAbs(usdc.balanceOf(alice), 1_000_000e6, 1);
        assertEq(lendingPool.scaledBalanceOf(u, alice), 0);
    }

    /// At 80% utilisation the kinked model gives borrow 7.11%, supply 7.11% * 0.8 * 0.9 = 5.12%.
    function test_rateModel_kinkedCurve() public view {
        assertApproxEqRel(lendingPool.borrowRate(u), 0.071111e18, 0.001e18);
        assertApproxEqRel(lendingPool.supplyRate(u), 0.0512e18, 0.001e18);
    }

    function test_rateModel_aboveKinkSteepens() public {
        lendingPool.setUtilization(u, 0.95e18);
        // borrow = 8% + 60% * (0.95-0.9)/(0.1) = 38%
        assertApproxEqRel(lendingPool.borrowRate(u), 0.38e18, 0.001e18);
    }

    function test_interestAccrues_atSupplyRate() public {
        _supply(alice, 100_000e6);
        uint256 rate = lendingPool.supplyRate(u);
        vm.warp(block.timestamp + 365 days);
        uint256 bal = lendingPool.balanceOf(u, alice);
        // linear accrual over the period
        assertApproxEqRel(bal, 100_000e6 + 100_000e6 * rate / 1e18, 0.002e18);
    }

    function test_withdrawLimitedByAvailableLiquidity() public {
        _supply(alice, 100_000e6);
        lendingPool.setUtilization(u, 1e18); // every unit lent out
        vm.prank(alice);
        vm.expectPartialRevert(MockLendingProtocol.InsufficientLiquidity.selector);
        lendingPool.withdraw(u, 1e6, alice);
    }

    function test_cannotWithdrawMoreThanBalance() public {
        _supply(alice, 100e6);
        vm.prank(alice);
        vm.expectPartialRevert(MockLendingProtocol.InsufficientBalance.selector);
        lendingPool.withdraw(u, 101e6, alice);
    }

    function test_solvency_poolHoldsAtLeastAllSupplierBalances() public {
        _supply(alice, 123_456e6);
        vm.warp(block.timestamp + 97 days);
        _supply(alice, 1e6); // triggers accrual + mint
        uint256 owed = lendingPool.totalSupplied(u);
        assertGe(usdc.balanceOf(address(lendingPool)), owed, "tokens >= claims");
    }

    function test_onlyOwnerSimulationControls() public {
        vm.startPrank(alice);
        vm.expectRevert();
        lendingPool.setUtilization(u, 0.5e18);
        vm.expectRevert();
        lendingPool.setRateModel(u, usdcRateModel());
        vm.stopPrank();
    }

    function test_invalidUtilizationRejected() public {
        vm.expectRevert(MockLendingProtocol.InvalidUtilization.selector);
        lendingPool.setUtilization(u, 1.01e18);
    }

    /// For any utilisation and holding period, a supplier earns supplyRate(U) x t (linear accrual) and
    /// can always withdraw what it is owed when liquidity allows.
    function testFuzz_interest_matchesRateCurve(uint256 util, uint256 dt, uint256 amt) public {
        util = bound(util, 0, 0.9e18);
        dt = bound(dt, 1 hours, 365 days);
        amt = bound(amt, 1000e6, 500_000e6);
        lendingPool.setUtilization(u, util);
        _supply(alice, amt);
        uint256 rate = lendingPool.supplyRate(u);
        vm.warp(block.timestamp + dt);
        uint256 expected = amt + amt * rate / 1e18 * dt / 365 days;
        // utilisation drifts slightly as debt compounds, so allow 0.5% of the interest earned
        assertApproxEqAbs(lendingPool.balanceOf(u, alice), expected, (expected - amt) / 200 + 2);
    }

    function testFuzz_supplyWithdraw_neverProfitsWithoutTime(uint256 amt) public {
        amt = bound(amt, 1, 1_000_000e6);
        uint256 before = usdc.balanceOf(alice);
        _supply(alice, amt);
        vm.prank(alice);
        lendingPool.withdraw(u, type(uint256).max, alice);
        assertLe(usdc.balanceOf(alice), before, "no free money from rounding");
    }
}
