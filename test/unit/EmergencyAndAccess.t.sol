// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Auth} from "../../contracts/access/Auth.sol";
import {Roles} from "../../contracts/access/Roles.sol";
import {EmergencyController} from "../../contracts/core/EmergencyController.sol";
import {IEmergencyController} from "../../contracts/interfaces/IEmergencyController.sol";
import {IRebalanceManager} from "../../contracts/interfaces/IRebalanceManager.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract EmergencyControllerTest is BaseTest {
    function test_guardianPauses_adminUnpauses() public {
        vm.prank(guardian);
        emergency.pauseDeposits();
        assertTrue(emergency.depositsPaused());

        vm.prank(guardian);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        emergency.unpauseDeposits();

        emergency.unpauseDeposits(); // admin
        assertFalse(emergency.depositsPaused());
    }

    function test_strategyPause_asymmetric() public {
        vm.prank(guardian);
        emergency.pauseStrategy();
        vm.prank(guardian);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        emergency.unpauseStrategy();
        emergency.unpauseStrategy();
        assertFalse(emergency.strategyPaused());
    }

    function test_breaker_onlyRiskManager() public {
        vm.prank(guardian);
        vm.expectRevert(EmergencyController.OnlyRiskManager.selector);
        emergency.tripCircuitBreaker(IEmergencyController.BreakerReason.MANUAL);
    }

    function test_emergencyUnwind_onlyGuardianOrAdmin_andTerminal() public {
        _bootstrap(100_000e6);
        vm.prank(keeper);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        emergency.emergencyUnwind(0, type(uint256).max);

        vm.prank(guardian);
        emergency.emergencyUnwind(2900e18, 3100e18);
        assertTrue(emergency.isShutdown());
        vm.expectRevert(EmergencyController.SystemShutdown.selector);
        emergency.unpauseDeposits();
        vm.expectRevert(EmergencyController.SystemShutdown.selector);
        emergency.unpauseStrategy();
    }

    /// The guardian has no path to move funds anywhere but the vault.
    function test_guardianCannotRedirectFunds() public {
        _bootstrap(100_000e6);
        uint256 guardianBefore = usdc.balanceOf(guardian);
        vm.prank(guardian);
        emergency.emergencyUnwind(2900e18, 3100e18);
        assertEq(usdc.balanceOf(guardian), guardianBefore);
        assertGt(usdc.balanceOf(address(vault)), 99_000e6);
    }

    function test_initialize_once() public {
        vm.expectRevert(EmergencyController.AlreadyInitialized.selector);
        emergency.initialize(strategy, address(riskManager));
    }
}

/// Every privileged entry point rejects an unprivileged caller.
contract AccessControlMatrixTest is BaseTest {
    address internal mallory = makeAddr("mallory");

    function test_unauthorizedCannotRebalance() public {
        _deposit(alice, 100_000e6);
        vm.startPrank(mallory);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.performUpkeep("");
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.observeVolatility();
        vm.stopPrank();
    }

    function test_unauthorizedCannotConfigure() public {
        // evaluate arguments *before* pranking: a view call inside the prank would consume expectRevert
        IRiskManager.RiskConfig memory rc = riskManager.config();
        IRebalanceManager.Params memory rp = rebalancer.params();
        IRebalanceManager.Targets memory rt = rebalancer.targets();
        vm.startPrank(mallory);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        feeManager.setFees(0, 0, 0);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        feeManager.setFeeRecipient(mallory);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        vault.setDepositCap(0);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        riskManager.setConfig(rc);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.setParams(rp);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.setTargets(rt);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        emergency.pauseDeposits();
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        emergency.pauseStrategy();
        vm.stopPrank();
    }

    function test_roleRotation_isOneTransaction() public {
        registry.revokeRole(Roles.KEEPER, keeper);
        _deposit(alice, 100_000e6);
        vm.prank(keeper);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.performUpkeep("");

        address newKeeper = makeAddr("newKeeper");
        registry.grantRole(Roles.KEEPER, newKeeper);
        vm.prank(newKeeper);
        rebalancer.performUpkeep("");
    }

    function test_adminIsNotAutomaticallyKeeper() public {
        _deposit(alice, 100_000e6);
        vm.expectPartialRevert(Auth.Unauthorized.selector);
        rebalancer.performUpkeep(""); // test contract is ADMIN, not KEEPER
    }
}
