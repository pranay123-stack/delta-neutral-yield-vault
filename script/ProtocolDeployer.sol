// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AccessRegistry} from "../contracts/access/AccessRegistry.sol";
import {Roles} from "../contracts/access/Roles.sol";
import {LendingAdapter} from "../contracts/adapters/LendingAdapter.sol";
import {PerpAdapter} from "../contracts/adapters/PerpAdapter.sol";
import {SwapAdapter} from "../contracts/adapters/SwapAdapter.sol";
import {DeltaNeutralVault} from "../contracts/core/DeltaNeutralVault.sol";
import {EmergencyController} from "../contracts/core/EmergencyController.sol";
import {FeeManager} from "../contracts/core/FeeManager.sol";
import {OracleManager} from "../contracts/core/OracleManager.sol";
import {PositionManager} from "../contracts/core/PositionManager.sol";
import {RebalanceManager} from "../contracts/core/RebalanceManager.sol";
import {RiskManager} from "../contracts/core/RiskManager.sol";
import {StrategyManager} from "../contracts/core/StrategyManager.sol";
import {IOracleManager} from "../contracts/interfaces/IOracleManager.sol";
import {IRebalanceManager} from "../contracts/interfaces/IRebalanceManager.sol";
import {IRiskManager} from "../contracts/interfaces/IRiskManager.sol";
import {ILendingPool} from "../contracts/interfaces/external/ILendingPool.sol";
import {MockAggregatorV3} from "../contracts/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockLendingProtocol} from "../contracts/mocks/MockLendingProtocol.sol";
import {MockPerpetualMarket} from "../contracts/mocks/MockPerpetualMarket.sol";
import {MockSpotDEX} from "../contracts/mocks/MockSpotDEX.sol";

/// @title ProtocolDeployer
/// @notice Single source of truth for deploying, wiring and seeding the full local system.
///         Used by `Deploy.s.sol` (Anvil / Sepolia) *and* by the Foundry test fixture, so tests run
///         against exactly the configuration the demo ships with.
/// @dev Every default below is documented in docs/economics.md and docs/risk-management.md.
abstract contract ProtocolDeployer {
    struct RoleSet {
        address admin;
        address guardian;
        address keeper;
        address strategist;
        address feeRecipient;
    }

    struct Deployment {
        AccessRegistry registry;
        MockERC20 usdc;
        MockERC20 weth;
        MockAggregatorV3 ethUsdFeed;
        MockAggregatorV3 ethUsdFallbackFeed;
        MockLendingProtocol lending;
        MockPerpetualMarket perp;
        MockSpotDEX dex;
        OracleManager oracle;
        FeeManager feeManager;
        EmergencyController emergency;
        DeltaNeutralVault vault;
        StrategyManager strategy;
        LendingAdapter lendingAdapter;
        PerpAdapter perpAdapter;
        SwapAdapter swapAdapter;
        PositionManager positionManager;
        RiskManager riskManager;
        RebalanceManager rebalanceManager;
    }

    // ---- market defaults -------------------------------------------------
    int256 internal constant INITIAL_ETH_PRICE = 3000e8; // 8-decimal feed, like Chainlink ETH/USD
    uint32 internal constant ORACLE_HEARTBEAT = 1 hours;
    uint16 internal constant ORACLE_MAX_DEVIATION_BPS = 2000; // 20% between consecutive rounds
    int256 internal constant INITIAL_FUNDING_PER_8H = 0.0001e18; // 0.01% / 8h ~ 10.95% APR

    uint256 internal constant SEED_LENDING_USDC = 20_000_000e6;
    uint256 internal constant SEED_LENDING_WETH = 10_000e18;
    uint256 internal constant SEED_PERP_POOL = 50_000_000e6;
    uint256 internal constant SEED_DEX_USDC = 30_000_000e6;
    uint256 internal constant SEED_DEX_WETH = 10_000e18;

    // ---- protocol defaults -----------------------------------------------
    uint256 internal constant DEPOSIT_CAP = 10_000_000e6;
    uint16 internal constant MANAGEMENT_FEE_BPS = 50; // 0.5% / yr
    uint16 internal constant PERFORMANCE_FEE_BPS = 1000; // 10% of gains over HWM
    uint16 internal constant WITHDRAWAL_FEE_BPS = 0;
    /// @dev share price at inception = 1 USDC per share = 1e6 assets / 1e12 share-units, WAD-scaled
    uint256 internal constant INITIAL_HWM = 1e12;

    /// @dev The account that sends the deployment calls: the test contract in tests, the broadcaster
    ///      EOA in scripts (inside a broadcast, `address(this)` is the script, not the sender).
    function _self() internal view virtual returns (address);

    function _deployProtocol(RoleSet memory r) internal returns (Deployment memory d) {
        _deployMocks(d);
        _deployCore(d, r);
        _wire(d, r);
        _seedMarkets(d, r.admin);
    }

    function _deployMocks(Deployment memory d) internal {
        d.usdc = new MockERC20("Mock USD Coin", "mUSDC", 6, 1_000_000e6);
        d.weth = new MockERC20("Mock Wrapped Ether", "mWETH", 18, 1000e18);
        d.ethUsdFeed = new MockAggregatorV3(8, "ETH / USD (mock primary)", INITIAL_ETH_PRICE);
        d.ethUsdFallbackFeed = new MockAggregatorV3(8, "ETH / USD (mock fallback)", INITIAL_ETH_PRICE);

        d.lending = new MockLendingProtocol();
        d.lending.initReserve(address(d.usdc), usdcRateModel());
        d.lending.initReserve(address(d.weth), wethRateModel());
        d.usdc.setMinter(address(d.lending), true);
        d.weth.setMinter(address(d.lending), true);

        d.perp = new MockPerpetualMarket(IERC20(address(d.usdc)), d.ethUsdFeed, perpParams());
        d.dex = new MockSpotDEX(IERC20(address(d.usdc)), IERC20(address(d.weth)), d.ethUsdFeed, 5, 2, 500_000_000e6);
    }

    function _deployCore(Deployment memory d, RoleSet memory r) internal {
        d.registry = new AccessRegistry(_self());
        d.oracle = new OracleManager(d.registry);
        d.feeManager = new FeeManager(
            d.registry, r.feeRecipient, MANAGEMENT_FEE_BPS, PERFORMANCE_FEE_BPS, WITHDRAWAL_FEE_BPS, INITIAL_HWM
        );
        d.emergency = new EmergencyController(d.registry);
        d.vault = new DeltaNeutralVault(IERC20(address(d.usdc)), d.registry, d.feeManager, d.emergency, DEPOSIT_CAP);
        d.strategy = new StrategyManager(
            d.registry, address(d.vault), IERC20(address(d.usdc)), address(d.weth), d.oracle, d.emergency
        );

        address[] memory assets = new address[](2);
        assets[0] = address(d.usdc);
        assets[1] = address(d.weth);
        d.lendingAdapter = new LendingAdapter(ILendingPool(address(d.lending)), address(d.strategy), assets);
        d.perpAdapter = new PerpAdapter(d.perp, address(d.strategy), IERC20(address(d.usdc)));
        d.swapAdapter = new SwapAdapter(d.dex, address(d.strategy), assets);

        d.positionManager = new PositionManager(d.strategy, address(d.vault));
        d.riskManager = new RiskManager(d.registry, d.positionManager, d.vault, d.emergency, riskConfig());
        d.rebalanceManager = new RebalanceManager(
            d.registry,
            d.strategy,
            d.positionManager,
            d.riskManager,
            d.vault,
            d.emergency,
            targetBounds(),
            targets(),
            rebalanceParams()
        );
    }

    function _wire(Deployment memory d, RoleSet memory r) internal {
        d.oracle
            .setFeed(
                address(d.weth),
                IOracleManager.FeedConfig({
                    primary: address(d.ethUsdFeed),
                    secondary: address(d.ethUsdFallbackFeed),
                    heartbeat: ORACLE_HEARTBEAT,
                    decimals: 8,
                    maxDeviationBps: ORACLE_MAX_DEVIATION_BPS
                })
            );
        d.feeManager.initialize(address(d.vault));
        d.emergency.initialize(d.strategy, address(d.riskManager));
        d.vault.initialize(d.strategy, address(d.rebalanceManager));
        d.strategy
            .initialize(d.lendingAdapter, d.perpAdapter, d.swapAdapter, address(d.rebalanceManager), d.riskManager);
        d.riskManager.initialize(address(d.rebalanceManager));

        d.registry.grantRole(Roles.GUARDIAN, r.guardian);
        d.registry.grantRole(Roles.KEEPER, r.keeper);
        d.registry.grantRole(Roles.STRATEGIST, r.strategist);
        if (r.admin != _self()) {
            d.registry.grantRole(Roles.ADMIN, r.admin);
            d.registry.renounceRole(Roles.ADMIN, _self());
        }
    }

    /// @dev Stand-ins for "the rest of the market": other lenders/borrowers, perp counterparties, DEX LPs.
    function _seedMarkets(Deployment memory d, address simulator) internal {
        d.usdc.mint(_self(), SEED_LENDING_USDC + SEED_PERP_POOL + SEED_DEX_USDC);
        d.weth.mint(_self(), SEED_LENDING_WETH + SEED_DEX_WETH);

        d.usdc.approve(address(d.lending), SEED_LENDING_USDC);
        d.lending.supply(address(d.usdc), SEED_LENDING_USDC, _self(), 0);
        d.weth.approve(address(d.lending), SEED_LENDING_WETH);
        d.lending.supply(address(d.weth), SEED_LENDING_WETH, _self(), 0);
        d.lending.setUtilization(address(d.usdc), 0.8e18);
        d.lending.setUtilization(address(d.weth), 0.6e18);

        d.usdc.approve(address(d.perp), SEED_PERP_POOL);
        d.perp.fundPool(SEED_PERP_POOL);
        d.perp.setFundingRate(INITIAL_FUNDING_PER_8H);

        d.usdc.transfer(address(d.dex), SEED_DEX_USDC);
        d.weth.transfer(address(d.dex), SEED_DEX_WETH);

        // hand simulation control of the mock markets to the simulator account
        if (simulator != _self()) {
            d.ethUsdFeed.transferOwnership(simulator);
            d.ethUsdFallbackFeed.transferOwnership(simulator);
            d.lending.transferOwnership(simulator);
            d.perp.transferOwnership(simulator);
            d.dex.transferOwnership(simulator);
            d.usdc.transferOwnership(simulator);
            d.weth.transferOwnership(simulator);
        }
    }

    // ------------------------------------------------------------------
    // Default parameter sets
    // ------------------------------------------------------------------

    /// @dev Kinked USDC curve, 90% optimal. At 80% utilisation: borrow 7.1%, supply ~5.1% APR.
    function usdcRateModel() internal pure returns (MockLendingProtocol.RateModel memory) {
        return MockLendingProtocol.RateModel({
            baseRate: 0, slope1: 0.08e18, slope2: 0.6e18, optimalUtilization: 0.9e18, reserveFactor: 0.1e18
        });
    }

    /// @dev WETH curve, 80% optimal. At 60% utilisation: borrow 3.75%, supply ~1.9% APR.
    function wethRateModel() internal pure returns (MockLendingProtocol.RateModel memory) {
        return MockLendingProtocol.RateModel({
            baseRate: 0, slope1: 0.05e18, slope2: 0.8e18, optimalUtilization: 0.8e18, reserveFactor: 0.15e18
        });
    }

    /// @dev 5 bps taker, 2 bps half-spread, $1B linear depth (a $60k clip costs ~0.6 bps impact), 10% IM (10x max), 5% MM, 1% liq penalty.
    function perpParams() internal pure returns (MockPerpetualMarket.MarketParams memory) {
        return MockPerpetualMarket.MarketParams({
            takerFeeBps: 5,
            spreadBps: 2,
            maxImpactBps: 200,
            initialMarginBps: 1000,
            maintenanceMarginBps: 500,
            liquidationPenaltyBps: 100,
            depthUsd: 1_000_000_000e6
        });
    }

    function riskConfig() internal pure returns (IRiskManager.RiskConfig memory) {
        return IRiskManager.RiskConfig({
            leverage: IRiskManager.Threshold({warn: 25_000, high: 35_000, critical: 50_000}),
            delta: IRiskManager.Threshold({warn: 200, high: 500, critical: 1000}),
            drawdown: IRiskManager.Threshold({warn: 200, high: 500, critical: 1000}),
            liquidationDistance: IRiskManager.Threshold({warn: 3000, high: 2000, critical: 1000}),
            collateralRatio: IRiskManager.Threshold({warn: 60_000, high: 40_000, critical: 20_000}),
            protocolExposure: IRiskManager.Threshold({warn: 8500, high: 9500, critical: 10_000}),
            fundingWarnAprBps: 0,
            fundingHighAprBps: -1000,
            maxSlippageBps: 100,
            maxPositionNotional: 8_000_000e6
        });
    }

    function targetBounds() internal pure returns (IRebalanceManager.TargetBounds memory) {
        return IRebalanceManager.TargetBounds({
            minLeverageBps: 10_000,
            maxLeverageBps: 30_000,
            minHedgeRatioBps: 9000,
            maxHedgeRatioBps: 11_000,
            minReserveBps: 500,
            maxReserveBps: 9000
        });
    }

    function targets() internal pure returns (IRebalanceManager.Targets memory) {
        return IRebalanceManager.Targets({
            targetLeverageBps: 20_000, hedgeRatioBps: 10_000, reserveBps: 1000, defensiveReserveBps: 7000
        });
    }

    function rebalanceParams() internal pure returns (IRebalanceManager.Params memory) {
        return IRebalanceManager.Params({
            deltaBandBps: 200,
            leverageBandBps: 2500,
            allocationBandBps: 500,
            minIntervalSec: 1 hours,
            maxCostBps: 50,
            carryHorizonSec: 30 days,
            volRefBps: 6000,
            fundingFloorAprBps: -500,
            minTradeUsd: 1000e6,
            minDeployUsd: 1000e6
        });
    }
}
