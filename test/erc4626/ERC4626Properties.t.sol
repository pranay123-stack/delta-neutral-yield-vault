// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626Test} from "erc4626-tests/ERC4626.test.sol";

import {BaseTest} from "../utils/BaseTest.sol";

/// @notice a16z's ERC-4626 property suite (github.com/a16z/erc4626-tests) run against the vault
///         *with fees switched on*, which exercises the fee-aware conversion maths: every preview must
///         still match execution when a performance fee is pending on the yield the suite injects.
contract ERC4626PropertiesTest is BaseTest, ERC4626Test {
    function setUp() public override(BaseTest, ERC4626Test) {
        BaseTest.setUp();
        _underlying_ = address(usdc);
        _vault_ = address(vault);
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }

    /// Bound the suite's raw fuzz inputs to the deposit cap so runs aren't discarded wholesale.
    function setUpVault(Init memory init) public override {
        for (uint256 i; i < N; ++i) {
            // the fuzzer seeds addresses from state; the fee recipient's balance legitimately changes
            // on every accrual, so it can't play a "user" in balance-delta properties
            vm.assume(init.user[i] != feeRecipient);
            init.share[i] = bound(init.share[i], 0, 1_000_000e6);
            init.asset[i] = bound(init.asset[i], 0, 1_000_000e6);
        }
        init.yield = bound(init.yield, -int256(100_000e6), int256(100_000e6));
        super.setUpVault(init);
    }

    /// Gains are donated; losses are applied by reducing the vault's idle balance (MockERC20 has no burn).
    function setUpYield(Init memory init) public override {
        if (init.yield >= 0) {
            usdc.mint(address(vault), uint256(init.yield));
        } else {
            uint256 bal = usdc.balanceOf(address(vault));
            uint256 loss = uint256(-init.yield);
            vm.assume(loss <= bal);
            deal(address(usdc), address(vault), bal - loss);
        }
    }
}
