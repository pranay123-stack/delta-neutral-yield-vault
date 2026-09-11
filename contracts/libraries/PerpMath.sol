// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SignedMath as SignedMathAbs} from "@openzeppelin/contracts/utils/math/SignedMath.sol";

/// @title PerpMath
/// @notice Position arithmetic shared by the mock venue (execution-price accounting) and the
///         PerpAdapter (mark-price accounting), so both sides use identical formulas.
/// @dev Units: size qty18 (signed), prices price18, money usd6. qty18 * price18 / 1e30 = usd6.
library PerpMath {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant QTY_PRICE_TO_USD6 = 1e30;
    uint256 internal constant USD6_TO_USD18 = 1e12;
    uint256 internal constant BPS = 10_000;

    error ZeroPrice();

    function abs(int256 x) internal pure returns (uint256) {
        return SignedMathAbs.abs(x);
    }

    /// @dev sign(a) * floor(|a| * b / d) - rounds toward zero.
    function mulDivSigned(int256 a, uint256 b, uint256 d) internal pure returns (int256) {
        int256 r = Math.mulDiv(abs(a), b, d).toInt256();
        return a >= 0 ? r : -r;
    }

    /// @return usd6 notional of `size` at `price`
    function notional(int256 size, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(abs(size), price, QTY_PRICE_TO_USD6);
    }

    /// @return usd6 PnL of `size` opened at `entry`, marked at `price` (rounds toward zero)
    function pnl(int256 size, uint256 entry, uint256 price) internal pure returns (int256) {
        if (size == 0) return 0;
        if (price == entry) return 0;
        uint256 diff = price > entry ? price - entry : entry - price;
        int256 mag = Math.mulDiv(abs(size), diff, QTY_PRICE_TO_USD6).toInt256();
        return (size > 0) == (price > entry) ? mag : -mag;
    }

    /// @notice Apply a trade to a position with average-entry accounting.
    /// @return newSize resulting signed size
    /// @return newEntry resulting average entry (0 when flat)
    /// @return realized usd6 PnL realised by the reducing part of the trade
    function applyTrade(int256 size, uint256 entry, int256 delta, uint256 price)
        internal
        pure
        returns (int256 newSize, uint256 newEntry, int256 realized)
    {
        if (price == 0) revert ZeroPrice();
        newSize = size + delta;
        if (size == 0 || (size > 0) == (delta > 0)) {
            // opening or increasing: weighted average entry
            uint256 oldAbs = abs(size);
            uint256 addAbs = abs(delta);
            newEntry = newSize == 0 ? 0 : (oldAbs * entry + addAbs * price) / (oldAbs + addAbs);
            return (newSize, newEntry, 0);
        }
        // reducing, closing or flipping
        int256 closeQty = Math.min(abs(delta), abs(size)).toInt256();
        int256 closedSigned = size > 0 ? closeQty : -closeQty;
        realized = pnl(closedSigned, entry, price);
        if (newSize == 0) newEntry = 0;
        else if ((newSize > 0) == (size > 0)) newEntry = entry;
        else newEntry = price; // flipped: remainder opened at trade price
    }

    /// @notice Price at which equity == maintenance margin.
    /// @param size signed position size
    /// @param entry average entry price
    /// @param effectiveMargin margin + pending funding (usd6, signed)
    /// @param mmBps maintenance margin ratio in bps
    /// @return price18 liquidation price; 0 if flat or if a long can never be liquidated,
    ///         type(uint256).max never returned (a short with any margin has a finite liq price)
    /// @dev long:  M + s(P - E) = s*P*mm  =>  P = (s*E - M) / (s*(1 - mm))
    ///      short: M - s(P - E) = s*P*mm  =>  P = (M + s*E) / (s*(1 + mm))
    function liquidationPrice(int256 size, uint256 entry, int256 effectiveMargin, uint256 mmBps)
        internal
        pure
        returns (uint256)
    {
        if (size == 0) return 0;
        uint256 s = abs(size);
        // everything in 1e18 USD
        int256 entryNotional18 = Math.mulDiv(s, entry, 1e18).toInt256();
        int256 margin18 = effectiveMargin * USD6_TO_USD18.toInt256();
        if (size > 0) {
            int256 num = entryNotional18 - margin18;
            if (num <= 0) return 0;
            uint256 den = Math.mulDiv(s, BPS - mmBps, BPS);
            return Math.mulDiv(num.toUint256(), 1e18, den);
        } else {
            int256 num = entryNotional18 + margin18;
            if (num <= 0) return 0;
            uint256 den = Math.mulDiv(s, BPS + mmBps, BPS);
            return Math.mulDiv(num.toUint256(), 1e18, den);
        }
    }

    /// @return bps distance between `mark` and `liq`, type(uint256).max if no liquidation price
    function distanceBps(uint256 mark, uint256 liq, int256 size) internal pure returns (uint256) {
        if (size == 0 || mark == 0) return type(uint256).max;
        if (liq == 0) return size > 0 ? type(uint256).max : 0;
        // long is hurt by price falling to liq, short by price rising to liq
        if (size > 0) return liq >= mark ? 0 : Math.mulDiv(mark - liq, BPS, mark);
        return liq <= mark ? 0 : Math.mulDiv(liq - mark, BPS, mark);
    }
}
