// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRebalanceManager} from "../../contracts/interfaces/IRebalanceManager.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Gas benchmarks for docs/gas-report.md. Each test measures one user- or keeper-facing
///         operation against a *running* book (positions open, fees on, storage warm), which is what
///         real users pay - not the cheaper empty-vault case.
contract GasBenchmarksTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _bootstrap(1_000_000e6);
        _warp(2 hours);
        _fund(bob, 10_000_000e6);
        vm.prank(bob);
        vault.deposit(100_000e6, bob); // bob holds shares so exits are measurable
        _warp(1 hours);
    }

    function _measure(string memory label, uint256 g) internal {
        emit log_named_uint(label, g);
    }

    function test_gas_deposit() public {
        vm.prank(bob);
        uint256 g = gasleft();
        vault.deposit(10_000e6, bob);
        _measure("deposit", g - gasleft());
    }

    function test_gas_mint() public {
        vm.prank(bob);
        uint256 g = gasleft();
        vault.mint(10_000e12, bob);
        _measure("mint", g - gasleft());
    }

    function test_gas_withdraw_fromIdle() public {
        vm.prank(bob);
        uint256 g = gasleft();
        vault.withdraw(10_000e6, bob, bob);
        _measure("withdraw (idle)", g - gasleft());
    }

    function test_gas_withdraw_fromReserve() public {
        vm.prank(keeper);
        rebalancer.performUpkeep(""); // sweeps bob's idle deposit into the lending reserve
        vm.prank(bob);
        uint256 g = gasleft();
        vault.withdraw(10_000e6, bob, bob);
        _measure("withdraw (pulls lending reserve)", g - gasleft());
    }

    function test_gas_redeem() public {
        uint256 shares = vault.balanceOf(bob) / 10;
        vm.prank(bob);
        uint256 g = gasleft();
        vault.redeem(shares, bob, bob);
        _measure("redeem", g - gasleft());
    }

    function test_gas_redeemWithUnwind() public {
        uint256 shares = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        uint256 g = gasleft();
        vault.redeemWithUnwind(shares, alice, alice, 0);
        _measure("redeemWithUnwind (trades 3 venues)", g - gasleft());
    }

    function test_gas_rebalance_deploy() public {
        vm.prank(keeper);
        uint256 g = gasleft();
        rebalancer.performUpkeep("");
        _measure("rebalance (sweep + buy + hedge)", g - gasleft());
    }

    function test_gas_rebalance_priceMove() public {
        vm.prank(keeper);
        rebalancer.performUpkeep(""); // deploy bob's deposit first
        _movePrice(1000);
        _warp(1 days);
        vm.prank(keeper);
        uint256 g = gasleft();
        rebalancer.performUpkeep("");
        _measure("rebalance (sell + margin + re-hedge)", g - gasleft());
    }

    function test_gas_checkUpkeep() public view {
        uint256 g = gasleft();
        rebalancer.checkUpkeep("");
        g -= gasleft();
        console_log("checkUpkeep (view)", g);
    }

    function test_gas_strategyUpdate() public {
        IRebalanceManager.Targets memory t = rebalancer.targets();
        t.targetLeverageBps = 18_000;
        vm.prank(strategist);
        uint256 g = gasleft();
        rebalancer.setTargets(t);
        _measure("strategy update (setTargets)", g - gasleft());
    }

    function test_gas_feeCollection() public {
        _warp(7 days);
        uint256 g = gasleft();
        vault.accrueFees();
        _measure("fee collection (accrueFees)", g - gasleft());
    }

    function test_gas_riskCheckpoint() public {
        vm.prank(keeper);
        uint256 g = gasleft();
        riskManager.checkpoint();
        _measure("risk checkpoint", g - gasleft());
    }

    function test_gas_totalAssets() public view {
        uint256 g = gasleft();
        vault.totalAssets();
        g -= gasleft();
        console_log("totalAssets (view)", g);
    }

    function console_log(string memory, uint256) internal pure {}
}
