// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILendingAdapter} from "../interfaces/IAdapters.sol";
import {ILendingPool} from "../interfaces/external/ILendingPool.sol";

/// @title LendingAdapter
/// @notice Holds the strategy's supply positions (USDC reserve + WETH long leg) on an Aave-shaped pool.
/// @dev Swapping MockLendingProtocol for Aave V3 means changing the balance/rate views to read the
///      aToken and `getReserveData`; the supply/withdraw calls are already the Aave signatures.
///      Interest is tracked by checkpointing the balance on every interaction: anything the balance
///      grew by between interactions is interest, because only this adapter moves principal.
contract LendingAdapter is ILendingAdapter {
    using SafeERC20 for IERC20;

    ILendingPool public immutable pool;
    address public immutable strategy;

    mapping(address asset => uint256) internal _principal;
    mapping(address asset => uint256) internal _interestCheckpointed;
    mapping(address asset => uint256) internal _lastBalance;

    error OnlyStrategy();
    error ZeroAddress();

    modifier onlyStrategy() {
        _onlyStrategy();
        _;
    }

    function _onlyStrategy() internal view {
        if (msg.sender != strategy) revert OnlyStrategy();
    }

    /// @param assets tokens this adapter will supply; the pool gets a standing approval for each
    ///        (saves a ~22k-gas approval per supply; the pool is the trusted venue itself).
    constructor(ILendingPool pool_, address strategy_, address[] memory assets) {
        if (address(pool_) == address(0) || strategy_ == address(0)) revert ZeroAddress();
        pool = pool_;
        strategy = strategy_;
        for (uint256 i; i < assets.length; ++i) {
            IERC20(assets[i]).forceApprove(address(pool_), type(uint256).max);
        }
    }

    function supply(address asset, uint256 amount) external override onlyStrategy {
        _checkpoint(asset);
        IERC20(asset).safeTransferFrom(strategy, address(this), amount);
        pool.supply(asset, amount, address(this), 0);
        _principal[asset] += amount;
        _lastBalance[asset] = pool.balanceOf(asset, address(this));
        emit Supplied(asset, amount);
    }

    function withdraw(address asset, uint256 amount) external override onlyStrategy returns (uint256 withdrawn) {
        uint256 balanceBefore = _checkpoint(asset);
        if (amount == type(uint256).max) amount = _withdrawable(asset, balanceBefore);
        if (amount == 0) return 0;
        withdrawn = pool.withdraw(asset, amount, strategy);
        // principal is reduced pro-rata: a withdrawal takes principal and interest in proportion
        uint256 p = _principal[asset];
        _principal[asset] = p - Math.mulDiv(p, withdrawn, balanceBefore);
        _lastBalance[asset] = pool.balanceOf(asset, address(this));
        emit Withdrawn(asset, withdrawn);
    }

    function balanceOf(address asset) external view override returns (uint256) {
        return pool.balanceOf(asset, address(this));
    }

    function principalOf(address asset) external view override returns (uint256) {
        return _principal[asset];
    }

    /// @inheritdoc ILendingAdapter
    function lastKnownBalance(address asset) external view override returns (uint256) {
        return _lastBalance[asset];
    }

    /// @inheritdoc ILendingAdapter
    function checkpointedInterest(address asset) external view override returns (uint256) {
        return _interestCheckpointed[asset];
    }

    function cumulativeInterest(address asset) external view override returns (uint256) {
        uint256 bal = pool.balanceOf(asset, address(this));
        uint256 last = _lastBalance[asset];
        return _interestCheckpointed[asset] + (bal > last ? bal - last : 0);
    }

    function withdrawable(address asset) external view override returns (uint256) {
        return _withdrawable(asset, pool.balanceOf(asset, address(this)));
    }

    function supplyRate(address asset) external view override returns (uint256) {
        return pool.supplyRate(asset);
    }

    function utilization(address asset) external view override returns (uint256) {
        return pool.utilization(asset);
    }

    function venue() external view override returns (address) {
        return address(pool);
    }

    function _withdrawable(address asset, uint256 balance) internal view returns (uint256) {
        return Math.min(balance, pool.availableLiquidity(asset));
    }

    function _checkpoint(address asset) internal returns (uint256 bal) {
        bal = pool.balanceOf(asset, address(this));
        uint256 last = _lastBalance[asset];
        if (bal > last) _interestCheckpointed[asset] += bal - last;
        _lastBalance[asset] = bal;
    }
}
