import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RawState } from "../src/chain/reader";

/** Real protocol state captured from Anvil after a 90-day replay (src/tools/captureFixture.ts). */
export function loadRawState(): RawState {
  const raw = readFileSync(resolve(import.meta.dirname, "fixtures/raw-state.json"), "utf8");
  return JSON.parse(raw, (_, v) => (v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v)) as RawState;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}
