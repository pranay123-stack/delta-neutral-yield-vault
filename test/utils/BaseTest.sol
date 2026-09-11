// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AccessRegistry} from "../../contracts/access/AccessRegistry.sol";
import {LendingAdapter} from "../../contracts/adapters/LendingAdapter.sol";
import {PerpAdapter} from "../../contracts/adapters/PerpAdapter.sol";
import {SwapAdapter} from "../../contracts/adapters/SwapAdapter.sol";
import {DeltaNeutralVault} from "../../contracts/core/DeltaNeutralVault.sol";
import {EmergencyController} from "../../contracts/core/EmergencyController.sol";
import {FeeManager} from "../../contracts/core/FeeManager.sol";
import {OracleManager} from "../../contracts/core/OracleManager.sol";
import {PositionManager} from "../../contracts/core/PositionManager.sol";
import {RebalanceManager} from "../../contracts/core/RebalanceManager.sol";
import {RiskManager} from "../../contracts/core/RiskManager.sol";
import {StrategyManager} from "../../contracts/core/StrategyManager.sol";
import {IRiskManager} from "../../contracts/interfaces/IRiskManager.sol";
import {DeltaCalculator} from "../../contracts/libraries/DeltaCalculator.sol";
import {PerpMath} from "../../contracts/libraries/PerpMath.sol";
import {Types} from "../../contracts/libraries/Types.sol";
import {MockAggregatorV3} from "../../contracts/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockLendingProtocol} from "../../contracts/mocks/MockLendingProtocol.sol";
import {MockPerpetualMarket} from "../../contracts/mocks/MockPerpetualMarket.sol";
import {MockSpotDEX} from "../../contracts/mocks/MockSpotDEX.sol";
import {ProtocolDeployer} from "../../script/ProtocolDeployer.sol";

/// @notice Full-system fixture. The test contract is admin + market simulator; roles are separate EOAs.
abstract contract BaseTest is Test, ProtocolDeployer {
    Deployment internal d;

    AccessRegistry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockAggregatorV3 internal feed;
    MockAggregatorV3 internal fallbackFeed;
    MockLendingProtocol internal lendingPool;
    MockPerpetualMarket internal perp;
    MockSpotDEX internal dex;
    OracleManager internal oracle;
    FeeManager internal feeManager;
    EmergencyController internal emergency;
    DeltaNeutralVault internal vault;
    StrategyManager internal strategy;
    LendingAdapter internal lendingAdapter;
    PerpAdapter internal perpAdapter;
    SwapAdapter internal swapAdapter;
    PositionManager internal positionManager;
    RiskManager internal riskManager;
    RebalanceManager internal rebalancer;

    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal strategist = makeAddr("strategist");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant START_TIME = 1_750_000_000;

    function _self() internal view override returns (address) {
        return address(this);
    }

    function setUp() public virtual {
        vm.warp(START_TIME);
        d = _deployProtocol(Roles_(address(this), guardian, keeper, strategist, feeRecipient));
        registry = d.registry;
        usdc = d.usdc;
        weth = d.weth;
        feed = d.ethUsdFeed;
        fallbackFeed = d.ethUsdFallbackFeed;
        lendingPool = d.lending;
        perp = d.perp;
        dex = d.dex;
        oracle = d.oracle;
        feeManager = d.feeManager;
        emergency = d.emergency;
        vault = d.vault;
        strategy = d.strategy;
        lendingAdapter = d.lendingAdapter;
        perpAdapter = d.perpAdapter;
        swapAdapter = d.swapAdapter;
        positionManager = d.positionManager;
        riskManager = d.riskManager;
        rebalancer = d.rebalanceManager;

        vm.label(address(vault), "Vault");
        vm.label(address(strategy), "StrategyManager");
        vm.label(address(perp), "MockPerp");
        vm.label(address(lendingPool), "MockLending");
        vm.label(address(dex), "MockDEX");
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function _fund(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        _fund(user, amount);
        vm.prank(user);
        shares = vault.deposit(amount, user);
    }

    function _rebalance() internal {
        vm.prank(keeper);
        rebalancer.performUpkeep("");
    }

    function _tryRebalance() internal returns (bool ok) {
        (bool needed,) = rebalancer.checkUpkeep("");
        if (!needed) return false;
        _rebalance();
        return true;
    }

    /// @dev Deposit and deploy into the basis position: the canonical "running vault" state.
    function _bootstrap(uint256 amount) internal {
        _deposit(alice, amount);
        _rebalance();
    }

    // ------------------------------------------------------------------
    // Market simulation
    // ------------------------------------------------------------------

    function _price() internal view returns (uint256) {
        return oracle.getPrice(address(weth));
    }

    /// @dev Push a new round (8 decimals) on both feeds at the current timestamp.
    function _setPrice(int256 price8) internal {
        feed.setAnswer(price8);
        fallbackFeed.setAnswer(price8);
    }

    /// @dev Move the price by `bps` (signed) in rounds that each stay inside the oracle deviation guard.
    function _movePrice(int256 bps) internal {
        (, int256 p,,,) = feed.latestRoundData();
        int256 target = p * (10_000 + bps) / 10_000;
        int256 maxStep = p * 1500 / 10_000; // 15% per round < 20% guard
        while (p != target) {
            int256 diff = target - p;
            if (diff > maxStep) diff = maxStep;
            if (diff < -maxStep) diff = -maxStep;
            p += diff;
            _setPrice(p);
            maxStep = p * 1500 / 10_000;
        }
    }

    /// @dev Advance time and republish the current price so the oracle stays fresh.
    function _warp(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        (, int256 p,,,) = feed.latestRoundData();
        _setPrice(p);
    }

    /// @dev Advance time in `steps` hops, keeping feeds fresh and observing volatility.
    function _warpSteps(uint256 total, uint256 steps) internal {
        for (uint256 i; i < steps; ++i) {
            _warp(total / steps);
            vm.prank(keeper);
            rebalancer.observeVolatility();
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function _snap() internal view returns (Types.PositionSnapshot memory) {
        return positionManager.snapshot();
    }

    function _deltaBps() internal view returns (int256) {
        return positionManager.deltaReport(10_000).deltaBps;
    }

    function _leverageBps() internal view returns (uint256) {
        return positionManager.leverageBps(_snap());
    }

    function _assertApproxRel(uint256 a, uint256 b, uint256 maxBps, string memory err) internal pure {
        assertApproxEqRel(a, b, maxBps * 1e14, err);
    }
}
