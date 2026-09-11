import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/AppShell";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Delta-Neutral Vault", template: "%s · Delta-Neutral Vault" },
  description: "Analytics dashboard and depositor UI for a delta-neutral ERC-4626 yield vault running on local mock markets (no real funds).",
};

export const viewport: Viewport = {
  themeColor: "#0b0d11",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
