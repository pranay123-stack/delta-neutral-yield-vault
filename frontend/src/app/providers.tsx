"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useConfig, useConnect } from "wagmi";
import { WagmiProvider } from "wagmi";

import { rememberConnector, rememberedConnector, wagmiConfig } from "@/lib/wagmi";

/**
 * Mock connectors keep no session across reloads, so re-connect the last demo wallet ourselves -
 * but only after wagmi's own reconnect pass has settled (it would otherwise reset the state).
 */
function DemoWalletRestore() {
  const config = useConfig();
  const connect = useConnect();
  const { mutate } = connect;

  useEffect(() => {
    const id = rememberedConnector();
    if (!id?.startsWith("demo-")) return;
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      const { status } = config.state;
      if (status === "connected") return;
      if ((status === "connecting" || status === "reconnecting") && tries++ < 10) {
        timer = window.setTimeout(attempt, 300);
        return;
      }
      const connector = config.connectors.find((c) => c.id === id);
      if (!connector) {
        rememberConnector(null);
        return;
      }
      mutate({ connector });
    };
    timer = window.setTimeout(attempt, 400);
    return () => window.clearTimeout(timer);
  }, [config, mutate]);

  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2_000 },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DemoWalletRestore />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
