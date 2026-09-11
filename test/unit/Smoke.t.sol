// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice End-to-end happy path: deposit -> deploy -> delta ~ 0 -> accrue -> withdraw.
contract SmokeTest is BaseTest {
    function test_bootstrap_opensDeltaNeutralBasis() public {
        _bootstrap(100_000e6);
        Types.PositionSnapshot memory s = _snap();
        emit log_named_uint("nav", s.totalNav);
        emit log_named_uint("reserve", s.reserveAssets);
        emit log_named_uint("longValue", s.longValue);
        emit log_named_uint("perpEquity", s.perpEquity);
        emit log_named_int("perpSize", s.perpSize);
        emit log_named_uint("longQty", s.longQty);
        emit log_named_int("deltaBps", _deltaBps());
        emit log_named_uint("leverageBps", _leverageBps());
        assertApproxEqAbs(_deltaBps(), 0, 5, "delta ~ 0");
        _assertApproxRel(_leverageBps(), 20_000, 200, "2x leverage");
        _assertApproxRel(s.longValue, 60_000e6, 100, "60% long");
        _assertApproxRel(s.reserveAssets, 10_000e6, 300, "10% reserve");
    }

    function test_pnl_reconcilesAfterBootstrapAndTime() public {
        _bootstrap(100_000e6);
        _warpSteps(7 days, 28);
        Types.PnLBreakdown memory p = positionManager.pnl();
        int256 residual = int256(p.strategyNav) - p.netCapital - p.netPnl;
        emit log_named_int("netPnl", p.netPnl);
        emit log_named_int("funding", p.fundingIncome);
        emit log_named_int("lendingUsdc", p.lendingIncomeUsdc);
        emit log_named_int("lendingWeth", p.lendingIncomeWeth);
        emit log_named_int("fees", p.tradingFees);
        emit log_named_int("slippage", p.slippage);
        emit log_named_int("residual", residual);
        assertApproxEqAbs(residual, 0, 20, "PnL must reconcile to NAV");
        assertGt(p.fundingIncome, 0, "short receives positive funding");
    }
}
