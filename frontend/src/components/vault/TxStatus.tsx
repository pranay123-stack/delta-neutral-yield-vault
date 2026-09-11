"use client";

import { Spinner } from "@/components/ui/QueryState";
import { cx } from "@/components/ui/Card";
import { shortHex } from "@/lib/format";
import type { TxState, TxStepStatus } from "@/lib/tx";

const STATUS_TEXT: Record<TxStepStatus, string> = {
  queued: "queued",
  signing: "simulating & submitting…",
  confirming: "waiting for receipt…",
  done: "confirmed",
  error: "failed",
};

function StepIcon({ status }: { status: TxStepStatus }) {
  if (status === "signing" || status === "confirming") return <Spinner />;
  if (status === "done")
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 text-good" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "error")
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 text-crit" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
      </svg>
    );
  return <span className="block h-3 w-3 rounded-full border border-line-strong" aria-hidden />;
}

/** Live status of the current transaction sequence (approve -> deposit etc.). */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  if (!state.action) return null;
  const done = !state.running && !state.error;
  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        state.error ? "border-crit/40 bg-crit/5" : done ? "border-good/35 bg-good/5" : "border-accent/35 bg-accent-soft",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[0.8125rem] font-semibold text-ink">
          {state.action}
          <span className="ml-2 text-xs font-normal text-ink-2">{state.running ? "in progress" : state.error ? "failed" : "complete"}</span>
        </div>
        {!state.running && (
          <button type="button" className="text-xs text-muted hover:text-ink" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      <ol className="mt-2 space-y-1.5">
        {state.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2.5 text-xs">
            <span className="grid w-4 place-items-center">
              <StepIcon status={s.status} />
            </span>
            <span className="text-ink">{s.label}</span>
            <span className="text-muted">{STATUS_TEXT[s.status]}</span>
            {s.hash && (
              <span className="ml-auto font-mono text-[0.68rem] text-ink-2" title={s.hash}>
                {shortHex(s.hash)}
                {s.blockNumber !== undefined && ` · block ${s.blockNumber.toString()}`}
              </span>
            )}
          </li>
        ))}
      </ol>
      {state.error && <p className="mt-2 break-words rounded-md bg-bg/60 px-2.5 py-2 font-mono text-[0.72rem] leading-relaxed text-crit">{state.error}</p>}
      {done && <p className="mt-2 text-[0.7rem] text-ink-2">Balances, previews and API panels refetched. The indexer picks up new events within a few seconds.</p>}
    </div>
  );
}
