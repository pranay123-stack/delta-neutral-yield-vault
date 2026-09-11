// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {PerpMath} from "./PerpMath.sol";
import {Types} from "./Types.sol";

/// @title DeltaCalculator
/// @notice Pure delta maths over a PositionSnapshot.
/// @dev Delta is expressed three ways:
///        - netDeltaQty: ETH units the portfolio is net long (+) or short (-)
///        - netDeltaUsd: that quantity valued at the oracle price
///        - deltaBps:    netDeltaUsd as a share of *total* NAV (vault idle included)
///      deltaBps is the number the risk limits and rebalance band are expressed in, because it is
///      what a depositor's share price is directly exposed to: a +200 bps delta means a 10% ETH move
///      changes the share price by ~0.2%.
///      Both legs are valued at the *oracle* price (not the perp mark) so a mark/index basis does
///      not masquerade as directional exposure.
library DeltaCalculator {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;

    function compute(Types.PositionSnapshot memory s, uint256 hedgeRatioBps)
        internal
        pure
        returns (Types.DeltaReport memory r)
    {
        uint256 shortQty = s.perpSize < 0 ? PerpMath.abs(s.perpSize) : 0;
        uint256 perpLongQty = s.perpSize > 0 ? s.perpSize.toUint256() : 0;
        uint256 grossLongQty = s.longQty + perpLongQty;

        r.longExposureUsd = Math.mulDiv(grossLongQty, s.price, PerpMath.QTY_PRICE_TO_USD6);
        r.shortExposureUsd = Math.mulDiv(shortQty, s.price, PerpMath.QTY_PRICE_TO_USD6);
        r.grossExposureUsd = r.longExposureUsd + r.shortExposureUsd;

        r.netDeltaQty = s.longQty.toInt256() + s.perpSize;
        r.netDeltaUsd = PerpMath.mulDivSigned(r.netDeltaQty, s.price, PerpMath.QTY_PRICE_TO_USD6);
        r.deltaBps = s.totalNav == 0 ? int256(0) : PerpMath.mulDivSigned(r.netDeltaUsd, BPS, s.totalNav);

        if (s.longQty > 0) r.hedgeRatioBps = Math.mulDiv(shortQty, BPS, s.longQty);
        else r.hedgeRatioBps = shortQty > 0 ? type(uint256).max : 0;

        r.targetPerpSize = -Math.mulDiv(s.longQty, hedgeRatioBps, BPS).toInt256();
        r.requiredPerpSizeChange = r.targetPerpSize - s.perpSize;
    }

    /// @notice Volatility-scaled tolerance band. Higher realised vol means a given delta produces
    ///         larger PnL swings, so the band tightens proportionally, floored at `minBandBps`.
    ///         band = baseBand * volRef / max(vol, volRef)
    function scaledBand(uint256 baseBandBps, uint256 volBps, uint256 volRefBps, uint256 minBandBps)
        internal
        pure
        returns (uint256)
    {
        if (volRefBps == 0 || volBps <= volRefBps) return baseBandBps;
        uint256 band = Math.mulDiv(baseBandBps, volRefBps, volBps);
        return band < minBandBps ? minBandBps : band;
    }

    function absDeltaBps(Types.DeltaReport memory r) internal pure returns (uint256) {
        return PerpMath.abs(r.deltaBps);
    }
}
