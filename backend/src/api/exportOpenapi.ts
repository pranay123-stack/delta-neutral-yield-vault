/** Writes docs/openapi.json from the route schemas (no chain or DB needed: routes are only registered). */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildServer } from "./server";
import type { ApiService } from "./service";

const app = await buildServer({} as ApiService);
await app.ready();
const out = resolve(import.meta.dirname, "../../../docs/openapi.json");
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(app.swagger().paths ?? {}).length} paths)`);
await app.close();
