// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../utils/BaseTest.sol";

/// @notice try/catch fallbacks must not be reachable by choosing a gas limit.
/// @dev The valuation path wraps venue/oracle reads in try/catch with fallbacks (last-good price,
///      local equity maths). If a caller could starve the inner call - EIP-150 forwards only 63/64 of the
///      remaining gas - and still have enough left to finish, execution would silently take the fallback
///      and price shares off a different NAV. These scans try every gas limit in a window: any call that
///      *succeeds* must return exactly what it returns with unlimited gas. They pass with and without
///      GasGuard today (no reachable window: see GasGuard.sol); they exist so a future, more expensive
///      venue integration that opens such a window fails CI.
contract GasGriefingTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _bootstrap(100_000e6);
        _warp(3 days); // pending funding + a stale last-good price make the fallbacks *differ* from truth
        _movePrice(400);
    }

    function test_totalAssets_neverPricedOffFallbackPath() public view {
        uint256 truth = vault.totalAssets();
        uint256 successes;
        for (uint256 g = 20_000; g < 260_000; g += 250) {
            (bool ok, bytes memory ret) = address(vault).staticcall{gas: g}(abi.encodeCall(vault.totalAssets, ()));
            if (!ok) continue;
            ++successes;
            assertEq(abi.decode(ret, (uint256)), truth, "a starved call produced a different NAV");
        }
        assertGt(successes, 0, "scan reached the full-gas region");
    }

    function test_deposit_sharesIndependentOfGasLimit() public {
        _fund(bob, 1_000_000e6);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        uint256 truth = vault.deposit(10_000e6, bob);
        vm.revertToState(snap);

        uint256 successes;
        for (uint256 g = 150_000; g < 420_000; g += 500) {
            vm.prank(bob);
            (bool ok, bytes memory ret) = address(vault).call{gas: g}(abi.encodeCall(vault.deposit, (10_000e6, bob)));
            if (ok) {
                ++successes;
                assertEq(abi.decode(ret, (uint256)), truth, "gas limit changed the shares minted");
            }
            vm.revertToState(snap);
        }
        assertGt(successes, 0, "scan reached the full-gas region");
    }
}
