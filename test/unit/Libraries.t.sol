// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeltaCalculator} from "../../contracts/libraries/DeltaCalculator.sol";
import {PerpMath} from "../../contracts/libraries/PerpMath.sol";
import {Types} from "../../contracts/libraries/Types.sol";

contract PerpMathTest is Test {
    function test_pnl_longAndShort() public pure {
        assertEq(PerpMath.pnl(1e18, 3000e18, 3300e18), 300e6);
        assertEq(PerpMath.pnl(-1e18, 3000e18, 3300e18), -300e6);
        assertEq(PerpMath.pnl(-2e18, 3000e18, 2700e18), 600e6);
        assertEq(PerpMath.pnl(0, 3000e18, 1e18), 0);
    }

    function test_applyTrade_weightedEntry() public pure {
        (int256 s, uint256 e, int256 r) = PerpMath.applyTrade(-1e18, 3000e18, -1e18, 3200e18);
        assertEq(s, -2e18);
        assertEq(e, 3100e18);
        assertEq(r, 0);
    }

    function test_applyTrade_partialCloseKeepsEntry() public pure {
        (int256 s, uint256 e, int256 r) = PerpMath.applyTrade(-2e18, 3000e18, 1e18, 2800e18);
        assertEq(s, -1e18);
        assertEq(e, 3000e18);
        assertEq(r, 200e6);
    }

    function test_applyTrade_flip() public pure {
        (int256 s, uint256 e, int256 r) = PerpMath.applyTrade(-1e18, 3000e18, 3e18, 2900e18);
        assertEq(s, 2e18);
        assertEq(e, 2900e18);
        assertEq(r, 100e6);
    }

    /// Spec example: long at $3,000 with $700 margin on 1 ETH, MM 0 -> liq at $2,300 (23.3% away).
    function test_liquidationPrice_specExample() public pure {
        uint256 liq = PerpMath.liquidationPrice(1e18, 3000e18, 700e6, 0);
        assertEq(liq, 2300e18);
        assertEq(PerpMath.distanceBps(3000e18, liq, 1e18), 2333);
    }

    /// 2x short: liq = (M + sE) / (s(1+mm)) = (1500 + 3000) / 1.05 = 4285.71
    function test_liquidationPrice_short2x() public pure {
        uint256 liq = PerpMath.liquidationPrice(-1e18, 3000e18, 1500e6, 500);
        assertApproxEqAbs(liq, 4285.714285714285714285e18, 1e3);
        assertEq(PerpMath.distanceBps(3000e18, liq, -1e18), 4285);
    }

    /// Property: at the liquidation price, equity equals maintenance margin (within rounding).
    function testFuzz_liquidationPrice_isEquityEqualsMaintenance(uint256 qty, uint256 marginUsd, uint256 mm, bool isShort)
        public
        pure
    {
        qty = bound(qty, 1e16, 1000e18);
        mm = bound(mm, 100, 2000);
        uint256 entry = 3000e18;
        uint256 notional = qty * 3000 / 1e12; // usd6
        marginUsd = bound(marginUsd, notional / 20, notional * 2);
        int256 size = isShort ? -int256(qty) : int256(qty);
        uint256 liq = PerpMath.liquidationPrice(size, entry, int256(marginUsd), mm);
        if (liq == 0) return; // over-collateralised long can't be liquidated
        int256 equity = int256(marginUsd) + PerpMath.pnl(size, entry, liq);
        int256 maint = int256(PerpMath.notional(size, liq) * mm / 10_000);
        assertApproxEqAbs(equity, maint, notional / 1e6 + 2, "equity == MMR at liq price");
    }

    function testFuzz_applyTrade_realisedMatchesPnl(int256 size, int256 delta, uint256 price) public pure {
        size = int256(bound(size, -1000e18, 1000e18));
        delta = int256(bound(delta, -1000e18, 1000e18));
        price = bound(price, 100e18, 100_000e18);
        uint256 entry = 3000e18;
        if (size == 0) return;
        (, , int256 r) = PerpMath.applyTrade(size, entry, delta, price);
        bool reducing = (size > 0) != (delta > 0) && delta != 0;
        if (!reducing) {
            assertEq(r, 0);
            return;
        }
        uint256 closeQty = PerpMath.abs(delta) < PerpMath.abs(size) ? PerpMath.abs(delta) : PerpMath.abs(size);
        int256 closed = size > 0 ? int256(closeQty) : -int256(closeQty);
        assertEq(r, PerpMath.pnl(closed, entry, price));
    }
}

contract DeltaCalculatorTest is Test {
    function _snap(uint256 longQty, int256 perpSize, uint256 nav) internal pure returns (Types.PositionSnapshot memory s) {
        s.price = 3000e18;
        s.longQty = longQty;
        s.perpSize = perpSize;
        s.totalNav = nav;
    }

    /// Spec example: +10 ETH long, -9.8 ETH short -> net +0.2 ETH.
    function test_specExample() public pure {
        Types.DeltaReport memory r = DeltaCalculator.compute(_snap(10e18, -9.8e18, 50_000e6), 10_000);
        assertEq(r.netDeltaQty, 0.2e18);
        assertEq(r.netDeltaUsd, 600e6);
        assertEq(r.longExposureUsd, 30_000e6);
        assertEq(r.shortExposureUsd, 29_400e6);
        assertEq(r.grossExposureUsd, 59_400e6);
        assertEq(r.deltaBps, 120); // $600 / $50k
        assertEq(r.hedgeRatioBps, 9800);
        assertEq(r.targetPerpSize, -10e18);
        assertEq(r.requiredPerpSizeChange, -0.2e18, "sell 0.2 ETH more");
    }

    /// Spec example: $100k target hedge, $92k current -> +$8k short required.
    function test_specRebalanceExample() public pure {
        // long 100k/3000 ETH, short 92k/3000 ETH
        uint256 longQty = uint256(100_000e18) / 3000;
        int256 shortQty = -int256(uint256(92_000e18) / 3000);
        Types.DeltaReport memory r = DeltaCalculator.compute(_snap(longQty, shortQty, 200_000e6), 10_000);
        uint256 changeUsd = PerpMath.notional(r.requiredPerpSizeChange, 3000e18);
        assertApproxEqAbs(changeUsd, 8000e6, 1);
        assertLt(r.requiredPerpSizeChange, 0, "increase the short");
    }

    function test_scaledBand() public pure {
        assertEq(DeltaCalculator.scaledBand(200, 3000, 6000, 50), 200, "calm: base band");
        assertEq(DeltaCalculator.scaledBand(200, 12_000, 6000, 50), 100, "2x vol: half band");
        assertEq(DeltaCalculator.scaledBand(200, 60_000, 6000, 50), 50, "floored");
    }

    function testFuzz_perfectHedgeIsZeroDelta(uint256 qty, uint256 nav) public pure {
        qty = bound(qty, 0, 1e24);
        nav = bound(nav, 1, 1e15);
        Types.DeltaReport memory r = DeltaCalculator.compute(_snap(qty, -int256(qty), nav), 10_000);
        assertEq(r.netDeltaQty, 0);
        assertEq(r.deltaBps, 0);
        assertEq(r.requiredPerpSizeChange, 0);
    }
}
