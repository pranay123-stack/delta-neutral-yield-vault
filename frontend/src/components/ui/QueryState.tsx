"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { cx } from "./Card";

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cx("skeleton", className)} style={style} aria-hidden />;
}

export function SkeletonRows({ rows = 4, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="space-y-2.5" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} style={{ height, width: `${92 - ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin text-accent", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const unreachable = error instanceof ApiError && error.unreachable;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className={cx("rounded-md border border-crit/35 bg-crit/5 text-xs", compact ? "px-3 py-2" : "px-4 py-3")} role="alert">
      <div className="font-semibold text-crit">{unreachable ? "Backend API is down" : "Failed to load"}</div>
      <div className="mt-0.5 line-clamp-3 break-words text-ink-2" title={message}>
        {message}
      </div>
      {unreachable && !compact && (
        <div className="mt-1 text-muted">
          Start it with <code className="font-mono text-ink-2">pnpm --filter @dnv/backend start</code>. This panel retries automatically.
        </div>
      )}
      {onRetry && (
        <button type="button" className="btn btn-ghost mt-2 px-2 py-1 text-xs" onClick={onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-line-strong px-4 py-6 text-center text-xs text-muted">{children}</div>;
}

interface QueryProps<T> {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  /** Return true when the payload has nothing to show. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
}

/**
 * Loading / error / empty handling for one panel. Keeps showing the last good data if a background
 * refetch fails (with a small stale marker) instead of blanking the panel.
 */
export function Query<T>({ query, children, skeleton, isEmpty, empty }: QueryProps<T>) {
  if (query.data === undefined) {
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (isEmpty?.(query.data)) return <EmptyState>{empty ?? "Nothing to show yet."}</EmptyState>;
  return (
    <>
      {query.isError && (
        <div className="mb-2 text-[0.7rem] text-warn" role="status">
          Showing last good data - refresh failed: {query.error instanceof Error ? query.error.message : "unknown error"}
        </div>
      )}
      {children(query.data)}
    </>
  );
}
