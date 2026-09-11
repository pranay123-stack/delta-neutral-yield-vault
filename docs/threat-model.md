# Threat model

## Assets

1. Depositor USDC: vault idle, USDC reserve, WETH long, perp margin.
2. Share-price integrity: fair entry and exit prices.
3. Protocol liveness: the hedge must be maintained and withdrawals must stay possible.

## Actors and trust

| Actor | Trust | Can | Cannot |
|---|---|---|---|
| Depositor | untrusted | deposit, withdraw/redeem (liquid), `redeemWithUnwind`, `accrueFees` | trade, move other users' funds |
| Attacker | hostile | any public call, any gas limit, flash liquidity, donations, frontrunning | roles |
| KEEPER | semi-trusted (liveness) | choose *when* to rebalance, poke oracle, observe vol, checkpoint | choose *what* a rebalance does, move funds |
| STRATEGIST | semi-trusted | set targets inside admin bounds | exceed bounds, touch funds |
| GUARDIAN | trusted for safety | pause deposits/strategy, shut the oracle down, emergency-unwind into the vault | unpause, change params, send funds anywhere but the vault |
| ADMIN (timelock) | trusted, slow | configure within compile-time caps, grant roles, unpause | exceed caps, sweep funds, pause withdrawals |
| Venues (lending, perp, DEX) | trusted to settle | hold positions, execute | - |
| Oracle feeds | semi-trusted | publish rounds | pass a single manipulated round (deviation guard) |

## STRIDE-style walkthrough

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| Spoofing a role | call keeper/guardian functions | `AccessRegistry` roles; one-tx rotation | key compromise, below |
| Tampering with the rebalance plan | malicious keeper passes `performData` | plan recomputed on-chain; `performData` ignored | a keeper can *delay* rebalances (liveness) |
| Tampering with NAV | donate tokens to the vault/strategy | virtual shares make it unprofitable; donations only raise the share price | none material |
| Tampering with price | manipulate one oracle round / DEX pool | deviation guard; trades bounded at oracle ± 1%; delta ≈ 0 | a *sustained* feed manipulation across rounds is only bounded by delta ≈ 0 and slippage limits |
| Repudiation | - | every state change emits events; indexer stores them | - |
| Information disclosure | - | public protocol | - |
| Denial of service (withdrawals) | lending utilisation → 100% locks the reserve | `maxWithdraw` reports it honestly; `redeemWithUnwind` exits via the basis legs; alert `liquidity.reserve` | if the basis venues are *also* frozen, exits wait |
| Denial of service (keeper) | keeper offline / gas spike | urgent plans bypass filters when the keeper returns; alerts; production: decentralised keepers | a long outage + a large move can reach venue liquidation (scenario I) |
| Elevation of privilege | admin raises fees, disables risk | compile-time caps and sanity bounds; timelock delay | a malicious admin can still set aggressive-but-legal parameters; a timelock gives users time to exit |

## Specific attack scenarios

**1. Inflation attack on the first depositor.** The attacker deposits 1 wei, donates $10k, and the
victim deposits $10k. With a 6-decimal virtual offset the victim still gets ~all of their value and the
attacker loses the donation (`test_inflationAttack_unprofitable`, fuzzed to $1M donations).

**2. Harvest sandwich.** No harvest exists: interest and funding accrue in `totalAssets` continuously.
Fee crystallisation doesn't move the share price (pending fees are already in the conversions).

**3. Oracle-move sandwich.** Deposit before an oracle update, withdraw after. NAV sensitivity to price
is net delta x move: at the 200 bps band, a 5% move changes the share price by 0.1%, less than trading
costs, and standard withdrawals are liquidity-capped.

**4. Keeper MEV.** The rebalance's DEX swap could be sandwiched. Min-out is derived from the oracle, so
the worst case is the 1% bound per trade, and non-urgent trades with high estimated cost are skipped.
On an L2 with a private mempool / sequencer this is further reduced.

**5. Perp venue failure.** The venue is exploited or halts. Loss is capped at the posted margin (~30%
of NAV) and the vault becomes a naked long (delta ~60% of NAV). The guardian can unwind the long leg
and the reserve with explicit price bounds; the perp step fails best-effort and the rest completes
(`test_emergencyUnwind_bestEffort_whenDexBroken` shows the per-venue isolation).

**6. Lending pool insolvency or freeze.** The reserve and the long leg (~70% of NAV) sit in one pool:
the largest single-venue risk. Production mitigation: split across several lending adapters with
per-venue caps (the risk engine's exposure metric becomes a hard limit).

**7. Funding regime shift.** Months of negative funding: defensive mode limits the bleed (p5 annual
return 2.5% vs −0.7% without it, in the persistent-funding Monte Carlo) but can't create yield.

**8. Admin key compromise.** Parameters can be moved within caps (e.g. fees to 2% / 20%, leverage to
3x). Funds can't be redirected: there is no sweep and no arbitrary-target call anywhere. With a timelock,
depositors see the change coming and exit.

**9. Guardian key compromise.** Can pause deposits and strategy (liveness), shut the oracle down
(blocks share operations until unwound), or emergency-unwind into the vault (terminal shutdown, all
funds exitable). Can't steal. Worst case: forced exit at unwind cost; the price bounds are
guardian-chosen, so a malicious guardian could accept a bad fill on the long-leg sale.

**10. Keeper key compromise.** Can call `performUpkeep` only when the on-chain plan says so, and it
can't change the plan. Worst case: extra gas spend, or withholding rebalances.

**11. Gas griefing.** A caller picks a gas limit that makes a try/catch'd venue read fail and pushes
execution onto a fallback path. Mitigated by `GasGuard`; scan tests prove no reachable window.

**12. Read-only reentrancy.** An integrator reads `totalAssets` mid-transaction. The vault's transient
price cache is closed before any token transfer, and USDC has no hooks.

## Out of scope

Chain-level attacks (reorgs beyond finality, sequencer censorship), front-end compromise, social
engineering, and the correctness of the real protocols a production version would integrate.
