"use client";

import { SHARE_DECIMALS, USD_DECIMALS, type VaultView as VaultInfo, deltaNeutralVaultAbi, mockERC20Abi } from "@dnv/shared";
import { useState } from "react";
import { type Address, formatUnits, isAddress, zeroAddress } from "viem";
import { useBalance, useConfig, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import { readContract, simulateContract, writeContract } from "wagmi/actions";

import { TransactionsTable } from "@/app/transactions/TransactionsView";
import { WalletOptions, useWalletActions } from "@/components/layout/WalletMenu";
import { Badge } from "@/components/ui/Badge";
import { Card, Note, cx } from "@/components/ui/Card";
import { ErrorState, SkeletonRows } from "@/components/ui/QueryState";
import { Segmented } from "@/components/ui/Segmented";
import { KV } from "@/components/ui/Stat";
import { AmountInput, fmtUnits, parseAmount, unitsToInput, useDebounced } from "@/components/vault/AmountInput";
import { TxStatus } from "@/components/vault/TxStatus";
import { accountLabel } from "@/lib/demo";
import { CHAIN_ID, POLL_LIVE } from "@/lib/env";
import { fmtNum, fmtPct, fmtUsd, shortHex } from "@/lib/format";
import { useTransactions, useVault } from "@/lib/queries";
import { type TxStepSpec, useTxRunner } from "@/lib/tx";

type Tab = "deposit" | "withdraw" | "redeem" | "unwind";

const TABS: { value: Tab; label: string }[] = [
  { value: "deposit", label: "Deposit" },
  { value: "withdraw", label: "Withdraw" },
  { value: "redeem", label: "Redeem" },
  { value: "unwind", label: "Unwind exit" },
];

const usdcStr = (v: bigint | undefined, digits = 2) => (v === undefined ? "—" : `${fmtUnits(v, USD_DECIMALS, digits)} USDC`);
const sharesStr = (v: bigint | undefined, digits = 4) => (v === undefined ? "—" : `${fmtUnits(v, SHARE_DECIMALS, digits)} dnUSDC`);

export function VaultView() {
  const vaultQ = useVault();
  if (!vaultQ.data) {
    if (vaultQ.isError) {
      return (
        <Card title="Vault unavailable">
          <ErrorState error={vaultQ.error} onRetry={() => void vaultQ.refetch()} />
          <p className="mt-3 text-xs text-muted">The vault and USDC addresses come from GET /vault, so user actions need the backend API.</p>
        </Card>
      );
    }
    return (
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Loading vault…">
          <SkeletonRows rows={6} />
        </Card>
        <Card title="Actions" className="lg:col-span-2">
          <SkeletonRows rows={8} />
        </Card>
      </div>
    );
  }
  const info = vaultQ.data;
  if (!isAddress(info.address) || !isAddress(info.asset)) {
    return <ErrorState error={new Error(`GET /vault returned invalid addresses (${info.address}, ${info.asset})`)} />;
  }
  return <VaultActions info={info} vault={info.address} usdc={info.asset} />;
}

function VaultActions({ info, vault, usdc }: { info: VaultInfo; vault: Address; usdc: Address }) {
  const config = useConfig();
  const { connection, disconnectAll } = useWalletActions();
  const switchChain = useSwitchChain();
  const tx = useTxRunner();
  const user = connection.isConnected ? connection.address : undefined;
  const wrongChain = connection.isConnected && connection.chainId !== CHAIN_ID;
  const who = user ?? zeroAddress;

  // ---- on-chain reads --------------------------------------------------------------------------
  const global = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "availableLiquidity" },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "isOperational" },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "totalSupply" },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "totalAssets" },
      { address: usdc, abi: mockERC20Abi, functionName: "faucetLimit" },
    ],
    query: { refetchInterval: POLL_LIVE },
  });
  const mine = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: usdc, abi: mockERC20Abi, functionName: "balanceOf", args: [who] },
      { address: usdc, abi: mockERC20Abi, functionName: "allowance", args: [who, vault] },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "balanceOf", args: [who] },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "maxWithdraw", args: [who] },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "maxRedeem", args: [who] },
      { address: vault, abi: deltaNeutralVaultAbi, functionName: "maxDeposit", args: [who] },
    ],
    query: { enabled: Boolean(user), refetchInterval: POLL_LIVE },
  });
  const [availableLiquidity, operational, totalSupply, , faucetLimit] = global.data ?? [];
  const [usdcBal, allowance, shares, maxWithdraw, maxRedeem, maxDeposit] = user ? (mine.data ?? []) : [];

  const shareValue = useReadContract({
    address: vault,
    abi: deltaNeutralVaultAbi,
    functionName: "convertToAssets",
    args: [shares ?? 0n],
    query: { enabled: shares !== undefined && shares > 0n, refetchInterval: POLL_LIVE },
  });
  const ethBal = useBalance({ address: user, query: { enabled: Boolean(user), refetchInterval: POLL_LIVE } });

  // ---- inputs + previews -----------------------------------------------------------------------
  const [tab, setTab] = useState<Tab>("deposit");
  const [depIn, setDepIn] = useState("");
  const [wdIn, setWdIn] = useState("");
  const [rdIn, setRdIn] = useState("");
  const [uwIn, setUwIn] = useState("");
  const [slipIn, setSlipIn] = useState("1");
  const [faucetIn, setFaucetIn] = useState("10000");

  const depAmt = parseAmount(depIn, USD_DECIMALS);
  const wdAmt = parseAmount(wdIn, USD_DECIMALS);
  const rdShares = parseAmount(rdIn, SHARE_DECIMALS);
  const uwShares = parseAmount(uwIn, SHARE_DECIMALS);
  const faucetAmt = parseAmount(faucetIn, USD_DECIMALS);
  const slipPct = Number(slipIn);
  const slipValid = slipIn.trim() !== "" && Number.isFinite(slipPct) && slipPct >= 0 && slipPct <= 50;
  const slipBps = slipValid ? Math.round(slipPct * 100) : 100;

  const dDep = useDebounced(depAmt);
  const dWd = useDebounced(wdAmt);
  const dRd = useDebounced(rdShares);
  const dUw = useDebounced(uwShares);

  const previewDeposit = useReadContract({
    address: vault,
    abi: deltaNeutralVaultAbi,
    functionName: "previewDeposit",
    args: [dDep ?? 0n],
    query: { enabled: tab === "deposit" && !!dDep && dDep > 0n, refetchInterval: POLL_LIVE },
  });
  const previewWithdraw = useReadContract({
    address: vault,
    abi: deltaNeutralVaultAbi,
    functionName: "previewWithdraw",
    args: [dWd ?? 0n],
    query: { enabled: tab === "withdraw" && !!dWd && dWd > 0n, refetchInterval: POLL_LIVE },
  });
  const previewRedeem = useReadContract({
    address: vault,
    abi: deltaNeutralVaultAbi,
    functionName: "previewRedeem",
    args: [dRd ?? 0n],
    query: { enabled: tab === "redeem" && !!dRd && dRd > 0n, refetchInterval: POLL_LIVE },
  });
  const previewUnwind = useReadContract({
    address: vault,
    abi: deltaNeutralVaultAbi,
    functionName: "previewRedeem",
    args: [dUw ?? 0n],
    query: { enabled: tab === "unwind" && !!dUw && dUw > 0n, refetchInterval: POLL_LIVE },
  });
  const unwindMinOut = previewUnwind.data !== undefined ? (previewUnwind.data * BigInt(10_000 - slipBps)) / 10_000n : undefined;

  const canAct = Boolean(user) && !wrongChain && !tx.state.running;

  // ---- transactions ----------------------------------------------------------------------------
  const approveStep = (amount: bigint): TxStepSpec => ({
    label: `Approve ${usdcStr(amount)}`,
    send: async () => {
      const { request } = await simulateContract(config, { chainId: CHAIN_ID, address: usdc, abi: mockERC20Abi, functionName: "approve", args: [vault, amount] });
      return writeContract(config, request);
    },
  });

  async function onFaucet() {
    if (!faucetAmt || faucetAmt <= 0n) return;
    await tx.run("Faucet", [
      {
        label: `Mint ${usdcStr(faucetAmt, 0)}`,
        send: async () => {
          const { request } = await simulateContract(config, { chainId: CHAIN_ID, address: usdc, abi: mockERC20Abi, functionName: "faucet", args: [faucetAmt] });
          return writeContract(config, request);
        },
      },
    ]);
  }

  async function onDeposit() {
    if (!user || !depAmt || depAmt <= 0n) return;
    const amount = depAmt;
    const steps: TxStepSpec[] = [];
    if ((allowance ?? 0n) < amount) steps.push(approveStep(amount));
    steps.push({
      label: `Deposit ${usdcStr(amount)}`,
      send: async () => {
        const { request } = await simulateContract(config, { chainId: CHAIN_ID, address: vault, abi: deltaNeutralVaultAbi, functionName: "deposit", args: [amount, user] });
        return writeContract(config, request);
      },
    });
    if (await tx.run(steps.length > 1 ? "Approve + deposit" : "Deposit", steps)) setDepIn("");
  }

  async function onWithdraw() {
    if (!user || !wdAmt || wdAmt <= 0n) return;
    const amount = wdAmt;
    const ok = await tx.run("Withdraw", [
      {
        label: `Withdraw ${usdcStr(amount)}`,
        send: async () => {
          const { request } = await simulateContract(config, { chainId: CHAIN_ID, address: vault, abi: deltaNeutralVaultAbi, functionName: "withdraw", args: [amount, user, user] });
          return writeContract(config, request);
        },
      },
    ]);
    if (ok) setWdIn("");
  }

  async function onRedeem() {
    if (!user || !rdShares || rdShares <= 0n) return;
    const amount = rdShares;
    const ok = await tx.run("Redeem", [
      {
        label: `Redeem ${sharesStr(amount)}`,
        send: async () => {
          const { request } = await simulateContract(config, { chainId: CHAIN_ID, address: vault, abi: deltaNeutralVaultAbi, functionName: "redeem", args: [amount, user, user] });
          return writeContract(config, request);
        },
      },
    ]);
    if (ok) setRdIn("");
  }

  async function onUnwind() {
    if (!user || !uwShares || uwShares <= 0n) return;
    const amount = uwShares;
    const bps = BigInt(10_000 - slipBps);
    const ok = await tx.run("Redeem with unwind", [
      {
        label: `Redeem ${sharesStr(amount)} with unwind (max slippage ${fmtPct(slipBps / 10_000, 2)})`,
        send: async () => {
          // re-quote at submit time so minAssetsOut is never based on a stale preview
          const gross = await readContract(config, { chainId: CHAIN_ID, address: vault, abi: deltaNeutralVaultAbi, functionName: "previewRedeem", args: [amount] });
          const minAssetsOut = (gross * bps) / 10_000n;
          const { request } = await simulateContract(config, {
            chainId: CHAIN_ID,
            address: vault,
            abi: deltaNeutralVaultAbi,
            functionName: "redeemWithUnwind",
            args: [amount, user, user, minAssetsOut],
          });
          return writeContract(config, request);
        },
      },
    ]);
    if (ok) setUwIn("");
  }

  // ---- derived ---------------------------------------------------------------------------------
  const sharePctOfVault = shares !== undefined && totalSupply ? Number(shares) / Number(totalSupply) : undefined;
  const label = accountLabel(user);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MiniStat label="Share price" value={info.sharePrice.toFixed(6)} sub="USDC per dnUSDC" />
        <MiniStat label="TVL" value={fmtUsd(info.tvlUsd, { digits: 0 })} sub={`cap ${fmtUsd(info.depositCapUsd, { digits: 0, compact: true })}`} />
        <MiniStat label="Liquid now" value={availableLiquidity !== undefined ? usdcStr(availableLiquidity, 0) : fmtUsd(info.availableLiquidityUsd, { digits: 0 })} sub="idle + USDC reserve (on-chain)" />
        <div className="rounded-lg border border-line bg-panel px-4 py-3">
          <div className="text-[0.7rem] font-medium uppercase tracking-[0.06em] text-muted">Vault status</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {operational === undefined ? (
              <Badge>…</Badge>
            ) : operational ? (
              <Badge level="normal">operational</Badge>
            ) : (
              <Badge level="crit">oracle unhealthy</Badge>
            )}
            {info.depositsPaused && <Badge level="crit">deposits paused</Badge>}
            {info.shutdown && <Badge level="crit">shutdown</Badge>}
          </div>
        </div>
        <MiniStat label="Contracts" value={<span className="font-mono text-sm">{shortHex(vault)}</span>} sub={<span className="font-mono">USDC {shortHex(usdc)}</span>} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Card title="Wallet" subtitle={connection.isConnected ? `via ${connection.connector?.name ?? "wallet"}` : "Connect to deposit"}>
            {!connection.isConnected ? (
              <WalletOptions />
            ) : (
              <div className="space-y-3">
                <div>
                  {label && <div className="text-base font-semibold text-ink">{label}</div>}
                  <div className="break-all font-mono text-xs text-ink-2">{user}</div>
                </div>
                {wrongChain && (
                  <div className="space-y-2">
                    <Note tone="warn">Your wallet is on chain {connection.chainId}; this vault lives on Anvil (31337).</Note>
                    <button type="button" className="btn btn-primary w-full" onClick={() => switchChain.mutate({ chainId: CHAIN_ID })}>
                      Switch to Anvil (31337)
                    </button>
                  </div>
                )}
                <KV
                  rows={[
                    { label: "Vault shares", value: sharesStr(shares) },
                    { label: "Share value", value: shares === 0n ? "0.00 USDC" : usdcStr(shareValue.data) },
                    { label: "Share of vault", value: sharePctOfVault === undefined ? "—" : fmtPct(sharePctOfVault, 3) },
                    { label: "USDC balance", value: usdcStr(usdcBal) },
                    { label: "USDC allowance", value: allowance !== undefined && allowance > 10n ** 30n ? "unlimited" : usdcStr(allowance) },
                    { label: "ETH (gas)", value: ethBal.data ? `${fmtNum(Number(formatUnits(ethBal.data.value, 18)), 3)} ETH` : "—" },
                  ]}
                />
                {mine.isError && <ErrorState error={mine.error} compact />}
                <button type="button" className="btn btn-ghost w-full" onClick={() => void disconnectAll()}>
                  Disconnect
                </button>
              </div>
            )}
          </Card>

          <Card title="Faucet" subtitle="Mock USDC (6 decimals) - mint test funds">
            <div className="space-y-3">
              <AmountInput
                id="faucet"
                label="Amount"
                unit="mUSDC"
                value={faucetIn}
                onChange={setFaucetIn}
                onMax={faucetLimit !== undefined ? () => setFaucetIn(unitsToInput(faucetLimit, USD_DECIMALS)) : undefined}
                maxLabel={faucetLimit !== undefined ? `limit ${usdcStr(faucetLimit, 0)} per call` : undefined}
                invalid={faucetIn !== "" && faucetAmt === null}
              />
              {faucetAmt !== null && faucetLimit !== undefined && faucetAmt > faucetLimit && (
                <p className="text-xs text-warn">Above the per-call limit - the faucet will revert with FaucetLimitExceeded.</p>
              )}
              <button type="button" className="btn btn-primary w-full" disabled={!canAct || !faucetAmt || faucetAmt <= 0n} onClick={() => void onFaucet()}>
                Mint USDC
              </button>
            </div>
          </Card>
        </div>

        <div className="space-y-5 lg:col-span-2">
          <Card
            title="Vault actions"
            subtitle="Every call is simulated first (revert reasons decoded), then sent and awaited to its receipt"
            action={<Segmented ariaLabel="Action" options={TABS} value={tab} onChange={setTab} />}
          >
            {!user && <div className="mb-4"><Note>Connect a wallet (a demo wallet needs zero setup) to enable actions. Previews work once an amount is entered.</Note></div>}

            {tab === "deposit" && (
              <ActionPanel
                input={
                  <AmountInput
                    id="deposit"
                    label="Deposit USDC"
                    unit="USDC"
                    value={depIn}
                    onChange={setDepIn}
                    onMax={usdcBal !== undefined ? () => setDepIn(unitsToInput(maxDeposit !== undefined && maxDeposit < usdcBal ? maxDeposit : usdcBal, USD_DECIMALS)) : undefined}
                    maxLabel={user ? `balance ${usdcStr(usdcBal)}` : undefined}
                    invalid={depIn !== "" && depAmt === null}
                  />
                }
                preview={[
                  { label: "You receive (previewDeposit)", value: sharesStr(previewDeposit.data) },
                  { label: "Deposit limit (maxDeposit)", value: usdcStr(maxDeposit, 0) },
                  { label: "Approval needed", value: depAmt && allowance !== undefined ? (allowance >= depAmt ? "no - allowance covers it" : "yes - approve step first") : "—" },
                ]}
                warnings={[
                  depAmt && usdcBal !== undefined && depAmt > usdcBal ? "Exceeds your USDC balance - mint some with the faucet first (the deposit would revert with ERC20InsufficientBalance)." : null,
                  depAmt && maxDeposit !== undefined && depAmt > maxDeposit ? "Exceeds maxDeposit - will revert with ERC4626ExceededMaxDeposit." : null,
                ]}
                button={
                  <button type="button" className="btn btn-primary" disabled={!canAct || !depAmt || depAmt <= 0n} onClick={() => void onDeposit()}>
                    {depAmt && allowance !== undefined && allowance < depAmt ? "Approve & deposit" : "Deposit"}
                  </button>
                }
              />
            )}

            {tab === "withdraw" && (
              <ActionPanel
                input={
                  <AmountInput
                    id="withdraw"
                    label="Withdraw USDC (exact assets out)"
                    unit="USDC"
                    value={wdIn}
                    onChange={setWdIn}
                    onMax={maxWithdraw !== undefined ? () => setWdIn(unitsToInput(maxWithdraw, USD_DECIMALS)) : undefined}
                    maxLabel={user ? `max ${usdcStr(maxWithdraw)}` : undefined}
                    invalid={wdIn !== "" && wdAmt === null}
                  />
                }
                preview={[
                  { label: "Shares burned (previewWithdraw)", value: sharesStr(previewWithdraw.data) },
                  { label: "Liquid max (maxWithdraw)", value: usdcStr(maxWithdraw) },
                  { label: "Your position value", value: usdcStr(shareValue.data) },
                ]}
                warnings={[
                  wdAmt && maxWithdraw !== undefined && wdAmt > maxWithdraw
                    ? "Exceeds the liquid max: the vault will revert with ERC4626ExceededMaxWithdraw. Use Unwind exit for amounts beyond idle + reserve."
                    : null,
                ]}
                button={
                  <button type="button" className="btn btn-primary" disabled={!canAct || !wdAmt || wdAmt <= 0n} onClick={() => void onWithdraw()}>
                    Withdraw
                  </button>
                }
              />
            )}

            {tab === "redeem" && (
              <ActionPanel
                input={
                  <AmountInput
                    id="redeem"
                    label="Redeem shares (exact shares in)"
                    unit="dnUSDC"
                    value={rdIn}
                    onChange={setRdIn}
                    onMax={maxRedeem !== undefined ? () => setRdIn(unitsToInput(maxRedeem, SHARE_DECIMALS)) : undefined}
                    maxLabel={user ? `max ${sharesStr(maxRedeem)}` : undefined}
                    invalid={rdIn !== "" && rdShares === null}
                  />
                }
                preview={[
                  { label: "You receive (previewRedeem)", value: usdcStr(previewRedeem.data) },
                  { label: "Liquid max (maxRedeem)", value: sharesStr(maxRedeem) },
                  { label: "Your shares", value: sharesStr(shares) },
                ]}
                warnings={[
                  rdShares && maxRedeem !== undefined && rdShares > maxRedeem
                    ? "Exceeds the liquid max: the vault will revert with ERC4626ExceededMaxRedeem. Use Unwind exit instead."
                    : null,
                ]}
                button={
                  <button type="button" className="btn btn-primary" disabled={!canAct || !rdShares || rdShares <= 0n} onClick={() => void onRedeem()}>
                    Redeem
                  </button>
                }
              />
            )}

            {tab === "unwind" && (
              <ActionPanel
                input={
                  <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
                    <AmountInput
                      id="unwind"
                      label="Shares"
                      unit="dnUSDC"
                      value={uwIn}
                      onChange={setUwIn}
                      onMax={shares !== undefined ? () => setUwIn(unitsToInput(shares, SHARE_DECIMALS)) : undefined}
                      maxLabel={user ? `balance ${sharesStr(shares)}` : undefined}
                      invalid={uwIn !== "" && uwShares === null}
                    />
                    <div>
                      <label htmlFor="slippage" className="mb-1 block text-xs font-medium text-ink-2">
                        Max slippage
                      </label>
                      <div className="relative">
                        <input id="slippage" className={cx("input pr-8 text-base", !slipValid && "border-crit/70")} inputMode="decimal" value={slipIn} onChange={(e) => setSlipIn(e.target.value)} />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">%</span>
                      </div>
                    </div>
                  </div>
                }
                preview={[
                  { label: "Gross value (previewRedeem)", value: usdcStr(previewUnwind.data) },
                  { label: `minAssetsOut (−${fmtPct(slipBps / 10_000, 2)})`, value: usdcStr(unwindMinOut) },
                  { label: "Paid from liquidity first (vault-wide)", value: availableLiquidity !== undefined ? usdcStr(availableLiquidity) : "—" },
                ]}
                warnings={[
                  !slipValid ? "Slippage must be between 0% and 50%." : null,
                  uwShares && shares !== undefined && uwShares > shares ? "More shares than you hold - will revert with ERC20InsufficientBalance." : null,
                ]}
                button={
                  <button type="button" className="btn btn-primary" disabled={!canAct || !uwShares || uwShares <= 0n || !slipValid} onClick={() => void onUnwind()}>
                    Redeem with unwind
                  </button>
                }
              />
            )}

            <div className="mt-4">
              <TxStatus state={tx.state} onDismiss={tx.reset} />
            </div>
          </Card>

          <Card title="How exits work" subtitle="Liquid exits vs unwind exits">
            <div className="space-y-2.5 text-[0.8125rem] leading-relaxed text-ink-2">
              <p>
                <span className="font-medium text-ink">Withdraw / Redeem</span> (standard ERC-4626) only pay out of <span className="text-ink">liquid assets</span>: idle USDC in the vault plus the USDC
                lending reserve - right now <span className="font-medium text-ink">{availableLiquidity !== undefined ? usdcStr(availableLiquidity, 0) : fmtUsd(info.availableLiquidityUsd, { digits: 0 })}</span>.
                They never trade, so remaining depositors are untouched. <code className="font-mono text-xs">maxWithdraw</code> / <code className="font-mono text-xs">maxRedeem</code> are capped by that liquidity.
              </p>
              <p>
                <span className="font-medium text-ink">Redeem with unwind</span> handles larger exits: the vault sells part of the WETH long and closes the matching perp short to raise USDC,
                and <span className="text-ink">the exiting user pays that unwind&apos;s slippage and fees</span> (their payout is reduced, not the vault&apos;s NAV).
                <code className="font-mono text-xs"> minAssetsOut = previewRedeem × (1 − slippage)</code> protects you: the call reverts with SlippageExceeded if the unwind costs more.
              </p>
              <p className="text-xs text-muted">Shares have 12 decimals (6 asset + 6 virtual offset, an inflation-attack defence); USDC has 6.</p>
            </div>
          </Card>
        </div>
      </div>

      {user && <MyTransactions user={user} />}
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel px-4 py-3">
      <div className="truncate text-[0.7rem] font-medium uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function ActionPanel({
  input,
  preview,
  warnings,
  button,
}: {
  input: React.ReactNode;
  preview: { label: string; value: React.ReactNode }[];
  warnings: (string | null | false | undefined | 0n)[];
  button: React.ReactNode;
}) {
  const shown = warnings.filter((w): w is string => typeof w === "string" && w.length > 0);
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-3">
        {input}
        {shown.map((w) => (
          <p key={w} className="text-xs leading-relaxed text-warn">
            {w}
          </p>
        ))}
        <div>{button}</div>
      </div>
      <div className="rounded-md border border-line bg-panel-2 px-3 py-2">
        <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-muted">Live preview (on-chain reads)</div>
        <KV rows={preview} />
      </div>
    </div>
  );
}

function MyTransactions({ user }: { user: string }) {
  const txs = useTransactions();
  const mine = (txs.data ?? []).filter((t) => t.owner.toLowerCase() === user.toLowerCase()).sort((a, b) => b.ts - a.ts || b.id - a.id);
  return (
    <Card title="Your vault transactions" subtitle="From the indexer (appears a few seconds after the receipt)" flush>
      {txs.isError && !txs.data ? (
        <div className="p-4">
          <ErrorState error={txs.error} compact />
        </div>
      ) : mine.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">{txs.data ? "No deposits or withdrawals from this account yet." : "Loading…"}</p>
      ) : (
        <TransactionsTable list={mine} compact />
      )}
    </Card>
  );
}
