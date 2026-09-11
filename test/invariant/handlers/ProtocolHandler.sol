// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeltaNeutralVault} from "../../../contracts/core/DeltaNeutralVault.sol";
import {PositionManager} from "../../../contracts/core/PositionManager.sol";
import {RebalanceManager} from "../../../contracts/core/RebalanceManager.sol";
import {RiskManager} from "../../../contracts/core/RiskManager.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {PerpMath} from "../../../contracts/libraries/PerpMath.sol";
import {Types} from "../../../contracts/libraries/Types.sol";
import {MockAggregatorV3} from "../../../contracts/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../../../contracts/mocks/MockERC20.sol";
import {MockLendingProtocol} from "../../../contracts/mocks/MockLendingProtocol.sol";
import {MockPerpetualMarket} from "../../../contracts/mocks/MockPerpetualMarket.sol";

/// @notice Drives the whole system through random but *valid* sequences: user flows, market regime
///         changes, time, keeper activity, venue events and attacker probes. Ghost variables record
///         facts that invariants check after every call.
contract ProtocolHandler is Test {
    DeltaNeutralVault internal vault;
    PositionManager internal pm;
    RebalanceManager internal rebalancer;
    RiskManager internal risk;
    MockERC20 internal usdc;
    MockAggregatorV3 internal feed;
    MockAggregatorV3 internal fallbackFeed;
    MockLendingProtocol internal lending;
    MockPerpetualMarket internal perp;
    address internal keeper;
    address internal perpAccount;

    address[3] internal actors;

    // ---- ghosts ------------------------------------------------------------
    uint256 public ops;
    uint256 public rebalances;
    uint256 public liquidations;
    uint256 public unauthorizedRebalanceSuccesses;
    uint256 public postRebalanceBreaches; // a rebalance ended outside hard limits *and* made it worse
    uint256 public maxObservedPostRebalanceDeltaBps;
    uint256 public withdrawOverLiquiditySuccesses;
    mapping(bytes32 => uint256) public calls;

    constructor(
        DeltaNeutralVault vault_,
        PositionManager pm_,
        RebalanceManager rebalancer_,
        RiskManager risk_,
        MockERC20 usdc_,
        MockAggregatorV3 feed_,
        MockAggregatorV3 fallbackFeed_,
        MockLendingProtocol lending_,
        MockPerpetualMarket perp_,
        address keeper_,
        address perpAccount_
    ) {
        vault = vault_;
        pm = pm_;
        rebalancer = rebalancer_;
        risk = risk_;
        usdc = usdc_;
        feed = feed_;
        fallbackFeed = fallbackFeed_;
        lending = lending_;
        perp = perp_;
        keeper = keeper_;
        perpAccount = perpAccount_;
        actors = [makeAddr("actor0"), makeAddr("actor1"), makeAddr("actor2")];
        for (uint256 i; i < 3; ++i) {
            vm.prank(actors[i]);
            usdc.approve(address(vault_), type(uint256).max);
        }
    }

    modifier counted(bytes32 name) {
        ++ops;
        ++calls[name];
        _;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // ------------------------------------------------------------------
    // User flows
    // ------------------------------------------------------------------

    function deposit(uint256 seed, uint256 amount) external counted("deposit") {
        address a = actors[seed % 3];
        amount = bound(amount, 1e6, 500_000e6);
        if (amount > vault.maxDeposit(a)) return;
        usdc.mint(a, amount);
        vm.prank(a);
        vault.deposit(amount, a);
    }

    function withdraw(uint256 seed, uint256 amount) external counted("withdraw") {
        address a = actors[seed % 3];
        uint256 max = vault.maxWithdraw(a);
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(a);
        vault.withdraw(amount, a, a);
    }

    function redeem(uint256 seed, uint256 shares) external counted("redeem") {
        address a = actors[seed % 3];
        uint256 max = vault.maxRedeem(a);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        if (vault.previewRedeem(shares) == 0) return;
        vm.prank(a);
        vault.redeem(shares, a, a);
    }

    function redeemWithUnwind(uint256 seed, uint256 shares) external counted("redeemWithUnwind") {
        address a = actors[seed % 3];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0 || !vault.isOperational()) return;
        shares = bound(shares, 1, bal);
        if (vault.previewRedeem(shares) < 10e6) return; // dust exits are uninteresting
        vm.prank(a);
        try vault.redeemWithUnwind(shares, a, a, 0) {} catch {}
    }

    /// Attacker probe: try to withdraw more than the vault says is possible.
    function withdrawOverLimit(uint256 seed) external counted("withdrawOverLimit") {
        address a = actors[seed % 3];
        uint256 max = vault.maxWithdraw(a);
        vm.prank(a);
        try vault.withdraw(max + 1, a, a) {
            ++withdrawOverLiquiditySuccesses;
        } catch {}
    }

    // ------------------------------------------------------------------
    // Market simulation
    // ------------------------------------------------------------------

    function movePrice(int256 bps) external counted("movePrice") {
        bps = bound(bps, -1000, 1000); // stay inside the 20% per-round oracle guard
        (, int256 p,,,) = feed.latestRoundData();
        int256 np = p * (10_000 + bps) / 10_000;
        if (np < 500e8) np = 500e8; // keep ETH in a sane range
        if (np > 20_000e8) np = 20_000e8;
        _push(np);
    }

    function setFunding(int256 ratePer8h) external counted("setFunding") {
        ratePer8h = bound(ratePer8h, -0.0005e18, 0.0005e18);
        perp.setFundingRate(ratePer8h);
    }

    function setUtilization(uint256 u, bool weth) external counted("setUtilization") {
        u = bound(u, 0, 0.95e18);
        lending.setUtilization(weth ? _weth() : address(usdc), u);
    }

    function warp(uint256 dt) external counted("warp") {
        dt = bound(dt, 10 minutes, 2 days);
        vm.warp(block.timestamp + dt);
        (, int256 p,,,) = feed.latestRoundData();
        _push(p); // keep the oracle fresh
    }

    // ------------------------------------------------------------------
    // Keeper / protocol
    // ------------------------------------------------------------------

    function rebalance() external counted("rebalance") {
        (bool needed,) = rebalancer.checkUpkeep("");
        if (!needed) return;
        Types.PositionSnapshot memory pre = pm.snapshot();
        vm.prank(keeper);
        rebalancer.performUpkeep("");
        ++rebalances;
        _recordPostRebalance(pre, pm.snapshot());
    }

    function observe() external counted("observe") {
        vm.prank(keeper);
        rebalancer.observeVolatility();
    }

    function accrueFees() external counted("accrueFees") {
        vault.accrueFees();
    }

    function checkpoint() external counted("checkpoint") {
        vm.prank(keeper);
        risk.checkpoint();
    }

    // ------------------------------------------------------------------
    // Venue events & attacker probes
    // ------------------------------------------------------------------

    function liquidate() external counted("liquidate") {
        if (!perp.isLiquidatable(perpAccount)) return;
        perp.liquidate(perpAccount);
        ++liquidations;
    }

    function adl(uint256 bps) external counted("adl") {
        bps = bound(bps, 1, 2000);
        perp.simulateAdl(perpAccount, bps);
    }

    function unauthorizedRebalance(uint256 seed) external counted("unauthorizedRebalance") {
        vm.prank(actors[seed % 3]);
        try rebalancer.performUpkeep("") {
            ++unauthorizedRebalanceSuccesses;
        } catch {}
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _push(int256 p) internal {
        feed.setAnswer(p);
        fallbackFeed.setAnswer(p);
    }

    function _weth() internal view returns (address) {
        return pm.strategy().weth();
    }

    function _recordPostRebalance(Types.PositionSnapshot memory pre, Types.PositionSnapshot memory post) internal {
        IRiskManager.RiskConfig memory c = risk.config();
        uint256 dPre = PerpMath.abs(_deltaBps(pre));
        uint256 dPost = PerpMath.abs(_deltaBps(post));
        if (dPost > maxObservedPostRebalanceDeltaBps) maxObservedPostRebalanceDeltaBps = dPost;
        uint256 levPre = pm.leverageBps(pre);
        uint256 levPost = pm.leverageBps(post);
        bool deltaBad = dPost > c.delta.high && dPost >= dPre;
        bool levBad = levPost > c.leverage.high && levPost >= levPre;
        bool sizeBad = post.shortNotional > c.maxPositionNotional && post.shortNotional >= pre.shortNotional;
        if (deltaBad || levBad || sizeBad) ++postRebalanceBreaches;
    }

    function _deltaBps(Types.PositionSnapshot memory s) internal pure returns (int256) {
        int256 net = int256(s.longQty) + s.perpSize;
        int256 usd = PerpMath.mulDivSigned(net, s.price, PerpMath.QTY_PRICE_TO_USD6);
        return s.totalNav == 0 ? int256(0) : usd * 10_000 / int256(s.totalNav);
    }
}
