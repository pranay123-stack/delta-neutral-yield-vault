// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PerpMath} from "../../contracts/libraries/PerpMath.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {ProtocolHandler} from "./handlers/ProtocolHandler.sol";

/// @notice Deterministic long random walk through the same handler the invariant suite uses, with
///         the core invariants asserted after *every* step. Complements the fuzzer: one very deep
///         sequence (3,000 steps, ~2 simulated months) instead of many shallow ones, and it reports
///         how much real activity (rebalances, liquidations, unwinds) the walk produced.
contract StressWalkTest is BaseTest {
    ProtocolHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new ProtocolHandler(
            vault,
            positionManager,
            rebalancer,
            riskManager,
            usdc,
            feed,
            fallbackFeed,
            lendingPool,
            perp,
            keeper,
            address(perpAdapter)
        );
        feed.transferOwnership(address(h));
        fallbackFeed.transferOwnership(address(h));
        perp.transferOwnership(address(h));
        lendingPool.transferOwnership(address(h));
        usdc.setMinter(address(h), true);
        _bootstrap(250_000e6);
    }

    function test_stressWalk_3000Steps() public {
        uint256 seed = 0xDE17A;
        for (uint256 i; i < 3000; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _step(seed);
            _checkInvariants();
        }
        emit log_named_uint("ops", h.ops());
        emit log_named_uint("rebalances executed", h.rebalances());
        emit log_named_uint("venue liquidations", h.liquidations());
        emit log_named_uint("max |delta| after rebalance (bps)", h.maxObservedPostRebalanceDeltaBps());
        emit log_named_uint("final TVL (usd6)", vault.totalAssets());
        assertGt(h.rebalances(), 50, "walk must exercise the rebalancer heavily");
    }

    /// Keeper mostly offline and ETH trending up in large steps: forces venue liquidations, bad debt
    /// and re-hedging from a naked long. Accounting must still reconcile after every step.
    function test_stressWalk_lazyKeeper_forcesLiquidations() public {
        uint256 seed = 0xBADC0DE;
        for (uint256 i; i < 1500; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 1000;
            uint256 b = seed >> 72;
            if (action < 350) h.movePrice(int256(b % 1600) - 500); // upward drift, steps up to +10%
            else if (action < 550) h.warp(1 hours + b % 12 hours);
            else if (action < 700) h.liquidate();
            else if (action < 705) h.rebalance(); // keeper almost never shows up
            else if (action < 850) h.deposit(seed >> 8, b);
            else if (action < 920) h.withdraw(seed >> 8, b);
            else if (action < 960) h.redeemWithUnwind(seed >> 8, b);
            else h.setFunding(int256(b % 0.0008e18) - 0.0004e18);
            _checkInvariants();
        }
        emit log_named_uint("venue liquidations", h.liquidations());
        emit log_named_uint("rebalances executed", h.rebalances());
        assertGt(h.liquidations(), 0, "lazy keeper must lead to liquidations");
    }

    function _step(uint256 s) internal {
        uint256 action = s % 100;
        uint256 a = s >> 8;
        uint256 b = s >> 72;
        if (action < 12) h.deposit(a, b);
        else if (action < 20) h.withdraw(a, b);
        else if (action < 26) h.redeem(a, b);
        else if (action < 30) h.redeemWithUnwind(a, b);
        else if (action < 45) h.movePrice(int256(b % 1200) - 600); // +/-6% steps
        else if (action < 50) h.setFunding(int256(b % 0.0008e18) - 0.0003e18);
        else if (action < 54) h.setUtilization(b, a % 2 == 0);
        else if (action < 72) h.warp(30 minutes + b % 6 hours);
        else if (action < 88) h.rebalance();
        else if (action < 91) h.accrueFees();
        else if (action < 94) h.checkpoint();
        else if (action < 96) h.liquidate();
        else if (action < 97) h.adl(b);
        else if (action < 99) h.observe();
        else h.unauthorizedRebalance(a);
    }

    function _checkInvariants() internal view {
        Types.PnLBreakdown memory p = positionManager.pnl();
        int256 residual = int256(p.strategyNav) - p.netCapital - p.netPnl;
        assertLe(PerpMath.abs(residual), h.ops() * 8 + 50, "pnl reconciles");
        assertEq(h.postRebalanceBreaches(), 0, "rebalance limits");
        assertEq(h.unauthorizedRebalanceSuccesses(), 0, "auth");
        assertEq(h.withdrawOverLiquiditySuccesses(), 0, "liquidity");
        assertEq(usdc.balanceOf(address(strategy)), 0, "no float");
    }
}
