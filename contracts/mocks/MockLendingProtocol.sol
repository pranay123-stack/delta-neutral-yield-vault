// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILendingPool} from "../interfaces/external/ILendingPool.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title MockLendingProtocol
/// @notice Aave-V3-shaped, multi-asset supply market used as the lending leg in the local demo.
/// @dev Mechanics that match production lending markets:
///        - scaled balances + liquidity index (balances grow continuously without per-user writes)
///        - kinked utilisation-based borrow curve, supply rate = borrow * U * (1 - reserveFactor)
///        - withdrawals limited by available liquidity (supplied - borrowed): the real "bank run" risk
///      What is simulated: borrowers are virtual. `totalDebt` is an accounting number the simulator
///      sets via `setUtilization`, and borrower interest payments are represented by minting the
///      supply-side interest into the pool on accrual. Supply-side solvency is exact: the pool always
///      holds at least the sum of all supplier balances (interest is minted rounding up).
contract MockLendingProtocol is ILendingPool, Ownable {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    struct RateModel {
        uint64 baseRate; // WAD APR at 0% utilisation
        uint64 slope1; // added APR from 0 -> optimal utilisation
        uint64 slope2; // added APR from optimal -> 100% utilisation
        uint64 optimalUtilization; // WAD
        uint64 reserveFactor; // WAD share of borrow interest kept by the protocol
    }

    struct Reserve {
        bool active;
        uint40 lastUpdate;
        uint256 liquidityIndex; // WAD
        uint256 totalScaled;
        uint256 totalDebt; // virtual borrowed underlying, grows at the borrow rate
        RateModel model;
    }

    mapping(address asset => Reserve) internal _reserves;
    mapping(address asset => mapping(address user => uint256)) public scaledBalanceOf;

    event ReserveInitialized(address indexed asset, RateModel model);
    event RateModelUpdated(address indexed asset, RateModel model);
    event Supply(address indexed asset, address indexed user, address indexed onBehalfOf, uint256 amount);
    event Withdraw(address indexed asset, address indexed user, address indexed to, uint256 amount);
    event UtilizationSet(address indexed asset, uint256 utilization, uint256 totalDebt);
    event InterestAccrued(address indexed asset, uint256 liquidityIndex, uint256 minted);

    error ReserveNotActive(address asset);
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 balance);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InvalidRateModel();
    error InvalidUtilization();

    constructor() Ownable(msg.sender) {}

    // ------------------------------------------------------------------
    // Admin / simulation controls
    // ------------------------------------------------------------------

    /// @dev The pool must be a minter on `asset` (MockERC20) so accrued interest can be materialised.
    function initReserve(address asset, RateModel calldata model) external onlyOwner {
        _validateModel(model);
        Reserve storage r = _reserves[asset];
        r.active = true;
        r.lastUpdate = uint40(block.timestamp);
        r.liquidityIndex = WAD;
        r.model = model;
        emit ReserveInitialized(asset, model);
    }

    function setRateModel(address asset, RateModel calldata model) external onlyOwner {
        _validateModel(model);
        _accrue(asset);
        _reserves[asset].model = model;
        emit RateModelUpdated(asset, model);
    }

    /// @notice Simulate external borrowers so that utilisation equals `targetUtilization` (WAD).
    function setUtilization(address asset, uint256 targetUtilization) external onlyOwner {
        if (targetUtilization > WAD) revert InvalidUtilization();
        _accrue(asset);
        Reserve storage r = _reserves[asset];
        r.totalDebt = Math.mulDiv(_totalSupplied(r), targetUtilization, WAD);
        emit UtilizationSet(asset, targetUtilization, r.totalDebt);
    }

    // ------------------------------------------------------------------
    // ILendingPool
    // ------------------------------------------------------------------

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        if (amount == 0) revert ZeroAmount();
        Reserve storage r = _accrue(asset);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 scaled = Math.mulDiv(amount, WAD, r.liquidityIndex); // round down: supplier-unfavourable
        scaledBalanceOf[asset][onBehalfOf] += scaled;
        r.totalScaled += scaled;
        emit Supply(asset, msg.sender, onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external override returns (uint256) {
        Reserve storage r = _accrue(asset);
        uint256 userScaled = scaledBalanceOf[asset][msg.sender];
        uint256 balance = Math.mulDiv(userScaled, r.liquidityIndex, WAD);
        if (amount == type(uint256).max) amount = balance;
        if (amount == 0) revert ZeroAmount();
        if (amount > balance) revert InsufficientBalance(amount, balance);
        uint256 available = _available(r);
        if (amount > available) revert InsufficientLiquidity(amount, available);

        // round the burn up so a withdrawal can never extract more than it owns
        uint256 scaledBurn = Math.mulDiv(amount, WAD, r.liquidityIndex, Math.Rounding.Ceil);
        if (scaledBurn > userScaled) scaledBurn = userScaled;
        scaledBalanceOf[asset][msg.sender] = userScaled - scaledBurn;
        r.totalScaled -= scaledBurn;

        IERC20(asset).safeTransfer(to, amount);
        emit Withdraw(asset, msg.sender, to, amount);
        return amount;
    }

    function getReserveNormalizedIncome(address asset) external view override returns (uint256) {
        (uint256 index,) = _projected(_reserves[asset]);
        return index;
    }

    function balanceOf(address asset, address user) external view override returns (uint256) {
        (uint256 index,) = _projected(_reserves[asset]);
        return Math.mulDiv(scaledBalanceOf[asset][user], index, WAD);
    }

    function supplyRate(address asset) public view override returns (uint256) {
        Reserve storage r = _reserves[asset];
        (uint256 index, uint256 debt) = _projected(r);
        uint256 u = _utilization(Math.mulDiv(r.totalScaled, index, WAD), debt);
        return _supplyRate(r.model, u);
    }

    function borrowRate(address asset) public view override returns (uint256) {
        Reserve storage r = _reserves[asset];
        (uint256 index, uint256 debt) = _projected(r);
        return _borrowRate(r.model, _utilization(Math.mulDiv(r.totalScaled, index, WAD), debt));
    }

    function utilization(address asset) external view override returns (uint256) {
        Reserve storage r = _reserves[asset];
        (uint256 index, uint256 debt) = _projected(r);
        return _utilization(Math.mulDiv(r.totalScaled, index, WAD), debt);
    }

    function availableLiquidity(address asset) external view override returns (uint256) {
        Reserve storage r = _reserves[asset];
        (uint256 index, uint256 debt) = _projected(r);
        uint256 supplied = Math.mulDiv(r.totalScaled, index, WAD);
        return supplied > debt ? supplied - debt : 0;
    }

    function totalSupplied(address asset) external view returns (uint256) {
        Reserve storage r = _reserves[asset];
        (uint256 index,) = _projected(r);
        return Math.mulDiv(r.totalScaled, index, WAD);
    }

    function totalDebt(address asset) external view returns (uint256) {
        (, uint256 debt) = _projected(_reserves[asset]);
        return debt;
    }

    function getRateModel(address asset) external view returns (RateModel memory) {
        return _reserves[asset].model;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _accrue(address asset) internal returns (Reserve storage r) {
        r = _reserves[asset];
        if (!r.active) revert ReserveNotActive(asset);
        if (r.lastUpdate == block.timestamp) return r;
        uint256 oldIndex = r.liquidityIndex;
        (uint256 newIndex, uint256 newDebt) = _projected(r);
        r.liquidityIndex = newIndex;
        r.totalDebt = newDebt;
        r.lastUpdate = uint40(block.timestamp);
        if (newIndex > oldIndex && r.totalScaled > 0) {
            // Materialise supplier interest (stand-in for borrower repayments). Rounded up so the pool
            // always holds >= sum of supplier balances.
            uint256 minted = Math.mulDiv(r.totalScaled, newIndex - oldIndex, WAD, Math.Rounding.Ceil);
            MockERC20(asset).mint(address(this), minted);
            emit InterestAccrued(asset, newIndex, minted);
        }
    }

    /// @dev Linear interest over the elapsed period (Aave's supply-side convention).
    function _projected(Reserve storage r) internal view returns (uint256 index, uint256 debt) {
        index = r.liquidityIndex;
        debt = r.totalDebt;
        uint256 dt = block.timestamp - r.lastUpdate;
        if (dt == 0 || !r.active) return (index, debt);
        uint256 supplied = Math.mulDiv(r.totalScaled, index, WAD);
        uint256 u = _utilization(supplied, debt);
        uint256 bRate = _borrowRate(r.model, u);
        uint256 sRate = _supplyRate(r.model, u);
        index = Math.mulDiv(index, WAD + (sRate * dt) / YEAR, WAD);
        debt = Math.mulDiv(debt, WAD + (bRate * dt) / YEAR, WAD);
    }

    function _totalSupplied(Reserve storage r) internal view returns (uint256) {
        return Math.mulDiv(r.totalScaled, r.liquidityIndex, WAD);
    }

    function _available(Reserve storage r) internal view returns (uint256) {
        uint256 supplied = _totalSupplied(r);
        return supplied > r.totalDebt ? supplied - r.totalDebt : 0;
    }

    function _utilization(uint256 supplied, uint256 debt) internal pure returns (uint256) {
        if (supplied == 0) return 0;
        uint256 u = Math.mulDiv(debt, WAD, supplied);
        return u > WAD ? WAD : u;
    }

    function _borrowRate(RateModel memory m, uint256 u) internal pure returns (uint256) {
        if (u <= m.optimalUtilization) {
            return m.baseRate + Math.mulDiv(m.slope1, u, m.optimalUtilization);
        }
        uint256 excess = Math.mulDiv(u - m.optimalUtilization, WAD, WAD - m.optimalUtilization);
        return m.baseRate + m.slope1 + Math.mulDiv(m.slope2, excess, WAD);
    }

    function _supplyRate(RateModel memory m, uint256 u) internal pure returns (uint256) {
        uint256 b = _borrowRate(m, u);
        return Math.mulDiv(Math.mulDiv(b, u, WAD), WAD - m.reserveFactor, WAD);
    }

    function _validateModel(RateModel calldata m) internal pure {
        if (m.optimalUtilization == 0 || m.optimalUtilization >= WAD || m.reserveFactor >= WAD) {
            revert InvalidRateModel();
        }
    }
}
