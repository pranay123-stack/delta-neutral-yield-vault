# Security review

Scope: `contracts/` excluding `contracts/mocks/` (simulation infrastructure). Solidity 0.8.28,
OpenZeppelin 5.4.0, Cancun EVM. Method: design review against the threat model
([threat-model.md](threat-model.md)), property-based testing (fuzz, invariants, a16z ERC-4626 suite,
long random walks), Slither 0.11.6, and running the whole system on a local chain for 90 simulated
days with a live keeper, indexer and random user flows.

This is a self-review of a portfolio project, **not an audit**. It has not been reviewed by a third
party, and it must not hold real funds.

## 1. Controls by threat

| Threat | Control | Evidence |
|---|---|---|
| **Reentrancy** | `nonReentrant` (EIP-1153 transient guard) on every vault entry point, every strategy function and `performUpkeep`; effects before interactions in `redeemWithUnwind` (shares burned before any external call); adapters callable only by the strategy; the vault's transient price cache is closed before any token moves | `test_*_onlyStrategy`, `test_vaultOnlyEntrypoints`; Slither reentrancy findings triaged below |
| **ERC-4626 inflation / donation** | OZ virtual shares, 6-decimal offset; zero-share deposits revert | `test_inflationAttack_unprofitable`, `testFuzz_inflationAttack` (donations up to $1M: the attacker never extracts more than they put in) |
| **Share-price manipulation** | NAV marked continuously (no harvest jump); delta ≈ 0 so an oracle move barely moves NAV; pending fees included in conversions; fee maths on the same virtual price as conversions | 26/26 a16z ERC-4626 properties with fees on and `_delta_ = 0`; `test_previewIncludesPendingFees` |
| **Oracle manipulation** | consecutive-round deviation guard (single rounds rejected until confirmed); fallback feed; decimals check; guardian shutdown; every trade bounded at oracle ± max slippage | 24 oracle tests; `test_executeRebalance_dexWorseThanOracle_reverts` |
| **Stale prices** | heartbeat check; last good price used only to *display* NAV; share operations and trading blocked while unhealthy and exposed | scenario G; `test_oracleUnhealthy_blocksShareOps_whenPositioned`; `test_performUpkeep_revertsOnStaleOracle` |
| **Adapter vulnerabilities** | adapters immutable, bound to one strategy (checked at `initialize`), `onlyStrategy`, pull pattern (a reverting venue call moves nothing), funds only ever return to the strategy; no idle balances left in adapters | `invariant_noStrandedFunds`; `test_initialize_rejectsAdaptersBoundElsewhere`; `test_emergencyUnwind_bestEffort_whenDexBroken` (WETH stays in the strategy, not the adapter) |
| **Incorrect PnL accounting** | attribution identity `NAV − netCapital == netPnl` by construction | `invariant_pnlReconcilesToNav` after every random call, 3,000-step walk, liquidation walk, 90-day replay residual $0.0000 |
| **Rounding** | OZ rounding directions (deposit/redeem floor, mint/withdraw ceil); lending supply rounds down, burn rounds up, interest minted up; venue funding rounded against the account | `test_rounding_favoursVault`; `testFuzz_depositRedeem_noFreeValue`; `testFuzz_supplyWithdraw_neverProfitsWithoutTime`; `invariant_lendingVenueSolvent` |
| **Precision loss** | `Math.mulDiv` for all products; `SafeCast` for every sign change (no unchecked casts in production code, enforced by `forge lint`); units documented in `Types.sol` | lint clean on `contracts/` |
| **Unauthorized rebalancing** | `performUpkeep` KEEPER-only; plan recomputed on-chain (keeper can't inject one); `executeRebalance` only from the RebalanceManager; strategist targets bounded by admin | `invariant_unauthorizedNeverRebalances`; access-control matrix tests |
| **Excessive leverage** | vol-scaled target; leverage bands; post-rebalance validation (≤ 3.5x or strictly improving); config ceiling 5x; venue IMR | `test_leverage_escalatesThroughStates`; `test_validateRebalance_*`; `test_config_boundsEnforced` |
| **Liquidation risk** | urgent rebalance below 30% distance (bypasses cooldown/cost filters); liquidation distance as a HIGH_RISK/EMERGENCY metric; alerts | scenario A jump, scenario I squeeze (keeper on: 0 liquidations; off: liquidated) |
| **Bad debt** | isolated margin caps loss at posted margin; NAV floors equity at 0; `badDebtAbsorbed` keeps attribution exact | `test_perpLiquidation_accountingConsistent_andRehedge`; lazy-keeper walk (forced liquidations) |
| **Strategy insolvency** | vault can't promise more than liquidity (`maxWithdraw` bounded); withdrawals can't exceed max (`withdrawOverLimit` probe); lending withdrawals liquidity-checked | `invariant_maxWithdrawWithinLiquidity`, `invariant_sharesBacked`, `invariant_assetsEqualSumOfLegs` |
| **Emergency withdrawals** | withdrawals unpausable; guardian `emergencyUnwind` with explicit price bounds works with the oracle dead; best-effort per venue, repeatable; terminal shutdown | `test_emergencyUnwind_returnsEverythingToVault` (exits succeed with both feeds reverting) |
| **Admin abuse** | role separation (ADMIN / GUARDIAN / KEEPER / STRATEGIST); guardian can only reduce risk; unpause needs ADMIN; no sweep function anywhere; compile-time caps on fees, leverage, slippage, liquidation buffer; one-shot `initialize`; intended ADMIN = timelock | `test_guardianCannotRedirectFunds`; `test_feeCaps_enforced`; `test_config_boundsEnforced`; `test_initialize_*` |
| **Gas griefing of try/catch fallbacks** | `GasGuard.checkNotStarved` on every fallback path | `GasGriefing.t.sol` scans every gas limit for `totalAssets` and `deposit` |

## 2. Bugs found during development

Real defects, each caught by a specific technique and fixed with a regression test. They are the most
useful part of this review.

| # | Bug | Impact | Caught by | Fix |
|---|---|---|---|---|
| 1 | `redeemWithUnwind` released `f x equity` measured *before* closing the hedge slice | remaining holders paid ~4 bps of every large exit | scenario test asserting remaining-holder value | release `equityAfter − (1 − f) x equityBefore` |
| 2 | rebalance spent cash before raising it (buy before withdrawing surplus margin) | relevers after a price drop reverted `InsufficientReserve` | reasoning through scenario B, then tests | execution order: sell → margin → buy → hedge → free margin |
| 3 | `checkUpkeep` ignored the vol observation `performUpkeep` records first | check says "yes", perform reverts: wasted keeper tx | fuzz counterexample | views use the *projected* EWMA |
| 4 | performance fee measured on raw assets/supply, conversions on virtual | phantom fee between two operations; round trip returned extra shares | a16z ERC-4626 property suite (5 failures) | `_feeBasis` passes virtual-adjusted totals |
| 5 | after a deep ETH decline, perp equity is unrealised profit that venues won't release | margin withdrawals silently no-op'd; relevers reverted; hourly no-op rebalances | TS Monte Carlo (57 no-ops on one path) → `DeepDeclineTest` | crystallise just enough PnL (close + reopen a slice) |
| 6 | carry-blocked allocation drift still executed a margin-only move | keeper gas for nothing (6 of 10 rebalances in a replay) | 90-day on-chain replay + indexed data | margin resized only when leverage is out of band |
| 7 | keeper sent with the raw gas estimate | on-chain reverts: accrual paths short-circuit when `dt == 0` inside an estimate | keeper run log from the replay | 30% gas buffer; simulate first |
| 8 | backend read the cached head block | state read right after a tx described the *previous* block | the demo printing delta 0 after an ADL | `getBlockNumber({ cacheTime: 0 })` |
| 9 | `totalAssets` reverted when a lending read did | ERC-4626 requires it never to revert: `maxWithdraw` panicked (0x11) mid-replay and killed a 90-day run. The perp leg had a fallback, the lending leg did not | a 90-day replay dying on `panic: arithmetic underflow or overflow`; reproduced in Foundry by serving a call 2 s before the venue's last checkpoint | try/catch + `GasGuard` around every lending read (valuation, liquidity, snapshot, PnL), falling back to the adapter's own checkpoint; `block.timestamp - lastUpdate` made saturating in `FeeManager` and both venue mocks |

Bugs 5-9 only showed up by *running* the system end to end.

Bug 9 is worth expanding, because the trigger is subtle. The local chain warps time
(`evm_increaseTime`) and mints blocks faster than the wall clock, so a call could be served at a
timestamp *earlier* than a checkpoint written by a block that had already been mined. Every
`block.timestamp - lastUpdate` in the accrual paths then underflowed. A real chain's clock is
monotonic, so that exact trigger is local-only - but the *shape* of the failure is not: any venue view
that reverts (a paused or removed Aave reserve, a bad proxy upgrade, a starved call) took `totalAssets`
down with it, which breaks share pricing, the risk engine and the dashboard at once. The hedge leg had
been given try/catch fallbacks early; the lending leg had been left unprotected. The fix closes the
asymmetry and costs ~0.2% gas ([gas-report.md](gas-report.md)). The fallback reads adapter storage
only, and understates (never overstates) NAV, so it cannot be used to mint shares cheaply; quoted
liquidity collapses to the idle float, so the vault never advertises an exit it cannot honour.

## 3. Static analysis (Slither 0.11.6)

`slither . --config-file slither.config.json` (mocks, tests, scripts excluded): 97 results after fixes,
all triaged.

| Detector | # | Verdict |
|---|---|---|
| `arbitrary-send-erc20` (High) | 3 | **False positive.** `transferFrom(strategy, ...)` in the adapters: `from` is the immutable bound strategy and each function is `onlyStrategy`. |
| `reentrancy-balance` (High) | 2 | **False positive.** `redeemWithUnwind` reads the vault balance after calls to the (immutable, trusted) strategy. That is the intended "what actually came back" accounting that makes the exiting user bear their own cost; the function is `nonReentrant`. |
| `reentrancy-no-eth` | 6 | **Accepted.** State written after calls to trusted venues/adapters inside `nonReentrant`, role-gated functions. `performUpkeep` gained `nonReentrant` as defence in depth. |
| `incorrect-equality` | 17 | **False positive.** All are `== 0` or sentinel guards on values an attacker can't steer (no balance equality checks). |
| `unused-return` | 20 | **Accepted.** Every ignored return is either bounded beforehand (withdrawable checked) or re-checked via balances; partially-used tuples are intentional. |
| `uninitialized-local` | 10 | **False positive.** Intentional zero-initialisation. |
| `reentrancy-benign`, `reentrancy-events` | 20 | Accepted (events after trusted calls). |
| `timestamp` | 14 | Accepted: staleness, cooldown, accrual. Validator skew of seconds is irrelevant at 1 h granularity. |
| `low-level-calls` | 1 | `_adapterStrategy` staticcall at `initialize`, admin-only, return length checked. |
| `unimplemented-functions` | 1 | False positive (`AccessRegistry.hasRole` overrides both parents). |
| `cyclomatic-complexity` | 3 | Informational (planner, risk assessment). |

Fixed from the first pass: missing zero-address checks (`PositionManager`), dead code
(`Auth._hasRole`), unindexed event addresses.

## 4. Known limitations and residual risks

- **Trusted venues.** The system trusts the lending pool, the perp venue and the DEX to settle. A venue
  exploit loses the capital held there: up to ~70% of NAV in the lending pool, ~30% on the perp.
- **Centralised demo keeper** with a hot key. A dead keeper doesn't lose funds directly, but the hedge
  isn't maintained (scenario I, keeper off: liquidated).
- **ADMIN is an EOA in the demo.** Production must put ADMIN behind a timelock + multisig and GUARDIAN
  behind a separate fast multisig.
- **USDC assumed $1.** No depeg handling.
- **No L2 sequencer-uptime check** in `OracleManager`.
- **Mock perp marks at the oracle price**: no mark/index basis, no funding derived from premium.
- **Contracts are not upgradeable** by design; bugs require migration (redeploy + exit + re-deposit).
- **Venue exposure** is a warning-only metric because there is a single lending venue.
