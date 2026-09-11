// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Views must keep answering when venues break. ERC-4626 requires `totalAssets` never to revert,
///         and monitoring (risk engine, keeper, dashboard) is most needed exactly when a venue is down.
contract ResilienceTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _bootstrap(100_000e6);
        oracle.poke(address(weth)); // record a last good price
    }

    /// Both feeds revert with an open position: the perp venue can't price itself (its mark reads the
    /// same feed), the oracle is unhealthy. Views fall back to the last good price and local maths.
    function test_viewsSurviveDeadFeeds_withOpenPositions() public {
        uint256 navBefore = vault.totalAssets();
        feed.setShouldRevert(true);
        fallbackFeed.setShouldRevert(true);

        uint256 nav = vault.totalAssets(); // must not revert
        assertApproxEqRel(nav, navBefore, 0.001e18, "valued at last good price, within pending funding");

        Types.PositionSnapshot memory s = positionManager.snapshot();
        assertFalse(s.priceHealthy);
        assertEq(s.markPrice, s.price, "mark falls back to the last good oracle price");
        assertGt(s.perpEquity, 0);
        assertGt(s.liquidationPrice, s.markPrice, "liquidation price computed locally");

        // monitoring keeps working; state-changing share operations are blocked
        assertEq(uint256(riskManager.assess().state), uint256(Types.RiskState.HIGH_RISK));
        assertFalse(vault.isOperational());
        assertEq(vault.maxWithdraw(alice), 0);
        (, bool execute) = rebalancer.previewRebalance();
        assertFalse(execute, "no trading without a price");
        positionManager.pnl(); // attribution view also survives
    }

    /// Only the perp venue is broken (its feed returns garbage) while the protocol oracle is fine:
    /// the venue's own reads revert, the protocol values the hedge locally at the oracle price.
    function test_perpVenueUnreadable_protocolOracleHealthy() public {
        // point the protocol oracle at the fallback feed only, then break the primary (which the venue uses)
        feed.setShouldRevert(true);
        (, Types.OracleStatus st) = oracle.tryGetPrice(address(weth));
        assertEq(uint256(st), uint256(Types.OracleStatus.FALLBACK));
        uint256 nav = vault.totalAssets();
        assertGt(nav, 99_000e6, "hedge valued locally, NAV intact");
        assertTrue(vault.isOperational(), "fallback price is trustworthy");
        Types.PositionSnapshot memory s = positionManager.snapshot();
        assertEq(s.markPrice, s.price);
    }
}
