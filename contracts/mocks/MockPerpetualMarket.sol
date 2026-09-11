// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IAggregatorV3} from "../interfaces/external/IAggregatorV3.sol";
import {IPerpMarket} from "../interfaces/external/IPerpMarket.sol";
import {PerpMath} from "../libraries/PerpMath.sol";

/// @title MockPerpetualMarket
/// @notice Single-market (ETH-USD), isolated-margin, USDC-collateralised perpetual used as the
///         hedge leg in the local demo.
/// @dev Production-faithful mechanics:
///        - average-entry position accounting, realised PnL on reduction, flip handling
///        - continuous funding via a cumulative index (rate is per 8h, positive = longs pay shorts)
///        - linear price impact vs a configurable depth + spread, taker fees
///        - initial margin on risk-increasing trades / withdrawals, maintenance-margin liquidation,
///          liquidation penalty, bad debt absorbed by insurance then the LP pool
///      Simulated: the counterparty to every trade is `lpPool` (a stand-in for the rest of the
///      market), the funding rate is set by the simulator rather than derived from the premium, and
///      the mark price is the raw feed with no mark/index basis.
contract MockPerpetualMarket is IPerpMarket, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant FUNDING_PERIOD = 8 hours;
    int256 internal constant MAX_FUNDING_RATE = 0.01e18; // 1% per 8h hard cap

    struct MarketParams {
        uint32 takerFeeBps;
        uint32 spreadBps; // half-spread applied to every trade
        uint32 maxImpactBps;
        uint32 initialMarginBps;
        uint32 maintenanceMarginBps;
        uint32 liquidationPenaltyBps;
        uint256 depthUsd; // usd6 notional that moves price by 100%, i.e. impact = notional / depth
    }

    /// @dev Margin is signed internally so that a funding/PnL settlement larger than the posted
    ///      collateral is represented exactly until liquidation resolves it as bad debt.
    struct Account {
        int256 size;
        uint256 entryPrice;
        int256 margin;
        int256 lastFundingIndex;
    }

    IERC20 public immutable collateral;
    IAggregatorV3 public priceFeed;
    uint8 public feedDecimals;

    MarketParams public params;
    int256 public override fundingRatePer8h;
    int256 public cumulativeFundingIndex; // USD (1e18) per 1 ETH of size
    uint40 public lastFundingUpdate;

    uint256 public lpPool; // usd6 - counterparty liquidity
    uint256 public insuranceFund; // usd6
    uint256 public longOpenInterest; // qty18
    uint256 public shortOpenInterest; // qty18

    mapping(address => Account) internal _accounts;
    mapping(address => AccountStats) internal _stats;

    event MarketParamsUpdated(MarketParams params);
    event PoolFunded(address indexed from, uint256 amount);
    event AutoDeleveraged(address indexed account, int256 sizeReduced, uint256 markPrice, int256 realizedPnl);

    error ZeroAmount();
    error InvalidPrice();
    error PriceLimitExceeded(uint256 execPrice, uint256 acceptablePrice);
    error InsufficientMargin(int256 equity, uint256 required);
    error InsufficientCollateral(int256 margin, uint256 requested);
    error NotLiquidatable(int256 equity, uint256 maintenance);
    error PoolInsolvent(uint256 owed, uint256 available);
    error InvalidParams();
    error FundingRateTooLarge();

    constructor(IERC20 collateral_, IAggregatorV3 feed_, MarketParams memory params_) Ownable(msg.sender) {
        collateral = collateral_;
        priceFeed = feed_;
        feedDecimals = feed_.decimals();
        _setParams(params_);
        lastFundingUpdate = uint40(block.timestamp);
    }

    // ------------------------------------------------------------------
    // Admin / simulation controls
    // ------------------------------------------------------------------

    function setParams(MarketParams calldata p) external onlyOwner {
        _setParams(p);
    }

    function setFundingRate(int256 ratePer8h) external onlyOwner {
        if (ratePer8h > MAX_FUNDING_RATE || ratePer8h < -MAX_FUNDING_RATE) revert FundingRateTooLarge();
        _updateFunding();
        fundingRatePer8h = ratePer8h;
        emit FundingRateUpdated(ratePer8h);
    }

    /// @notice Add counterparty liquidity. Permissionless so the deploy script / tests can seed it.
    function fundPool(uint256 amount) external {
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        lpPool += amount;
        emit PoolFunded(msg.sender, amount);
    }

    /// @notice Simulate venue auto-deleveraging: force-reduce `account` by `reduceBps` at mark.
    function simulateAdl(address account, uint256 reduceBps) external onlyOwner {
        if (reduceBps == 0 || reduceBps > BPS) revert InvalidParams();
        _updateFunding();
        _settleFunding(account);
        Account storage a = _accounts[account];
        if (a.size == 0) return;
        int256 reduce = -PerpMath.mulDivSigned(a.size, reduceBps, BPS);
        uint256 mark = markPrice();
        int256 realized = _applyFill(account, a, reduce, mark);
        emit AutoDeleveraged(account, reduce, mark, realized);
    }

    // ------------------------------------------------------------------
    // Trading
    // ------------------------------------------------------------------

    function depositMargin(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateFunding();
        _settleFunding(msg.sender);
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        _accounts[msg.sender].margin += amount.toInt256();
        emit MarginDeposited(msg.sender, amount);
    }

    function withdrawMargin(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateFunding();
        _settleFunding(msg.sender);
        Account storage a = _accounts[msg.sender];
        if (a.margin < amount.toInt256()) revert InsufficientCollateral(a.margin, amount);
        a.margin -= amount.toInt256();
        if (a.size != 0) {
            uint256 mark = markPrice();
            int256 eq = _equity(a, mark, cumulativeFundingIndex);
            uint256 imr = _marginReq(a.size, mark, params.initialMarginBps);
            if (eq < imr.toInt256()) revert InsufficientMargin(eq, imr);
        }
        collateral.safeTransfer(msg.sender, amount);
        emit MarginWithdrawn(msg.sender, amount);
    }

    function trade(int256 sizeDelta, uint256 acceptablePrice)
        external
        override
        nonReentrant
        returns (uint256 execPrice, int256 realizedPnl, uint256 fee)
    {
        if (sizeDelta == 0) revert ZeroAmount();
        _updateFunding();
        _settleFunding(msg.sender);

        uint256 mark = markPrice();
        execPrice = _executionPrice(sizeDelta, mark);
        if (sizeDelta > 0 ? execPrice > acceptablePrice : execPrice < acceptablePrice) {
            revert PriceLimitExceeded(execPrice, acceptablePrice);
        }

        Account storage a = _accounts[msg.sender];
        int256 oldSize = a.size;
        realizedPnl = _applyFill(msg.sender, a, sizeDelta, execPrice);

        fee = Math.mulDiv(PerpMath.notional(sizeDelta, execPrice), params.takerFeeBps, BPS, Math.Rounding.Ceil);
        a.margin -= fee.toInt256();
        insuranceFund += fee;
        _stats[msg.sender].feesPaid += fee;

        // Risk-increasing trades must leave equity >= initial margin. Pure reductions are always allowed.
        bool increasesRisk = PerpMath.abs(a.size) > PerpMath.abs(oldSize)
            || (oldSize != 0 && (a.size > 0) != (oldSize > 0) && a.size != 0);
        if (increasesRisk) {
            int256 eq = _equity(a, mark, cumulativeFundingIndex);
            uint256 imr = _marginReq(a.size, mark, params.initialMarginBps);
            if (eq < imr.toInt256()) revert InsufficientMargin(eq, imr);
        }
        emit Trade(msg.sender, sizeDelta, execPrice, mark, realizedPnl, fee);
    }

    /// @notice Permissionless liquidation when equity < maintenance margin. Closes at mark.
    function liquidate(address account) external override nonReentrant {
        _updateFunding();
        _settleFunding(account);
        Account storage a = _accounts[account];
        uint256 mark = markPrice();
        int256 eq = _equity(a, mark, cumulativeFundingIndex);
        uint256 mmr = _marginReq(a.size, mark, params.maintenanceMarginBps);
        if (a.size == 0 || eq >= mmr.toInt256()) revert NotLiquidatable(eq, mmr);

        int256 closedSize = a.size;
        _applyFill(account, a, -a.size, mark);

        uint256 penalty = Math.mulDiv(PerpMath.notional(closedSize, mark), params.liquidationPenaltyBps, BPS);
        uint256 marginAvail = a.margin > 0 ? a.margin.toUint256() : 0;
        if (penalty > marginAvail) penalty = marginAvail;
        a.margin -= penalty.toInt256();
        insuranceFund += penalty;
        _stats[account].liquidationPenalties += penalty;

        uint256 badDebt;
        if (a.margin < 0) {
            badDebt = (-a.margin).toUint256();
            a.margin = 0;
            uint256 fromInsurance = Math.min(badDebt, insuranceFund);
            insuranceFund -= fromInsurance;
            uint256 remainder = badDebt - fromInsurance;
            if (remainder > lpPool) revert PoolInsolvent(remainder, lpPool);
            lpPool -= remainder;
            _stats[account].badDebt += badDebt;
        }
        emit Liquidated(account, msg.sender, closedSize, mark, penalty, badDebt);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function markPrice() public view override returns (uint256) {
        (, int256 answer,,,) = priceFeed.latestRoundData();
        if (answer <= 0) revert InvalidPrice();
        uint8 d = feedDecimals;
        return d <= 18 ? answer.toUint256() * 10 ** (18 - d) : answer.toUint256() / 10 ** (d - 18);
    }

    function getPosition(address account) external view override returns (Position memory p) {
        Account storage a = _accounts[account];
        p.size = a.size;
        p.entryPrice = a.entryPrice;
        p.margin = a.margin > 0 ? a.margin.toUint256() : 0;
        p.lastFundingIndex = a.lastFundingIndex;
    }

    function getAccountStats(address account) external view override returns (AccountStats memory) {
        return _stats[account];
    }

    function unrealizedPnl(address account) external view override returns (int256) {
        Account storage a = _accounts[account];
        return PerpMath.pnl(a.size, a.entryPrice, markPrice());
    }

    function pendingFunding(address account) public view override returns (int256) {
        Account storage a = _accounts[account];
        return _fundingOwed(a.size, _pendingIndex() - a.lastFundingIndex);
    }

    function accountEquity(address account) external view override returns (int256) {
        return _equity(_accounts[account], markPrice(), _pendingIndex());
    }

    function maintenanceMargin(address account) external view override returns (uint256) {
        return _marginReq(_accounts[account].size, markPrice(), params.maintenanceMarginBps);
    }

    function liquidationPrice(address account) external view override returns (uint256) {
        Account storage a = _accounts[account];
        int256 effMargin = a.margin + pendingFunding(account);
        return PerpMath.liquidationPrice(a.size, a.entryPrice, effMargin, params.maintenanceMarginBps);
    }

    function isLiquidatable(address account) external view override returns (bool) {
        Account storage a = _accounts[account];
        if (a.size == 0) return false;
        uint256 mark = markPrice();
        return _equity(a, mark, _pendingIndex()) < _marginReq(a.size, mark, params.maintenanceMarginBps).toInt256();
    }

    function quoteExecutionPrice(int256 sizeDelta) external view override returns (uint256) {
        return _executionPrice(sizeDelta, markPrice());
    }

    function takerFeeBps() external view override returns (uint256) {
        return params.takerFeeBps;
    }

    function maintenanceMarginBps() external view override returns (uint256) {
        return params.maintenanceMarginBps;
    }

    function initialMarginBps() external view override returns (uint256) {
        return params.initialMarginBps;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Applies a fill to `a`, moves realised PnL between account margin and the LP pool.
    function _applyFill(address account, Account storage a, int256 sizeDelta, uint256 price)
        internal
        returns (int256 realized)
    {
        int256 oldSize = a.size;
        (int256 newSize, uint256 newEntry, int256 r) = PerpMath.applyTrade(oldSize, a.entryPrice, sizeDelta, price);
        realized = r;
        a.size = newSize;
        a.entryPrice = newEntry;
        _updateOpenInterest(oldSize, newSize);

        if (realized > 0) {
            uint256 owed = realized.toUint256();
            if (owed > lpPool) revert PoolInsolvent(owed, lpPool);
            lpPool -= owed;
        } else if (realized < 0) {
            // The pool is credited the full loss even if the account's margin goes negative; the
            // uncollectable part is written back against insurance/pool at liquidation. This keeps the
            // conservation identity exact: balance == sum(signed margins) + lpPool + insuranceFund.
            lpPool += (-realized).toUint256();
        }
        a.margin += realized;
        _stats[account].realizedPnl += realized;
    }

    function _updateOpenInterest(int256 oldSize, int256 newSize) internal {
        if (oldSize > 0) longOpenInterest -= oldSize.toUint256();
        else if (oldSize < 0) shortOpenInterest -= (-oldSize).toUint256();
        if (newSize > 0) longOpenInterest += newSize.toUint256();
        else if (newSize < 0) shortOpenInterest += (-newSize).toUint256();
    }

    function _updateFunding() internal {
        cumulativeFundingIndex = _pendingIndex();
        lastFundingUpdate = uint40(block.timestamp);
    }

    function _pendingIndex() internal view returns (int256) {
        uint256 dt = block.timestamp - lastFundingUpdate;
        if (dt == 0 || fundingRatePer8h == 0) return cumulativeFundingIndex;
        // USD per ETH accrued = rate * mark * dt / 8h
        int256 perEth = PerpMath.mulDivSigned(fundingRatePer8h, Math.mulDiv(markPrice(), dt, FUNDING_PERIOD), WAD);
        return cumulativeFundingIndex + perEth;
    }

    /// @dev Funding PnL for `size` over an index move. Longs pay a positive index move.
    ///      Rounded against the account (payments rounded down, charges rounded up).
    function _fundingOwed(int256 size, int256 indexDelta) internal pure returns (int256) {
        if (size == 0 || indexDelta == 0) return 0;
        uint256 mag18 = Math.mulDiv(PerpMath.abs(size), PerpMath.abs(indexDelta), WAD);
        bool receives = (size < 0) == (indexDelta > 0);
        if (receives) return (mag18 / PerpMath.USD6_TO_USD18).toInt256();
        return -Math.ceilDiv(mag18, PerpMath.USD6_TO_USD18).toInt256();
    }

    function _settleFunding(address account) internal {
        Account storage a = _accounts[account];
        int256 idx = cumulativeFundingIndex;
        int256 owed = _fundingOwed(a.size, idx - a.lastFundingIndex);
        a.lastFundingIndex = idx;
        if (owed == 0) return;
        if (owed > 0) {
            uint256 pay = owed.toUint256();
            if (pay > lpPool) revert PoolInsolvent(pay, lpPool);
            lpPool -= pay;
        } else {
            lpPool += (-owed).toUint256();
        }
        a.margin += owed;
        _stats[account].fundingPnl += owed;
        emit FundingSettled(account, owed, idx);
    }

    function _equity(Account storage a, uint256 mark, int256 fundingIndex) internal view returns (int256) {
        return
            a.margin + PerpMath.pnl(a.size, a.entryPrice, mark)
                + _fundingOwed(a.size, fundingIndex - a.lastFundingIndex);
    }

    function _marginReq(int256 size, uint256 mark, uint256 bps) internal pure returns (uint256) {
        return Math.mulDiv(PerpMath.notional(size, mark), bps, BPS, Math.Rounding.Ceil);
    }

    /// @dev exec = mark * (1 +/- (spread + notional/depth)), impact capped at maxImpactBps.
    function _executionPrice(int256 sizeDelta, uint256 mark) internal view returns (uint256) {
        MarketParams memory p = params;
        uint256 impactWad = uint256(p.spreadBps) * 1e14;
        if (p.depthUsd > 0) impactWad += Math.mulDiv(PerpMath.notional(sizeDelta, mark), WAD, p.depthUsd);
        uint256 cap = uint256(p.maxImpactBps) * 1e14;
        if (impactWad > cap) impactWad = cap;
        return sizeDelta > 0
            ? Math.mulDiv(mark, WAD + impactWad, WAD, Math.Rounding.Ceil)
            : Math.mulDiv(mark, WAD - impactWad, WAD);
    }

    function _setParams(MarketParams memory p) internal {
        if (
            p.maintenanceMarginBps == 0 || p.initialMarginBps < p.maintenanceMarginBps || p.initialMarginBps > BPS
                || p.maxImpactBps >= BPS || p.takerFeeBps > 100 || p.liquidationPenaltyBps > 1000
        ) revert InvalidParams();
        params = p;
        emit MarketParamsUpdated(p);
    }
}
