// The daily sync runs from the timer the addon starts with Wealthfolio, without the addon page ever being opened,
// and in one tab only when several are open (the switch and the lock live on the server).
import { expect, routePlaid, test } from "./fixtures";
import { BASE, wf } from "./wealthfolio";

test("runs once after its time, in one of two tabs, with the addon page never opened", async ({ addon, plaid, browser }) => {
  await addon.firstPush();
  await addon.step("Daily sync");
  await addon.frame.getByRole("switch").click();
  await addon.frame.locator("#daily-time").fill("00:00"); // due at once
  await addon.page.close();
  // A run's pull is the only caller of investment transactions (the category fill-in after a push pulls bank rows only).
  const pulls = () => plaid.calls.filter((c) => c === "/investments/transactions/get").length;
  const before = pulls();

  // Two new Wealthfolio tabs, as after a restart: the addon page is not opened.
  plaid.transactions.push({ ...plaid.transactions[1], transaction_id: "tx_daily", name: "Bakery", merchant_name: "Bakery", amount: 9 });
  const tabs = await Promise.all([0, 1].map(async () => {
    const page = await browser.newPage();
    await routePlaid(page, plaid);
    await page.clock.install();
    await page.goto(`${BASE}/dashboard`);
    await expect(page.getByRole("link", { name: "Plaid Importer" })).toBeVisible();
    return page;
  }));
  await Promise.all(tabs.map((p) => p.clock.fastForward("01:05"))); // the first tick waits a minute for Wealthfolio to start
  await expect.poll(async () => (await wf.activities()).filter((a) => (a.comment ?? "").includes("plaid:tx_daily")).length,
    { timeout: 60_000 }).toBe(1);
  await tabs[0].waitForTimeout(5000); // a second run would land by now
  expect((await wf.activities()).filter((a) => (a.comment ?? "").includes("plaid:tx_daily")).length).toBe(1);
  expect(pulls() - before).toBe(1); // one tab pulled; the other saw the lock
  for (const p of tabs) expect(p.url()).not.toContain("/addons/");
});
