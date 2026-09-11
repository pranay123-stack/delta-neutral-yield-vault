/**
 * Headroom added to every gas estimate before a transaction is sent - by the keeper, the market driver,
 * the demo script and the dashboard.
 *
 * An estimate runs against the latest block. When that block has just written the vault's accrual
 * checkpoints (fees, lending interest, perp funding), no time has elapsed, so the estimate skips the
 * accrual work; a transaction landing even one second later pays for it, and EIP-150's 63/64 rule turns
 * a small shortfall into a starved venue call that reverts. Measured on Anvil, the share operations need
 * 8-14% more than their estimate one second later; 30% leaves roughly 2x margin.
 * `backend/test/gasHeadroom.integration.test.ts` guards this constant against a real node, and
 * docs/security.md (bugs 7 and 10) has the history.
 */
export const GAS_HEADROOM_PCT = 30n;

export function withGasHeadroom(estimate: bigint): bigint {
  return (estimate * (100n + GAS_HEADROOM_PCT)) / 100n;
}
