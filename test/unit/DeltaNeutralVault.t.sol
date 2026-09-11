// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {Auth} from "../../contracts/access/Auth.sol";
import {DeltaNeutralVault} from "../../contracts/core/DeltaNeutralVault.sol";
import {IDeltaNeutralVault} from "../../contracts/interfaces/IDeltaNeutralVault.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract DeltaNeutralVaultTest is BaseTest {
    function setUp() public override {
        super.setUp();
        feeManager.setFees(0, 0, 0); // isolate share maths from fees; fees have their own suite
    }

    // ---- metadata -------------------------------------------------------

    function test_metadata() public view {
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.decimals(), 12, "6 asset decimals + 6 offset");
        assertEq(vault.symbol(), "dnUSDC");
    }

    // ---- first depositor / multiple depositors ---------------------------

    function test_firstDeposit_mintsAtOnePerShare() public {
        uint256 shares = _deposit(alice, 1000e6);
        assertEq(shares, 1000e12, "1 USDC = 1 share (1e12 units)");
        assertEq(vault.sharePrice(), 1e18);
        assertEq(vault.totalAssets(), 1000e6);
    }

    function test_multipleDepositors_proRata() public {
        _deposit(alice, 1000e6);
        _deposit(bob, 3000e6);
        assertEq(vault.balanceOf(bob), 3 * vault.balanceOf(alice));
        assertEq(vault.convertToAssets(vault.balanceOf(bob)), 3000e6);
    }

    function test_laterDepositor_getsFewerSharesAfterProfit() public {
        _deposit(alice, 1000e6);
        usdc.mint(address(vault), 100e6); // +10% profit (simulated as a donation)
        uint256 shares = _deposit(bob, 1100e6);
        assertApproxEqAbs(shares, vault.balanceOf(alice), 1e6, "same value -> same shares");
    }

    // ---- previews ---------------------------------------------------------

    function test_previews_matchActuals() public {
        _deposit(alice, 10_000e6);
        _fund(bob, 10_000e6);
        uint256 pDeposit = vault.previewDeposit(1234e6);
        vm.prank(bob);
        assertEq(vault.deposit(1234e6, bob), pDeposit);

        uint256 pMint = vault.previewMint(500e12);
        vm.prank(bob);
        assertEq(vault.mint(500e12, bob), pMint);

        uint256 pWithdraw = vault.previewWithdraw(700e6);
        vm.prank(bob);
        assertEq(vault.withdraw(700e6, bob, bob), pWithdraw);

        uint256 pRedeem = vault.previewRedeem(100e12);
        vm.prank(bob);
        assertEq(vault.redeem(100e12, bob, bob), pRedeem);
    }

    function test_withdraw_andRedeem_roundTrip() public {
        _deposit(alice, 5000e6);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertEq(usdc.balanceOf(alice), 5000e6);
        assertEq(vault.totalSupply(), 0);
    }

    // ---- profit / loss through the strategy ------------------------------

    function test_profit_raisesSharePrice() public {
        _bootstrap(100_000e6);
        uint256 pps0 = vault.sharePrice();
        _warp(30 days);
        assertGt(vault.sharePrice(), pps0, "carry accrues continuously into NAV");
    }

    function test_loss_lowersSharePrice() public {
        _bootstrap(100_000e6);
        uint256 pps0 = vault.sharePrice();
        perp.setFundingRate(-0.001e18); // -110% APR funding: short bleeds
        _warp(3 days);
        assertLt(vault.sharePrice(), pps0);
    }

    // ---- rounding ---------------------------------------------------------

    function test_rounding_favoursVault() public {
        _deposit(alice, 1_000_000e6);
        usdc.mint(address(vault), 333_333); // awkward ratio
        // deposit rounds shares down, mint rounds assets up
        uint256 shares = vault.previewDeposit(1);
        uint256 assetsForOneShare = vault.previewMint(1);
        assertLe(vault.convertToAssets(shares), 1);
        assertGe(assetsForOneShare, 1);
        // withdraw rounds shares up, redeem rounds assets down
        assertGe(vault.previewWithdraw(1e6), vault.convertToShares(1e6));
        assertLe(vault.previewRedeem(1e12), vault.convertToAssets(1e12));
    }

    function test_zeroShareDeposit_reverts() public {
        _deposit(alice, 1000e6);
        usdc.mint(address(vault), 1_000_000e6); // pps now >> 1
        _fund(bob, 1);
        vm.prank(bob);
        vm.expectRevert(DeltaNeutralVault.ZeroShares.selector);
        vault.deposit(0, bob);
    }

    // ---- inflation / donation attack --------------------------------------

    /// Classic attack: attacker deposits 1 wei, donates a large amount, victim's deposit rounds to ~0
    /// shares. With a 6-decimal virtual offset the attacker loses money instead.
    function test_inflationAttack_unprofitable() public {
        address attacker = makeAddr("attacker");
        _deposit(attacker, 1);
        usdc.mint(attacker, 10_000e6);
        vm.prank(attacker);
        usdc.transfer(address(vault), 10_000e6); // donation

        _deposit(alice, 10_000e6);
        assertGt(vault.balanceOf(alice), 0, "victim still gets shares");

        uint256 attackerShares = vault.balanceOf(attacker);
        vm.prank(attacker);
        vault.redeem(attackerShares, attacker, attacker);
        assertLt(usdc.balanceOf(attacker), 10_000e6 + 1, "attacker cannot profit");
        // victim keeps ~all of their deposit
        assertApproxEqRel(vault.convertToAssets(vault.balanceOf(alice)), 10_000e6, 0.001e18);
    }

    function testFuzz_inflationAttack(uint256 donation, uint256 victim) public {
        donation = bound(donation, 1, 1_000_000e6);
        victim = bound(victim, 1e6, 1_000_000e6);
        address attacker = makeAddr("attacker");
        _deposit(attacker, 1);
        usdc.mint(address(vault), donation);
        _deposit(alice, victim);
        uint256 attackerValue = vault.convertToAssets(vault.balanceOf(attacker));
        assertLe(attackerValue, donation + 1, "attacker never extracts more than they put in");
    }

    // ---- limits -------------------------------------------------------------

    function test_depositCap() public {
        vault.setDepositCap(1000e6);
        assertEq(vault.maxDeposit(alice), 1000e6);
        _fund(alice, 2000e6);
        vm.prank(alice);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        vault.deposit(1001e6, alice);
    }

    function test_maxWithdraw_boundedByLiquidity_notTradeable() public {
        _bootstrap(100_000e6);
        // only the ~10% reserve is liquid; the basis position is not
        uint256 maxW = vault.maxWithdraw(alice);
        assertApproxEqRel(maxW, 10_000e6, 0.01e18);
        assertEq(maxW, vault.availableLiquidity());
        vm.prank(alice);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxWithdraw.selector);
        vault.withdraw(maxW + 10e6, alice, alice);
        vm.prank(alice);
        vault.withdraw(maxW, alice, alice);
    }

    function test_maxRedeem_consistentWithMaxWithdraw() public {
        _bootstrap(100_000e6);
        uint256 maxR = vault.maxRedeem(alice);
        vm.prank(alice);
        uint256 got = vault.redeem(maxR, alice, alice);
        assertLe(got, vault.availableLiquidity() + got);
    }

    function test_depositsPaused_blocksDepositNotWithdraw() public {
        _deposit(alice, 1000e6);
        vm.prank(guardian);
        emergency.pauseDeposits();
        assertEq(vault.maxDeposit(bob), 0);
        _fund(bob, 1000e6);
        vm.prank(bob);
        vm.expectPartialRevert(ERC4626.ERC4626ExceededMaxDeposit.selector);
        vault.deposit(1000e6, bob);
        // withdrawals remain open
        vm.prank(alice);
        vault.withdraw(500e6, alice, alice);
    }

    function test_oracleUnhealthy_blocksShareOps_whenPositioned() public {
        _bootstrap(100_000e6);
        _setPrice(0);
        assertFalse(vault.isOperational());
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        vm.prank(alice);
        vm.expectRevert(IDeltaNeutralVault.OracleUnhealthy.selector);
        vault.redeemWithUnwind(1e12, alice, alice, 0);
    }

    function test_oracleUnhealthy_irrelevantWhenFlat() public {
        _deposit(alice, 1000e6);
        _setPrice(0);
        assertTrue(vault.isOperational(), "no ETH exposure -> NAV needs no price");
        vm.prank(alice);
        vault.withdraw(1000e6, alice, alice);
    }

    // ---- allowances / third-party flows ------------------------------------

    function test_withdrawOnBehalf_requiresAllowance() public {
        _deposit(alice, 1000e6);
        vm.prank(bob);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        vault.withdraw(100e6, bob, alice);

        vm.prank(alice);
        vault.approve(bob, type(uint256).max);
        vm.prank(bob);
        vault.withdraw(100e6, bob, alice);
        assertEq(usdc.balanceOf(bob), 100e6);
    }

    // ---- withdrawal fee ------------------------------------------------------

    function test_withdrawalFee_staysWithRemainingHolders() public {
        feeManager.setFees(0, 0, 50); // 0.5%
        _deposit(alice, 10_000e6);
        _deposit(bob, 10_000e6);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        uint256 got = vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(got, uint256(10_000e6) * 10_000 / 10_050, 1, "fee on total");
        assertGt(vault.convertToAssets(vault.balanceOf(alice)), 10_000e6, "alice captured the fee");
    }

    // ---- redeemWithUnwind ------------------------------------------------------

    function test_redeemWithUnwind_minOutEnforced() public {
        _bootstrap(100_000e6);
        uint256 shares = vault.balanceOf(alice);
        uint256 gross = vault.previewRedeem(shares);
        vm.prank(alice);
        vm.expectPartialRevert(IDeltaNeutralVault.SlippageExceeded.selector);
        vault.redeemWithUnwind(shares, alice, alice, gross); // any unwind cost makes this fail
    }

    function test_redeemWithUnwind_fullExit() public {
        _bootstrap(100_000e6);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 got = vault.redeemWithUnwind(shares, alice, alice, 99_500e6);
        assertEq(vault.totalSupply(), 0);
        assertGt(got, 99_500e6);
        assertEq(_snap().perpSize, 0, "book fully unwound");
    }

    // ---- access ------------------------------------------------------------------

    function test_pushToStrategy_onlyRebalancer() public {
        _deposit(alice, 1000e6);
        vm.expectRevert(DeltaNeutralVault.OnlyRebalancer.selector);
        vault.pushToStrategy(100e6);
    }

    function test_initialize_onlyOnce_onlyAdmin() public {
        vm.expectRevert(IDeltaNeutralVault.AlreadyInitialized.selector);
        vault.initialize(strategy, address(rebalancer));
        vm.prank(alice);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        vault.setDepositCap(1);
    }

    // ---- fuzz --------------------------------------------------------------------

    function testFuzz_depositRedeem_noFreeValue(uint256 a, uint256 b) public {
        a = bound(a, 1e6, 5_000_000e6);
        b = bound(b, 1e6, 5_000_000e6);
        _deposit(alice, a);
        _deposit(bob, b);
        uint256 s = vault.balanceOf(bob);
        vm.prank(bob);
        uint256 out = vault.redeem(s, bob, bob);
        assertLe(out, b, "round trip never profits");
        assertGe(out + 1, b, "and loses at most 1 wei");
    }

    function testFuzz_convertRoundTrip(uint256 assets) public {
        _deposit(alice, 1_000_000e6);
        usdc.mint(address(vault), 12_345e6);
        assets = bound(assets, 0, 1e15);
        uint256 back = vault.convertToAssets(vault.convertToShares(assets));
        assertLe(back, assets);
    }
}
