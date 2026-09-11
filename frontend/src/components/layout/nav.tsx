import type { ReactNode } from "react";

const icon = (d: string): ReactNode => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: icon("M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9") },
  { href: "/vault", label: "Vault", icon: icon("M3 6h14v10H3zM3 9h14M13 12.5h2") },
  { href: "/strategy", label: "Strategy", icon: icon("M4 16V9M8 16V5M12 16v-5M16 16V7") },
  { href: "/positions", label: "Positions", icon: icon("M10 3v14M3 10h14M5.5 5.5l9 9M14.5 5.5l-9 9") },
  { href: "/risk", label: "Risk", icon: icon("M10 3 3 16h14L10 3zM10 8v4M10 14.2v.1") },
  { href: "/performance", label: "Performance", icon: icon("M3 15l4-5 3 3 7-8M13 5h4v4") },
  { href: "/pnl", label: "PnL", icon: icon("M4 4v12h12M7 12V9M10 12V6M13 12v-2") },
  { href: "/rebalancing", label: "Rebalancing", icon: icon("M4 7h10l-3-3M16 13H6l3 3") },
  { href: "/simulation", label: "Simulation", icon: icon("M7 3h6M8 3v5l-4 8h12l-4-8V3M6.5 12h7") },
  { href: "/transactions", label: "Transactions", icon: icon("M4 5h12M4 10h12M4 15h8") },
];
