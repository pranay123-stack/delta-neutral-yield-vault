// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAggregatorV3} from "../interfaces/external/IAggregatorV3.sol";

/// @title MockAggregatorV3
/// @notice Chainlink-compatible price feed driven by the simulator. Keeps full round history so the
///         OracleManager's consecutive-round deviation check works exactly as against a real feed.
///         Exposes failure knobs (revert, arbitrary rounds, decimals change) for oracle-failure tests.
contract MockAggregatorV3 is IAggregatorV3, Ownable {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    uint8 public override decimals;
    string public override description;
    uint80 public latestRound;
    bool public shouldRevert;

    mapping(uint80 => Round) internal _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error FeedReverted();
    error NoData();

    constructor(uint8 decimals_, string memory description_, int256 initialAnswer) Ownable(msg.sender) {
        decimals = decimals_;
        description = description_;
        _push(initialAnswer, block.timestamp);
    }

    /// @notice Publish a new round at the current block timestamp.
    function setAnswer(int256 answer) external onlyOwner {
        _push(answer, block.timestamp);
    }

    /// @notice Publish a new round with an explicit `updatedAt` (to simulate stale / future data).
    function setAnswerAt(int256 answer, uint256 updatedAt) external onlyOwner {
        _push(answer, updatedAt);
    }

    /// @notice Overwrite a round verbatim, e.g. to create an incomplete round (answeredInRound < roundId).
    function setRawRound(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
        external
        onlyOwner
    {
        _rounds[roundId] =
            Round({answer: answer, startedAt: startedAt, updatedAt: updatedAt, answeredInRound: answeredInRound});
        if (roundId > latestRound) latestRound = roundId;
    }

    function setShouldRevert(bool value) external onlyOwner {
        shouldRevert = value;
    }

    /// @notice Simulate a feed migration that changes decimals.
    function setDecimals(uint8 value) external onlyOwner {
        decimals = value;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (shouldRevert) revert FeedReverted();
        Round memory r = _rounds[latestRound];
        return (latestRound, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
    }

    function getRoundData(uint80 roundId) external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (shouldRevert) revert FeedReverted();
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
    }

    function _push(int256 answer, uint256 updatedAt) internal {
        uint80 id = latestRound + 1;
        latestRound = id;
        _rounds[id] = Round({answer: answer, startedAt: updatedAt, updatedAt: updatedAt, answeredInRound: id});
        emit AnswerUpdated(answer, id, updatedAt);
    }
}
