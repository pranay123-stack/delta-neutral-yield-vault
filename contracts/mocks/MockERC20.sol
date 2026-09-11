// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Test token (mUSDC / mWETH). NOT a real asset: anyone can faucet a bounded amount so the
///         local demo needs no real money. Minter role exists so mock venues can mint accrued interest.
contract MockERC20 is ERC20, Ownable {
    uint8 private immutable _decimals;
    uint256 public immutable faucetLimit;

    mapping(address => bool) public isMinter;

    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();
    error FaucetLimitExceeded(uint256 requested, uint256 limit);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetLimit_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        _decimals = decimals_;
        faucetLimit = faucetLimit_;
        isMinter[msg.sender] = true;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Demo faucet - mints up to `faucetLimit` per call to the caller.
    function faucet(uint256 amount) external {
        if (amount > faucetLimit) revert FaucetLimitExceeded(amount, faucetLimit);
        _mint(msg.sender, amount);
    }
}
