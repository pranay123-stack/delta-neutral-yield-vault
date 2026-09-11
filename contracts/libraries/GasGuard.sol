// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GasGuard
/// @notice Defends try/catch fallbacks against gas griefing.
/// @dev A `try` forwards at most 63/64 of the remaining gas (EIP-150). If the callee fails because it
///      was *starved* rather than because it genuinely reverted, the caller is left with at most ~1/64 of
///      what it had. The risk: a caller picks a gas limit that makes a venue read fail inside `try` and
///      still has enough left to finish, silently steering execution onto the fallback path (a stale
///      last-good price, a NAV without pending funding) and transacting at a mispriced share value.
///      That window only exists when the work *after* the catch costs < 1/63 of the starved call.
///      test/unit/GasGriefing.t.sol scans every gas limit and shows no such window in this system
///      today (the venue reads are cheap); the guard is defence in depth for integrations whose reads
///      are expensive (real venues with heavy views, proxies, cold storage).
library GasGuard {
    error InsufficientGasForExternalCall();

    /// @param gasBefore `gasleft()` captured immediately before the `try`
    function checkNotStarved(uint256 gasBefore) internal view {
        if (gasleft() <= gasBefore / 63) revert InsufficientGasForExternalCall();
    }
}
