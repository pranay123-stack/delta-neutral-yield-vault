/** Dev tool: capture the live RawState into test/fixtures/raw-state.json (bigints tagged) for offline tests. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createChain } from "../chain/clients";
import { readRawState } from "../chain/reader";
import { loadConfig } from "../config";

const s = await readRawState(createChain(loadConfig()));
const out = resolve(import.meta.dirname, "../../test/fixtures/raw-state.json");
writeFileSync(out, JSON.stringify(s, (_, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v), 2));
console.log(`captured block ${s.blockNumber} -> ${out}`);
