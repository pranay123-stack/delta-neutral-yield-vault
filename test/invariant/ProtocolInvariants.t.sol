// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPerpMarket} from "../../contracts/interfaces/external/IPerpMarket.sol";
import {PerpMath} from "../../contracts/libraries/PerpMath.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {ProtocolHandler} from "./handlers/ProtocolHandler.sol";

/// @notice System-wide invariants under random user, market, keeper and attacker sequences.
/// @dev Accounting convention being checked (docs/pnl-accounting.md):
///        vault.totalAssets = vault idle + strategy NAV
///        strategy NAV      = float + USDC reserve + WETH value + max(perp equity, 0)
///        strategy NAV - net capital from the vault == attributed PnL (every line accounted)
contract ProtocolInvariantsTest is BaseTest {
    ProtocolHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ProtocolHandler(
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
        // the handler plays "the market": give it simulation control of the mocks
        feed.transferOwnership(address(handler));
        fallbackFeed.transferOwnership(address(handler));
        perp.transferOwnership(address(handler));
        lendingPool.transferOwnership(address(handler));
        usdc.setMinter(address(handler), true);

        // seed a running book so every sequence starts from a realistic state
        _bootstrap(250_000e6);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.redeem.selector;
        selectors[3] = handler.redeemWithUnwind.selector;
        selectors[4] = handler.withdrawOverLimit.selector;
        selectors[5] = handler.movePrice.selector;
        selectors[6] = handler.setFunding.selector;
        selectors[7] = handler.setUtilization.selector;
        selectors[8] = handler.warp.selector;
        selectors[9] = handler.rebalance.selector;
        selectors[10] = handler.observe.selector;
        selectors[11] = handler.accrueFees.selector;
        selectors[12] = handler.checkpoint.selector;
        selectors[13] = handler.liquidate.selector;
        selectors[14] = handler.adl.selector;
        selectors[15] = handler.unauthorizedRebalance.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------------
    // Accounting
    // ------------------------------------------------------------------

    /// Vault assets = idle + strategy NAV, and strategy NAV = sum of its legs.
    function invariant_assetsEqualSumOfLegs() public view {
        Types.PositionSnapshot memory s = _snap();
        assertEq(vault.totalAssets(), usdc.balanceOf(address(vault)) + strategy.totalAssets(), "vault = idle + NAV");
        assertEq(
            strategy.totalAssets(),
            s.strategyFloat + s.reserveAssets + s.longValue + s.perpEquity,
            "NAV = float + reserve + long + perp equity"
        );
        assertEq(s.totalNav, vault.totalAssets(), "snapshot agrees with vault");
    }

    /// Every dollar of NAV change is attributed to exactly one PnL line.
    function invariant_pnlReconcilesToNav() public view {
        Types.PnLBreakdown memory p = positionManager.pnl();
        int256 residual = int256(p.strategyNav) - p.netCapital - p.netPnl;
        // each operation can lose at most a few wei to integer rounding across 6/18-decimal legs
        int256 tolerance = int256(handler.ops() * 8 + 50);
        assertLe(PerpMath.abs(residual), uint256(tolerance), "PnL attribution must reconcile with NAV");
    }

    /// Shares are fully backed: total supply is the sum of all holders (no phantom shares), and a
    /// non-zero supply always has assets behind it.
    function invariant_sharesBacked() public view {
        uint256 sum = vault.balanceOf(alice) + vault.balanceOf(feeRecipient);
        for (uint256 i; i < 3; ++i) {
            sum += vault.balanceOf(handler.actorAt(i));
        }
        assertEq(sum, vault.totalSupply(), "supply == sum of balances");
        if (vault.totalSupply() > 0) assertGt(vault.totalAssets(), 0, "supply implies assets");
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    /// The vault never promises more than it can pay without trading.
    function invariant_maxWithdrawWithinLiquidity() public view {
        uint256 liquidity = vault.availableLiquidity();
        assertLe(vault.maxWithdraw(alice), liquidity);
        for (uint256 i; i < 3; ++i) {
            assertLe(vault.maxWithdraw(handler.actorAt(i)), liquidity);
        }
        assertEq(handler.withdrawOverLiquiditySuccesses(), 0, "withdrawing past max always reverts");
    }

    // ------------------------------------------------------------------
    // Risk limits
    // ------------------------------------------------------------------

    /// After a successful rebalance, delta / leverage / size are within hard limits (or improved).
    function invariant_rebalancesRespectRiskLimits() public view {
        assertEq(handler.postRebalanceBreaches(), 0, "no rebalance may end outside limits and worse");
    }

    function invariant_positionSizeWithinCap() public view {
        assertLe(_snap().shortNotional, riskManager.config().maxPositionNotional);
    }

    function invariant_feesWithinCaps() public view {
        assertLe(feeManager.managementFeeBps(), feeManager.MAX_MANAGEMENT_FEE_BPS());
        assertLe(feeManager.performanceFeeBps(), feeManager.MAX_PERFORMANCE_FEE_BPS());
        assertLe(feeManager.withdrawalFeeBps(), feeManager.MAX_WITHDRAWAL_FEE_BPS());
    }

    // ------------------------------------------------------------------
    // Authorisation
    // ------------------------------------------------------------------

    function invariant_unauthorizedNeverRebalances() public view {
        assertEq(handler.unauthorizedRebalanceSuccesses(), 0);
    }

    // ------------------------------------------------------------------
    // External venue solvency / no stranded funds
    // ------------------------------------------------------------------

    /// Perp venue conservation still holds after any liquidation / ADL / bad debt.
    function invariant_perpVenueConservation() public view {
        IPerpMarket.Position memory p = perp.getPosition(address(perpAdapter));
        assertGe(usdc.balanceOf(address(perp)), p.margin + perp.lpPool() + perp.insuranceFund());
    }

    /// Pool tokens cover every supplier claim at the stored index (projected interest is minted at
    /// the next accrual, which any withdrawal performs before paying out).
    function invariant_lendingVenueSolvent() public view {
        assertGe(usdc.balanceOf(address(lendingPool)), lendingPool.storedTotalSupplied(address(usdc)));
        assertGe(weth.balanceOf(address(lendingPool)), lendingPool.storedTotalSupplied(address(weth)));
    }

    /// Adapters never hold idle tokens and the strategy never leaves float behind.
    function invariant_noStrandedFunds() public view {
        assertEq(usdc.balanceOf(address(lendingAdapter)), 0);
        assertEq(weth.balanceOf(address(lendingAdapter)), 0);
        assertEq(usdc.balanceOf(address(perpAdapter)), 0);
        assertEq(usdc.balanceOf(address(swapAdapter)), 0);
        assertEq(weth.balanceOf(address(swapAdapter)), 0);
        assertEq(usdc.balanceOf(address(strategy)), 0, "float parked in the reserve");
        assertEq(weth.balanceOf(address(strategy)), 0);
    }

    /// Coverage probe (run with -vv): proves sequences reach real rebalances and venue events rather
    /// than early-returning. Aggregated numbers are reported in docs/testing.md.
    function afterInvariant() public {
        emit log_named_uint("ops", handler.ops());
        emit log_named_uint("rebalances", handler.rebalances());
        emit log_named_uint("liquidations", handler.liquidations());
        emit log_named_uint("maxPostRebalanceDeltaBps", handler.maxObservedPostRebalanceDeltaBps());
    }
}
