"use client";

import { useBlock } from "wagmi";

import { cx } from "@/components/ui/Card";
import { RPC_URL } from "@/lib/env";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { useHealth } from "@/lib/queries";

/** Persistent top strip: demo disclaimer + live chain block / chain time (straight from the RPC) + API status. */
export function DemoBanner() {
  const block = useBlock({ watch: true, query: { refetchInterval: 4_000, retry: 1 } });
  const health = useHealth();

  const apiState = health.data ? (health.data.ok ? "ok" : "degraded") : health.isError ? "down" : "loading";
  const apiLabel = {
    ok: "API ok",
    degraded: "API degraded",
    down: "API down",
    loading: "API…",
  }[apiState];
  const lag = health.data?.indexer.lagBlocks;

  return (
    <div className="border-b border-warn/25 bg-warn/[0.07] text-[0.72rem]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 sm:px-6">
        <div className="flex items-center gap-2 font-medium text-warn">
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M10 3 3 16h14L10 3zM10 8v4M10 14.2v.1" strokeLinecap="round" />
          </svg>
          Local demo · mock markets · no real funds
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-2">
          {block.data ? (
            <>
              <span>
                Block <span className="font-medium text-ink">#{fmtInt(Number(block.data.number))}</span>
              </span>
              <span title="The demo warps chain time; every date on this dashboard is chain time (UTC).">
                Chain time <span className="font-medium text-ink">{fmtDateTime(Number(block.data.timestamp))}</span>
              </span>
            </>
          ) : block.isError ? (
            <span className="text-crit" title={RPC_URL}>
              RPC unreachable ({RPC_URL})
            </span>
          ) : (
            <span className="text-muted">Connecting to chain…</span>
          )}
          <span className="inline-flex items-center gap-1.5" title={lag !== null && lag !== undefined ? `Indexer lag: ${lag} blocks` : undefined}>
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                apiState === "ok" && "bg-good",
                apiState === "degraded" && "bg-warn",
                apiState === "down" && "bg-crit",
                apiState === "loading" && "bg-muted",
              )}
              aria-hidden
            />
            {apiLabel}
            {apiState === "ok" && lag !== null && lag !== undefined && lag > 2 && <span className="text-warn"> · indexer {lag} blocks behind</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
