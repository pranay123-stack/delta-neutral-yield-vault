import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ANVIL_ACCOUNTS, type Deployment } from "@dnv/shared";
import { z } from "zod";

/**
 * Runtime configuration from the environment. Defaults target the local Docker/Anvil demo; every
 * private key default is one of Anvil's *published* dev keys, which only ever control mock tokens on
 * a local chain.
 */
const Env = z.object({
  RPC_URL: z.string().default("http://127.0.0.1:8555"),
  CHAIN_ID: z.coerce.number().default(31337),
  DATABASE_URL: z.string().default("postgres://dnv:dnv@127.0.0.1:5476/dnv"),
  DEPLOYMENT_FILE: z.string().optional(),
  API_PORT: z.coerce.number().default(4010),
  API_HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("*"),
  KEEPER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  KEEPER_INTERVAL_MS: z.coerce.number().default(15_000),
  INDEXER_INTERVAL_MS: z.coerce.number().default(5_000),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().default(15_000),
  KEEPER_PRIVATE_KEY: z.string().default(ANVIL_ACCOUNTS[1].key),
  SIMULATOR_PRIVATE_KEY: z.string().default(ANVIL_ACCOUNTS[0].key),
  GUARDIAN_PRIVATE_KEY: z.string().default(ANVIL_ACCOUNTS[2].key),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env> & { deployment: Deployment; deploymentFile: string };

export function loadDeployment(file: string): Deployment {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return { ...(raw as unknown as Deployment), chainId: Number(raw.chainId), startBlock: Number(raw.startBlock) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  const deploymentFile =
    parsed.DEPLOYMENT_FILE ?? resolve(import.meta.dirname, "../../deployments", `${parsed.CHAIN_ID}.json`);
  return { ...parsed, deploymentFile, deployment: loadDeployment(deploymentFile) };
}
