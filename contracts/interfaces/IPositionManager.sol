// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Types} from "../libraries/Types.sol";

/// @notice Read-only aggregator: turns adapter state + oracle price into protocol-level views.
interface IPositionManager {
    function snapshot() external view returns (Types.PositionSnapshot memory);

    function deltaReport(uint256 hedgeRatioBps) external view returns (Types.DeltaReport memory);

    function liquidationReport(uint256 minDistanceBps) external view returns (Types.LiquidationReport memory);

    function pnl() external view returns (Types.PnLBreakdown memory);
}
