import { itemAt } from "../../src/importer/at";
import { expect, routePlaid, test } from "./fixtures";
import { BASE, wf } from "./wealthfolio";

test("runs once after its time, in one of two tabs, with the addon page never opened", async ({ addon, plaid, browser }) => {
  await addon.firstPush();
  await addon.step("Daily sync");
  await addon.frame.getByRole("switch").click();
  await addon.frame.locator("#daily-time").fill("00:00");
  await addon.page.close();
  const pulls = () => plaid.calls.filter((c) => c === "/investments/transactions/get").length;
  const before = pulls();

  plaid.transactions.push({ ...itemAt(plaid.transactions, 1), transaction_id: "tx_daily", name: "Bakery", merchant_name: "Bakery", amount: 9 });
  const tabs = await Promise.all([0, 1].map(async () => {
    const page = await browser.newPage();
    await routePlaid(page, plaid);
    await page.clock.install();
    await page.goto(`${BASE}/dashboard`);
    await expect(page.getByRole("link", { name: "Plaid Importer" })).toBeVisible();
    return page;
  }));
  await Promise.all(tabs.map((p) => p.clock.fastForward("01:05")));
  await expect.poll(async () => (await wf.activities()).filter((a) => (a.comment ?? "").includes("plaid:tx_daily")).length,
    { timeout: 60_000 }).toBe(1);
  await itemAt(tabs, 0).waitForTimeout(5000);
  expect((await wf.activities()).filter((a) => (a.comment ?? "").includes("plaid:tx_daily")).length).toBe(1);
  expect(pulls() - before).toBe(1);
  for (const p of tabs) expect(p.url()).not.toContain("/addons/");
});
