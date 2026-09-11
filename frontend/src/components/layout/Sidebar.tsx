"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "@/components/ui/Card";

import { NAV } from "./nav";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="Delta-Neutral Vault - overview">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-accent-soft text-accent-strong" aria-hidden>
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3 13c2.5 0 3.5-6 7-6s4.5 6 7 6" />
          <path d="M3 10h14" strokeOpacity="0.5" />
        </svg>
      </span>
      <span className={cx("leading-tight", compact && "hidden sm:block")}>
        <span className="block text-[0.8125rem] font-semibold text-ink">Delta-Neutral Vault</span>
        <span className="block text-[0.68rem] text-muted">dnUSDC · basis carry</span>
      </span>
    </Link>
  );
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="space-y-0.5">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.8125rem] font-medium transition-colors",
              active ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-panel-2 hover:text-ink",
            )}
          >
            <span className={active ? "text-accent-strong" : "text-muted"}>{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-4 lg:flex">
      <div className="px-1.5 pb-5">
        <Brand />
      </div>
      <SidebarNav />
      <div className="mt-auto px-1.5 pt-4 text-[0.68rem] leading-relaxed text-muted">
        ERC-4626 vault · USDC reserve + WETH lending long + perp short. Local Anvil only.
      </div>
    </aside>
  );
}
