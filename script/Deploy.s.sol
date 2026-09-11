// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ProtocolDeployer} from "./ProtocolDeployer.sol";

/// @notice Deploys the full mock-market + protocol stack and writes `deployments/<chainId>.json`.
/// @dev Defaults target a fresh Anvil (accounts #0..#3). Override any role via env for Sepolia.
///      forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract Deploy is Script, ProtocolDeployer {
    // Anvil's well-known dev keys - public, never used outside a local chain.
    uint256 internal constant ANVIL_PK_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    address internal _broadcaster;

    function _self() internal view override returns (address) {
        return _broadcaster;
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_PK_0);
        _broadcaster = vm.addr(pk);
        Roles_ memory r = Roles_({
            admin: vm.envOr("ADMIN_ADDRESS", _broadcaster),
            guardian: vm.envOr("GUARDIAN_ADDRESS", ANVIL_2),
            keeper: vm.envOr("KEEPER_ADDRESS", ANVIL_1),
            strategist: vm.envOr("STRATEGIST_ADDRESS", ANVIL_1),
            feeRecipient: vm.envOr("FEE_RECIPIENT_ADDRESS", ANVIL_3)
        });

        uint256 startBlock = block.number;
        vm.startBroadcast(pk);
        d = _deployProtocol(r);
        vm.stopBroadcast();

        _write(d, r, startBlock);
    }

    function _write(Deployment memory d, Roles_ memory r, uint256 startBlock) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeAddress(k, "admin", r.admin);
        vm.serializeAddress(k, "guardian", r.guardian);
        vm.serializeAddress(k, "keeper", r.keeper);
        vm.serializeAddress(k, "strategist", r.strategist);
        vm.serializeAddress(k, "feeRecipient", r.feeRecipient);
        vm.serializeAddress(k, "accessRegistry", address(d.registry));
        vm.serializeAddress(k, "usdc", address(d.usdc));
        vm.serializeAddress(k, "weth", address(d.weth));
        vm.serializeAddress(k, "ethUsdFeed", address(d.ethUsdFeed));
        vm.serializeAddress(k, "ethUsdFallbackFeed", address(d.ethUsdFallbackFeed));
        vm.serializeAddress(k, "lendingPool", address(d.lending));
        vm.serializeAddress(k, "perpMarket", address(d.perp));
        vm.serializeAddress(k, "spotDex", address(d.dex));
        vm.serializeAddress(k, "oracleManager", address(d.oracle));
        vm.serializeAddress(k, "feeManager", address(d.feeManager));
        vm.serializeAddress(k, "emergencyController", address(d.emergency));
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "strategyManager", address(d.strategy));
        vm.serializeAddress(k, "lendingAdapter", address(d.lendingAdapter));
        vm.serializeAddress(k, "perpAdapter", address(d.perpAdapter));
        vm.serializeAddress(k, "swapAdapter", address(d.swapAdapter));
        vm.serializeAddress(k, "positionManager", address(d.positionManager));
        vm.serializeAddress(k, "riskManager", address(d.riskManager));
        string memory json = vm.serializeAddress(k, "rebalanceManager", address(d.rebalanceManager));

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Vault:", address(d.vault));
        console2.log("Deployment written to", path);
    }
}
