import { defineConfig } from "@playwright/test";

/**
 * Browser tests for the depositor flow. They drive the real UI against a *running* local stack
 * (Anvil :8555 + API :4010 + dashboard :3010, i.e. `make chain && make api && make web`) and send real
 * transactions through wagmi to Anvil's unlocked dev accounts - mock assets only, no real funds.
 *
 * Chrome is used through the `chrome` channel, so no Playwright browser download is needed.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false, // one wallet, one chain: the flow is ordered
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.FRONTEND_URL ?? "http://localhost:3010",
    channel: "chrome",
    headless: true,
    actionTimeout: 20_000,
    trace: "retain-on-failure",
  },
});
