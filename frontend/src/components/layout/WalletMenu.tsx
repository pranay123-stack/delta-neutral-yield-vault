"use client";

import { useEffect, useRef, useState } from "react";
import { type Connector, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { cx } from "@/components/ui/Card";
import { accountLabel, DEMO_WALLETS, demoConnectorId } from "@/lib/demo";
import { CHAIN_ID } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { shortHex } from "@/lib/format";
import { rememberConnector } from "@/lib/wagmi";

function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
}

/** Connection logic shared by the topbar menu and the /vault page panel. */
export function useWalletActions() {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const [error, setError] = useState<string | null>(null);

  const injectedConnector = connectors.find((c) => c.type === "injected");
  const demoConnectors = DEMO_WALLETS.map((w) => ({ wallet: w, connector: connectors.find((c) => c.id === demoConnectorId(w.key)) }));

  async function connectWith(connector: Connector | undefined) {
    if (!connector) return;
    setError(null);
    try {
      if (connection.isConnected) {
        if (connection.connector?.uid === connector.uid) return;
        await disconnect.mutateAsync({ connector: connection.connector });
      }
      await connect.mutateAsync({ connector, chainId: CHAIN_ID });
      rememberConnector(connector.id);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function disconnectAll() {
    setError(null);
    rememberConnector(null);
    try {
      await disconnect.mutateAsync({});
    } catch (err) {
      setError(describeError(err));
    }
  }

  return {
    connection,
    injectedConnector,
    demoConnectors,
    connectWith,
    disconnectAll,
    pending: connect.isPending || disconnect.isPending,
    error,
  };
}

export function WalletOptions({ onDone }: { onDone?: () => void }) {
  const { connection, injectedConnector, demoConnectors, connectWith, pending, error } = useWalletActions();
  const [hasInjected, setHasInjected] = useState(false);
  useEffect(() => setHasInjected(hasInjectedProvider()), []);

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-muted">Demo wallet · zero setup</div>
        <div className="grid grid-cols-3 gap-1.5">
          {demoConnectors.map(({ wallet, connector }) => {
            const active = connection.isConnected && connection.connector?.id === connector?.id;
            return (
              <button
                key={wallet.key}
                type="button"
                disabled={!connector || pending}
                onClick={async () => {
                  await connectWith(connector);
                  onDone?.();
                }}
                className={cx(
                  "rounded-md border px-2 py-2 text-left transition-colors",
                  active ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-panel-3",
                )}
              >
                <div className="text-[0.8125rem] font-medium text-ink">{wallet.label}</div>
                <div className="font-mono text-[0.65rem] text-muted">{shortHex(wallet.address, 5, 4)}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[0.68rem] leading-relaxed text-muted">Anvil's unlocked dev accounts: Anvil signs, no extension needed.</p>
      </div>
      <div>
        <div className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-muted">Browser wallet</div>
        <button
          type="button"
          className="btn btn-ghost w-full justify-between"
          disabled={!injectedConnector || !hasInjected || pending}
          onClick={async () => {
            await connectWith(injectedConnector);
            onDone?.();
          }}
        >
          <span>MetaMask / injected</span>
          <span className="text-[0.68rem] text-muted">{hasInjected ? "chain 31337" : "not detected"}</span>
        </button>
      </div>
      {error && <p className="break-words text-xs text-crit">{error}</p>}
    </div>
  );
}

export function WalletMenu() {
  const { connection, disconnectAll } = useWalletActions();
  const switchChain = useSwitchChain();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const wrongChain = connection.isConnected && connection.chainId !== CHAIN_ID;
  const label = accountLabel(connection.address);

  return (
    <div className="relative" ref={ref}>
      {connection.isConnected ? (
        <button type="button" className="btn btn-ghost max-w-[220px]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={cx("h-2 w-2 shrink-0 rounded-full", wrongChain ? "bg-warn" : "bg-good")} aria-hidden />
          {label && <span className="font-semibold">{label}</span>}
          <span className="truncate font-mono text-xs text-ink-2">{shortHex(connection.address, 6, 4)}</span>
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {connection.isConnecting || connection.isReconnecting ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-lg border border-line-strong bg-panel p-3 shadow-2xl">
          {connection.isConnected && (
            <div className="mb-3 space-y-2 border-b border-line pb-3">
              <div className="text-xs text-ink-2">
                Connected via <span className="text-ink">{connection.connector?.name ?? "wallet"}</span>
              </div>
              <div className="break-all font-mono text-xs text-ink">{connection.address}</div>
              {wrongChain && (
                <button type="button" className="btn btn-primary w-full" onClick={() => switchChain.mutate({ chainId: CHAIN_ID })}>
                  Switch to Anvil (31337)
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost w-full"
                onClick={async () => {
                  await disconnectAll();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </div>
          )}
          <WalletOptions onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
