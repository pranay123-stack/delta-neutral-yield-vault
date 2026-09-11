/**
 * Turn wallet / RPC / revert errors into one readable line. Custom Solidity errors are decoded against
 * every ABI in @dnv/shared (a vault call can revert inside the strategy stack), then humanised for the
 * ones a depositor actually hits.
 */
import * as abis from "@dnv/shared/abis";
import { SHARE_DECIMALS, USD_DECIMALS } from "@dnv/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  UserRejectedRequestError,
  decodeErrorResult,
  formatUnits,
} from "viem";

import { fmtNum } from "./format";

type AbiError = Extract<Abi[number], { type: "error" }>;

const ALL_ERRORS: Abi = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  for (const abi of Object.values(abis) as unknown as Abi[]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
})();

const usdc = (v: unknown) => (typeof v === "bigint" ? `${fmtNum(Number(formatUnits(v, USD_DECIMALS)), 2)} USDC` : String(v));
const shares = (v: unknown) => (typeof v === "bigint" ? `${fmtNum(Number(formatUnits(v, SHARE_DECIMALS)), 4)} shares` : String(v));

function humanise(name: string, args: readonly unknown[] = []): string {
  const [a, b, c] = args;
  switch (name) {
    case "ERC4626ExceededMaxWithdraw":
      return `ERC4626ExceededMaxWithdraw: requested ${usdc(b)} but only ${usdc(c)} is withdrawable from liquid assets. Use Redeem with unwind for larger exits.`;
    case "ERC4626ExceededMaxRedeem":
      return `ERC4626ExceededMaxRedeem: requested ${shares(b)} but only ${shares(c)} can be redeemed from liquid assets. Use Redeem with unwind for larger exits.`;
    case "ERC4626ExceededMaxDeposit":
      return `ERC4626ExceededMaxDeposit: ${usdc(b)} exceeds the deposit limit of ${usdc(c)}.`;
    case "ERC20InsufficientAllowance":
      return `ERC20InsufficientAllowance: allowance ${usdc(b)}, needed ${usdc(c)}. Approve first.`;
    case "ERC20InsufficientBalance":
      return `ERC20InsufficientBalance: balance ${String(b)} < needed ${String(c)} (raw units).`;
    case "InsufficientLiquidity":
      return `InsufficientLiquidity: requested ${usdc(a)}, available ${usdc(b)}.`;
    case "SlippageExceeded":
      return `SlippageExceeded: would receive ${usdc(a)}, below your minimum of ${usdc(b)}. Raise the slippage tolerance or redeem less.`;
    case "FaucetLimitExceeded":
      return `FaucetLimitExceeded: requested ${usdc(a)}, the faucet limit is ${usdc(b)} per call.`;
    case "DepositsPaused":
      return "DepositsPaused: the guardian has paused deposits.";
    case "OracleUnhealthy":
      return "OracleUnhealthy: the price feed is unhealthy, so the vault refuses to price shares until it recovers.";
    case "ZeroShares":
      return "ZeroShares: the amount is too small to mint or burn a share.";
    case "Unauthorized":
      return "Unauthorized: this account lacks the role required for the call.";
    default:
      return args.length ? `${name}(${args.map(String).join(", ")})` : name;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Request rejected in the wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName && revert.data.errorName !== "Error") {
        return humanise(revert.data.errorName, revert.data.args ?? []);
      }
      if (revert.raw) {
        try {
          const decoded = decodeErrorResult({ abi: ALL_ERRORS, data: revert.raw as Hex });
          return humanise(decoded.errorName, (decoded.args ?? []) as readonly unknown[]);
        } catch {
          /* unknown selector */
        }
      }
      if (revert.reason) return `Reverted: ${revert.reason}`;
      return revert.shortMessage;
    }
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
