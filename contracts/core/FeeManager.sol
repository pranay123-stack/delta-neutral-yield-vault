// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IFeeManager} from "../interfaces/IFeeManager.sol";

/// @title FeeManager
/// @notice Fee configuration and maths. Fees are taken by *minting shares* to the fee recipient
///         (dilution), never by moving assets, so fee collection can't strand liquidity or require the
///         strategy to unwind.
/// @dev Management fee: time-based, charged on AUM.
///        fraction f = mgmtBps * dt / (BPS * YEAR);  shares = S * f / (1 - f)
///        (minting S*f/(1-f) shares transfers exactly fraction f of the vault to the recipient)
///      Performance fee: charged only on share-price gains above the high-water mark (HWM).
///        pps = A / S';  if pps > hwm:  feeAssets = (pps - hwm) * S' * perfBps / BPS
///        shares = feeAssets * S' / (A - feeAssets);  hwm := post-fee pps
///      After a loss the HWM stays put, so no performance fee is charged until depositors are made
///      whole. Hard caps are compile-time constants - an admin (even a compromised one) cannot exceed them.
contract FeeManager is IFeeManager, Auth {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    uint16 public constant MAX_MANAGEMENT_FEE_BPS = 200; // 2% / yr
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 2000; // 20% of gains
    uint16 public constant MAX_WITHDRAWAL_FEE_BPS = 100; // 1%

    address public vault;
    address public override feeRecipient;
    uint16 public override managementFeeBps;
    uint16 public override performanceFeeBps;
    uint16 public override withdrawalFeeBps;
    uint64 public override lastAccrual;
    uint256 public override highWaterMark; // WAD-scaled assets per share-unit
    uint256 public override totalManagementFeesAssets;
    uint256 public override totalPerformanceFeesAssets;

    error OnlyVault();
    error FeeTooHigh();
    error AlreadyInitialized();

    /// @param initialHwm share price at inception (A * 1e18 / S), so the first gain is charged from day one
    constructor(
        IAccessRegistry registry_,
        address recipient_,
        uint16 mgmtBps_,
        uint16 perfBps_,
        uint16 withdrawalBps_,
        uint256 initialHwm
    ) Auth(registry_) {
        if (recipient_ == address(0)) revert ZeroAddress();
        _setFees(mgmtBps_, perfBps_, withdrawalBps_);
        feeRecipient = recipient_;
        highWaterMark = initialHwm;
    }

    function initialize(address vault_) external onlyRole(Roles.ADMIN) {
        if (vault != address(0)) revert AlreadyInitialized();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
    }

    function setFees(uint16 mgmtBps_, uint16 perfBps_, uint16 withdrawalBps_) external onlyRole(Roles.ADMIN) {
        _setFees(mgmtBps_, perfBps_, withdrawalBps_);
    }

    function setFeeRecipient(address recipient_) external onlyRole(Roles.ADMIN) {
        if (recipient_ == address(0)) revert ZeroAddress();
        feeRecipient = recipient_;
        emit FeeRecipientUpdated(recipient_);
    }

    function previewAccrual(uint256 totalAssets, uint256 totalSupply)
        public
        view
        override
        returns (uint256 mgmtShares, uint256 perfShares)
    {
        (mgmtShares, perfShares,,,) = _compute(totalAssets, totalSupply);
    }

    function accrue(uint256 totalAssets, uint256 totalSupply)
        external
        override
        returns (uint256 mgmtShares, uint256 perfShares)
    {
        if (msg.sender != vault) revert OnlyVault();
        uint256 newHwm;
        uint256 mgmtAssets;
        uint256 perfAssets;
        (mgmtShares, perfShares, newHwm, mgmtAssets, perfAssets) = _compute(totalAssets, totalSupply);
        lastAccrual = uint64(block.timestamp);
        highWaterMark = newHwm;
        if (mgmtShares | perfShares != 0) {
            totalManagementFeesAssets += mgmtAssets;
            totalPerformanceFeesAssets += perfAssets;
            emit FeesAccrued(mgmtShares, perfShares, mgmtAssets, perfAssets, newHwm);
        }
    }

    function _compute(uint256 a, uint256 s)
        internal
        view
        returns (uint256 mgmtShares, uint256 perfShares, uint256 newHwm, uint256 mgmtAssets, uint256 perfAssets)
    {
        newHwm = highWaterMark;
        if (s == 0 || a == 0 || lastAccrual == 0) return (0, 0, newHwm, 0, 0);

        uint256 dt = block.timestamp - lastAccrual;
        if (dt > 0 && managementFeeBps > 0) {
            uint256 f = Math.mulDiv(uint256(managementFeeBps) * dt, WAD, BPS * YEAR);
            if (f < WAD) mgmtShares = Math.mulDiv(s, f, WAD - f);
        }
        uint256 s1 = s + mgmtShares;

        uint256 pps = Math.mulDiv(a, WAD, s1);
        if (pps > newHwm) {
            if (performanceFeeBps > 0) {
                uint256 gain = Math.mulDiv(pps - newHwm, s1, WAD);
                perfAssets = Math.mulDiv(gain, performanceFeeBps, BPS);
                if (perfAssets > 0 && perfAssets < a) perfShares = Math.mulDiv(perfAssets, s1, a - perfAssets);
            }
            newHwm = Math.mulDiv(a, WAD, s1 + perfShares);
        }
        mgmtAssets = Math.mulDiv(mgmtShares, a, s1 + perfShares);
        if (perfShares == 0) perfAssets = 0;
    }

    function _setFees(uint16 m, uint16 p, uint16 w) internal {
        if (m > MAX_MANAGEMENT_FEE_BPS || p > MAX_PERFORMANCE_FEE_BPS || w > MAX_WITHDRAWAL_FEE_BPS) {
            revert FeeTooHigh();
        }
        managementFeeBps = m;
        performanceFeeBps = p;
        withdrawalFeeBps = w;
        emit FeeConfigUpdated(m, p, w);
    }
}
