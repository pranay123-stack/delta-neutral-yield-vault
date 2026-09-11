/** Public runtime configuration. NEXT_PUBLIC_* values are inlined at build time. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4010").replace(/\/+$/, "");
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8555";
export const CHAIN_ID = 31337;

/** Polling cadences (ms). Live endpoints every ~5s, history every 30s. */
export const POLL_LIVE = 5_000;
export const POLL_SLOW = 30_000;
