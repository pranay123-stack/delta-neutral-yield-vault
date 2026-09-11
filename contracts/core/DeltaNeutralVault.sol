// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Auth} from "../access/Auth.sol";
import {Roles} from "../access/Roles.sol";
import {IAccessRegistry} from "../interfaces/IAccessRegistry.sol";
import {IDeltaNeutralVault} from "../interfaces/IDeltaNeutralVault.sol";
import {IEmergencyController} from "../interfaces/IEmergencyController.sol";
import {IFeeManager} from "../interfaces/IFeeManager.sol";
import {IStrategyManager} from "../interfaces/IStrategyManager.sol";
import {Types} from "../libraries/Types.sol";

/// @title DeltaNeutralVault
/// @notice ERC-4626 USDC vault whose share price tracks the NAV of a delta-neutral basis strategy.
/// @dev Design points (see docs/architecture.md, docs/security.md):
///      - Inflation/donation attack: OZ virtual shares with a 6-decimal offset. An attacker must
///        donate ~1e6x the victim's deposit to steal a fraction of it.
///      - NAV is marked continuously (interest + funding accrue in `totalAssets`), so there is no
///        discrete harvest step to sandwich.
///      - Pending fees are included in every conversion, so previews are exact before accrual.
///      - Standard withdraw/redeem are served from liquid assets only (idle + USDC reserve) and never
///        trade; `maxWithdraw` reports exactly that liquidity. Exits larger than the buffer use
///        `redeemWithUnwind`, where the exiting user - not the remaining holders - pays the unwind cost.
///      - Share operations are blocked while the oracle is unhealthy and positions are open (NAV
///        unknown). Withdrawals are otherwise never pausable.
contract DeltaNeutralVault is ERC4626, IDeltaNeutralVault, Auth, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint8 internal constant DECIMALS_OFFSET = 6;
    uint256 internal constant BPS = 10_000;

    IFeeManager public immutable feeManager;
    IEmergencyController public immutable emergency;

    IStrategyManager public strategy;
    address public rebalanceManager;
    uint256 public depositCap;

    event Initialized(address strategy, address rebalanceManager);

    error OnlyRebalancer();
    error NotInitialized();
    error ZeroShares();

    constructor(
        IERC20 usdc_,
        IAccessRegistry registry_,
        IFeeManager feeManager_,
        IEmergencyController emergency_,
        uint256 depositCap_
    ) ERC4626(usdc_) ERC20("Delta Neutral USDC Vault", "dnUSDC") Auth(registry_) {
        if (address(feeManager_) == address(0) || address(emergency_) == address(0)) {
            revert ZeroAddress();
        }
        feeManager = feeManager_;
        emergency = emergency_;
        depositCap = depositCap_;
    }

    function initialize(IStrategyManager strategy_, address rebalanceManager_) external onlyRole(Roles.ADMIN) {
        if (address(strategy) != address(0)) revert AlreadyInitialized();
        if (address(strategy_) == address(0) || rebalanceManager_ == address(0)) revert ZeroAddress();
        strategy = strategy_;
        rebalanceManager = rebalanceManager_;
        emit Initialized(address(strategy_), rebalanceManager_);
    }

    function setDepositCap(uint256 cap) external onlyRole(Roles.ADMIN) {
        depositCap = cap;
        emit DepositCapUpdated(cap);
    }

    // ------------------------------------------------------------------
    // ERC-4626 accounting
    // ------------------------------------------------------------------

    /// @notice Idle USDC + strategy NAV. Never reverts (uses the last good price if the oracle is down).
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        IStrategyManager s = strategy;
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        return address(s) == address(0) ? idle : idle + s.totalAssets();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev Same as OZ but the share supply includes fee shares that would be minted right now.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 ta = totalAssets();
        return assets.mulDiv(totalSupply() + _pendingFeeShares(ta) + 10 ** DECIMALS_OFFSET, ta + 1, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 ta = totalAssets();
        return shares.mulDiv(ta + 1, totalSupply() + _pendingFeeShares(ta) + 10 ** DECIMALS_OFFSET, rounding);
    }

    /// @dev Withdrawal fee is charged on top of the requested assets and stays in the vault.
    function previewWithdraw(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        return super.previewWithdraw(assets + _feeOnRaw(assets));
    }

    function previewRedeem(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 assets = super.previewRedeem(shares);
        return assets - _feeOnTotal(assets);
    }

    // ------------------------------------------------------------------
    // Limits
    // ------------------------------------------------------------------

    function maxDeposit(address) public view override(ERC4626, IERC4626) returns (uint256) {
        if (address(strategy) == address(0) || emergency.depositsPaused() || emergency.isShutdown() || !isOperational())
        {
            return 0;
        }
        uint256 ta = totalAssets();
        return depositCap > ta ? depositCap - ta : 0;
    }

    function maxMint(address receiver) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : _convertToShares(assets, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override(ERC4626, IERC4626) returns (uint256) {
        if (!isOperational()) return 0;
        return Math.min(previewRedeem(balanceOf(owner)), availableLiquidity());
    }

    function maxRedeem(address owner) public view override(ERC4626, IERC4626) returns (uint256) {
        if (!isOperational()) return 0;
        uint256 bal = balanceOf(owner);
        uint256 liquidity = availableLiquidity();
        // shares whose net-of-fee redemption fits in the available liquidity
        uint256 grossLiquidity = liquidity.mulDiv(BPS, BPS - feeManager.withdrawalFeeBps());
        return Math.min(bal, _convertToShares(grossLiquidity, Math.Rounding.Floor));
    }

    // ------------------------------------------------------------------
    // Entry / exit
    // ------------------------------------------------------------------

    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256)
    {
        _accrueFees();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override(ERC4626, IERC4626) nonReentrant returns (uint256) {
        _accrueFees();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256)
    {
        _accrueFees();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override(ERC4626, IERC4626)
        nonReentrant
        returns (uint256)
    {
        _accrueFees();
        return super.redeem(shares, receiver, owner);
    }

    /// @inheritdoc IDeltaNeutralVault
    function redeemWithUnwind(uint256 shares, address receiver, address owner, uint256 minAssetsOut)
        external
        override
        nonReentrant
        returns (uint256 assets)
    {
        if (!isOperational()) revert OracleUnhealthy();
        if (shares == 0) revert ZeroShares();
        _accrueFees();
        uint256 gross = previewRedeem(shares); // net of the withdrawal fee, which stays in the vault
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares); // effects before any external interaction

        IERC20 usdc = IERC20(asset());
        uint256 idle = usdc.balanceOf(address(this));
        if (idle < gross) {
            uint256 need = gross - idle;
            uint256 liquid = strategy.withdrawLiquid(need);
            if (liquid < need) strategy.unwindFor(need - liquid);
        }
        assets = Math.min(gross, usdc.balanceOf(address(this)));
        if (assets < minAssetsOut) revert SlippageExceeded(assets, minAssetsOut);
        usdc.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        emit RedeemWithUnwind(owner, receiver, shares, gross, assets);
    }

    /// @dev Pull liquidity from the strategy reserve if idle cash doesn't cover the withdrawal.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        IERC20 usdc = IERC20(asset());
        uint256 idle = usdc.balanceOf(address(this));
        if (idle < assets) {
            strategy.withdrawLiquid(assets - idle);
            uint256 available = usdc.balanceOf(address(this));
            if (available < assets) revert InsufficientLiquidity(assets, available);
        }
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (shares == 0) revert ZeroShares();
        super._deposit(caller, receiver, assets, shares);
    }

    // ------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------

    function accrueFees() external override nonReentrant {
        _accrueFees();
    }

    function _accrueFees() internal {
        // Never crystallise fees on an untrusted NAV.
        if (address(strategy) == address(0) || !isOperational()) return;
        (uint256 mgmt, uint256 perf) = feeManager.accrue(totalAssets(), totalSupply());
        uint256 feeShares = mgmt + perf;
        if (feeShares > 0) {
            address recipient = feeManager.feeRecipient();
            _mint(recipient, feeShares);
            emit FeeSharesMinted(recipient, feeShares);
        }
    }

    function _pendingFeeShares(uint256 ta) internal view returns (uint256) {
        if (address(strategy) == address(0)) return 0;
        (uint256 mgmt, uint256 perf) = feeManager.previewAccrual(ta, totalSupply());
        return mgmt + perf;
    }

    function _feeOnRaw(uint256 assets) internal view returns (uint256) {
        uint256 bps = feeManager.withdrawalFeeBps();
        return bps == 0 ? 0 : assets.mulDiv(bps, BPS, Math.Rounding.Ceil);
    }

    function _feeOnTotal(uint256 assets) internal view returns (uint256) {
        uint256 bps = feeManager.withdrawalFeeBps();
        return bps == 0 ? 0 : assets.mulDiv(bps, bps + BPS, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------
    // Strategy plumbing & views
    // ------------------------------------------------------------------

    function pushToStrategy(uint256 amount) external override nonReentrant {
        if (msg.sender != rebalanceManager) revert OnlyRebalancer();
        IERC20(asset()).safeTransfer(address(strategy), amount);
        strategy.onCapitalReceived(amount);
        emit PushedToStrategy(amount);
    }

    function sharePrice() external view override returns (uint256) {
        return convertToAssets(10 ** decimals()) * 1e12;
    }

    function idleAssets() external view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function availableLiquidity() public view override returns (uint256) {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        return address(strategy) == address(0) ? idle : idle + strategy.availableLiquidity();
    }

    function isOperational() public view override returns (bool) {
        IStrategyManager s = strategy;
        if (address(s) == address(0)) return true;
        if (!s.isPriceDependent()) return true;
        (, Types.OracleStatus status) = s.oracle().tryGetPrice(s.weth());
        return status == Types.OracleStatus.OK || status == Types.OracleStatus.FALLBACK;
    }
}
