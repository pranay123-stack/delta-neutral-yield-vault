"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

import { RiskBadge } from "@/components/ui/Badge";
import { fmtUsd } from "@/lib/format";
import { useMetrics } from "@/lib/queries";

import { DemoBanner } from "./DemoBanner";
import { Brand, Sidebar, SidebarNav } from "./Sidebar";
import { WalletMenu } from "./WalletMenu";

function Topbar({ onMenu }: { onMenu: () => void }) {
  const metrics = useMetrics();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <button type="button" className="btn btn-ghost px-2 lg:hidden" onClick={onMenu} aria-label="Open navigation">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <div className="lg:hidden">
          <Brand compact />
        </div>
        <div className="hidden min-w-0 items-center gap-4 text-xs text-ink-2 md:flex">
          {metrics.data && (
            <>
              <span>
                TVL <span className="font-semibold text-ink">{fmtUsd(metrics.data.tvlUsd, { digits: 0 })}</span>
              </span>
              <span>
                Share price <span className="font-semibold text-ink">{metrics.data.sharePrice.toFixed(6)}</span>
              </span>
              <span>
                ETH <span className="font-semibold text-ink">{fmtUsd(metrics.data.ethPrice)}</span>
              </span>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {metrics.data && <RiskBadge state={metrics.data.riskState} />}
          <WalletMenu />
        </div>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      <DemoBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button type="button" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-label="Close navigation" />
            <div className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col border-r border-line bg-panel px-3 py-4">
              <div className="px-1.5 pb-5">
                <Brand />
              </div>
              <SidebarNav onNavigate={() => setOpen(false)} />
            </div>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setOpen(true)} />
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-12 pt-5 sm:px-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
