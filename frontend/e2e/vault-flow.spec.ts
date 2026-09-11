import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The depositor's round trip through the real UI: connect -> faucet -> approve + deposit -> withdraw
 * -> rejected over-limit withdrawal -> unwind exit. Every step sends a real transaction to the local
 * Anvil (mock USDC, mock venues, unlocked dev accounts - no real funds). Read-only rendering is
 * covered by `scripts/check-frontend.sh`; this covers the write path, i.e. the wagmi wiring that a
 * typecheck and a production build cannot prove.
 *
 * One ordered test, because it is one session: the demo wallet, its balances and its position carry
 * from step to step. The market replay seeds all three demo users, so every assertion is made on the
 * *change* the step caused, and the exit only unwinds the shares this test minted - the local demo
 * state is left roughly as it was found.
 */

const WALLET = "Carol";
const FAUCET = 25_000;
const DEPOSIT = 10_000;
const WITHDRAW = 1_000;

/** Value cell of a `KV` row (a <dl> of label/value pairs) inside the wallet card. */
function walletValue(page: Page, label: string): Locator {
  return page.locator("dl > div", { has: page.getByText(label, { exact: true }) }).locator("dd");
}

/** Leading number of a formatted amount ("12,345.67 USDC" -> 12345.67). */
function amount(text: string | null): number {
  const m = (text ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : Number.NaN;
}

async function readAmount(page: Page, label: string): Promise<number> {
  return amount(await walletValue(page, label).textContent());
}

/**
 * A baseline reading, once the panel has stopped moving. After a receipt the UI invalidates every
 * query and then invalidates again 2.5s later (so the indexer can catch up), so a value read straight
 * after the previous step can still be the pre-transaction one - which would make the next assertion
 * compare against a stale number.
 */
async function readSettled(page: Page, label: string): Promise<number> {
  let previous = Number.NaN;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const current = await readAmount(page, label);
    if (current === previous && i >= 5) return current; // >= 3s of quiet: both refetches have landed
    previous = current;
  }
  return previous;
}

/** The transaction panel for `action`, once it has stopped running. */
function txPanel(page: Page, action: string | RegExp): Locator {
  return page.getByRole("status").filter({ hasText: action });
}

async function expectTxComplete(page: Page, action: string | RegExp) {
  const panel = txPanel(page, action);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("complete", { timeout: 90_000 });
  await panel.getByRole("button", { name: "Dismiss" }).click();
}

async function fill(page: Page, id: string, value: number | string) {
  const input = page.locator(`#${id}`);
  await input.fill(String(value));
  await expect(input).toHaveValue(String(value));
}

test("depositor round trip: faucet, deposit, withdraw, revert decoding, unwind exit", async ({ page }) => {
  const clientErrors: string[] = [];
  let sharesBefore = 0;
  page.on("pageerror", (err) => clientErrors.push(err.message));

  await page.goto("/vault");

  await test.step("connect the demo wallet", async () => {
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
    await page.getByRole("button", { name: WALLET }).first().click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    // vault + USDC addresses come from GET /vault, so a working panel also proves the API wiring
    await expect(walletValue(page, "USDC balance")).toBeVisible();
  });

  await test.step("mint mock USDC from the faucet", async () => {
    const before = await readSettled(page, "USDC balance");
    await fill(page, "faucet", FAUCET);
    await page.getByRole("button", { name: "Mint USDC" }).click();
    await expectTxComplete(page, "Faucet");
    await expect.poll(() => readAmount(page, "USDC balance")).toBeGreaterThan(before + FAUCET - 1);
  });

  await test.step("approve + deposit mints shares", async () => {
    sharesBefore = await readSettled(page, "Vault shares");
    const valueBefore = await readAmount(page, "Share value");
    await fill(page, "deposit", DEPOSIT);
    // an on-chain previewDeposit: proves reads used to build a write are wired to the right decimals
    await expect(page.getByText("You receive (previewDeposit)")).toBeVisible();
    await page.getByRole("button", { name: /Approve & deposit|^Deposit$/ }).click();
    await expectTxComplete(page, /Approve \+ deposit|^Deposit/);
    await expect.poll(() => readAmount(page, "Vault shares")).toBeGreaterThan(sharesBefore);
    const gained = (await readAmount(page, "Share value")) - valueBefore;
    expect(gained).toBeGreaterThan(DEPOSIT * 0.97); // entry cost + rounding only
    expect(gained).toBeLessThanOrEqual(DEPOSIT * 1.01);
  });

  await test.step("withdraw pays out from liquid assets", async () => {
    const before = await readSettled(page, "USDC balance");
    await page.getByRole("tab", { name: "Withdraw" }).click();
    await fill(page, "withdraw", WITHDRAW);
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await expectTxComplete(page, "Withdraw");
    await expect.poll(() => readAmount(page, "USDC balance")).toBeGreaterThan(before + WITHDRAW - 1);
  });

  await test.step("an over-limit withdrawal is refused with a decoded revert, before anything is sent", async () => {
    await fill(page, "withdraw", 1_000_000_000);
    await expect(page.getByText(/Exceeds the liquid max/)).toBeVisible();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    const panel = txPanel(page, "Withdraw");
    await expect(panel).toContainText("failed");
    await expect(panel).toContainText("ERC4626ExceededMaxWithdraw");
    await panel.getByRole("button", { name: "Dismiss" }).click();
  });

  await test.step("unwind exit returns the position this test opened", async () => {
    const minted = (await readSettled(page, "Vault shares")) - sharesBefore;
    expect(minted).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Unwind exit" }).click();
    await fill(page, "unwind", minted.toFixed(4));
    await fill(page, "slippage", 2);
    await page.getByRole("button", { name: "Redeem with unwind" }).click();
    await expectTxComplete(page, "Redeem with unwind");
    // back to the pre-test position (the exiting user pays their own unwind cost, so shares - not
    // assets - are what returns to where they started)
    await expect.poll(() => readAmount(page, "Vault shares")).toBeLessThan(sharesBefore + 1);
  });

  expect(clientErrors, "uncaught client errors").toEqual([]);
});
