// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Regression for a bug the TypeScript Monte Carlo surfaced: after a long ETH decline almost
///         all perp equity is *unrealised* profit on the short. Venues only release cash margin, so a
///         "withdraw excess margin" rebalance silently did nothing, leverage stayed low, and the
///         keeper re-fired a no-op rebalance every interval. The strategy now crystallises just enough
///         PnL (close + reopen a slice of the short) to free the cash.
contract DeepDeclineTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _bootstrap(100_000e6);
    }

    function test_deepDecline_marginIsReleased_noNoOpChurn() public {
        uint256 rebalances;
        // ETH -60% over 30 days, keeper checking every 4 hours
        for (uint256 day; day < 30; ++day) {
            _movePrice(-300); // ~ -3% per day
            for (uint256 k; k < 6; ++k) {
                _warp(4 hours);
                vm.prank(keeper);
                rebalancer.observeVolatility();
                if (_tryRebalance()) ++rebalances;
            }
        }
        Types.PositionSnapshot memory s = _snap();
        uint256 lev = positionManager.leverageBps(s);
        emit log_named_uint("rebalances", rebalances);
        emit log_named_uint("final leverage bps", lev);
        emit log_named_uint("perp cash margin", s.perpMargin);
        emit log_named_uint("perp equity", s.perpEquity);

        assertLt(_price(), 1300e18, "ETH fell ~60%");
        // every rebalance moved something: no hourly no-op loop (without the fix: ~one per tick)
        assertLt(rebalances, 40, "no churn");
        // leverage was actually brought back towards target, not stuck below the band
        assertGt(lev, 14_000, "margin released, book re-levered");
        assertLe(_abs(_deltaBps()), 200, "still delta neutral");
        Types.PnLBreakdown memory p = positionManager.pnl();
        assertApproxEqAbs(int256(p.strategyNav) - p.netCapital, p.netPnl, 200, "PnL still reconciles");
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
