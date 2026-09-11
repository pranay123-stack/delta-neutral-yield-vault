// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {FeeManager} from "../../contracts/core/FeeManager.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract FeeManagerTest is BaseTest {
    function _valueOf(address who) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(who));
    }

    /// 0.5%/yr management fee on a flat vault: after a year the recipient owns ~0.5% of assets.
    function test_managementFee_isHalfPercentPerYear() public {
        feeManager.setFees(50, 0, 0);
        _deposit(alice, 1_000_000e6);
        _warp(365 days);
        vault.accrueFees();
        assertApproxEqRel(_valueOf(feeRecipient), 5000e6, 0.001e18);
        assertApproxEqRel(_valueOf(alice), 995_000e6, 0.001e18);
    }

    /// Accruing daily vs once a year gives the same result (fee is time-linear on AUM).
    function test_managementFee_pathIndependent() public {
        feeManager.setFees(50, 0, 0);
        _deposit(alice, 1_000_000e6);
        for (uint256 i; i < 365; ++i) {
            _warp(1 days);
            vault.accrueFees();
        }
        // compounding the dilution daily is ~identical to one annual accrual
        assertApproxEqRel(_valueOf(feeRecipient), 5000e6, 0.01e18);
    }

    function test_performanceFee_onlyOnGains() public {
        feeManager.setFees(0, 1000, 0);
        _deposit(alice, 100_000e6);
        vault.accrueFees();
        usdc.mint(address(vault), 10_000e6); // +10% gain
        vault.accrueFees();
        assertApproxEqRel(_valueOf(feeRecipient), 1000e6, 0.001e18, "10% of $10k gain");
    }

    function test_performanceFee_highWaterMark_noFeeOnRecovery() public {
        feeManager.setFees(0, 1000, 0);
        _deposit(alice, 100_000e6);
        vault.accrueFees();
        uint256 hwm0 = feeManager.highWaterMark();

        // loss of 10% (simulate by burning vault USDC - transfer out as the test/admin can't; use a
        // strategy loss instead: deposit, deploy, bleed funding)
        _rebalance();
        perp.setFundingRate(-0.001e18);
        _warp(2 days);
        vault.accrueFees();
        assertEq(feeManager.highWaterMark(), hwm0, "HWM unchanged after loss");
        assertEq(vault.balanceOf(feeRecipient), 0, "no fee on a loss");

        // partial recovery below HWM: still no fee
        perp.setFundingRate(0.0005e18);
        _warp(1 days);
        vault.accrueFees();
        if (vault.sharePrice() < hwm0 * 1e6) assertEq(vault.balanceOf(feeRecipient), 0);
    }

    function test_feeCaps_enforced() public {
        vm.expectRevert(FeeManager.FeeTooHigh.selector);
        feeManager.setFees(201, 0, 0);
        vm.expectRevert(FeeManager.FeeTooHigh.selector);
        feeManager.setFees(0, 2001, 0);
        vm.expectRevert(FeeManager.FeeTooHigh.selector);
        feeManager.setFees(0, 0, 101);
    }

    function test_onlyAdminConfigures_onlyVaultAccrues() public {
        vm.prank(alice);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        feeManager.setFees(0, 0, 0);
        vm.expectRevert(FeeManager.OnlyVault.selector);
        feeManager.accrue(1, 1);
    }

    function test_previewIncludesPendingFees() public {
        feeManager.setFees(200, 0, 0);
        _deposit(alice, 1_000_000e6);
        _warp(180 days);
        uint256 previewBefore = vault.previewRedeem(vault.balanceOf(alice));
        vault.accrueFees();
        uint256 previewAfter = vault.previewRedeem(vault.balanceOf(alice));
        assertApproxEqAbs(previewBefore, previewAfter, 2, "accrual doesn't jump the share price");
    }

    function test_feeAssetsTracked() public {
        feeManager.setFees(50, 1000, 0);
        _deposit(alice, 1_000_000e6);
        _warp(365 days);
        usdc.mint(address(vault), 100_000e6);
        uint256 aumAtAccrual = vault.totalAssets();
        vault.accrueFees();
        // management fee is charged on AUM *at accrual time* (here 1.1M, gain included); frequent
        // accrual on every deposit/withdraw/keeper tick makes this effectively time-weighted
        assertApproxEqRel(feeManager.totalManagementFeesAssets(), aumAtAccrual * 50 / 10_000, 0.02e18);
        // performance fee is charged on the gain *net of* the management fee (mgmt dilution first):
        // gain = 1.1M - 1.0M * 1.005 = 95k  ->  10% = 9.5k
        assertApproxEqRel(feeManager.totalPerformanceFeesAssets(), 9500e6, 0.01e18, "10% of net gain");
    }

    function testFuzz_feesNeverExceedConfiguredShare(uint256 dt, uint256 gainBps) public {
        dt = bound(dt, 1, 5 * 365 days);
        gainBps = bound(gainBps, 0, 20_000);
        feeManager.setFees(200, 2000, 0);
        _deposit(alice, 1_000_000e6);
        vault.accrueFees();
        _warp(dt);
        usdc.mint(address(vault), 1_000_000e6 * gainBps / 10_000);
        uint256 total = vault.totalAssets();
        vault.accrueFees();
        uint256 feeValue = _valueOf(feeRecipient);
        // mgmt <= 2%/yr * t on AUM, perf <= 20% of gain
        uint256 maxMgmt = total * 200 * dt / (10_000 * 365 days) + 1;
        uint256 maxPerf = 1_000_000e6 * gainBps / 10_000 * 2000 / 10_000 + 1;
        assertLe(feeValue, maxMgmt + maxPerf + 10, "fees bounded by caps");
    }
}
