// The addon must start with Wealthfolio, not on the first visit: the daily sync timer lives in it.
import { BASE } from "./wealthfolio";
import { expect, test } from "./fixtures";

test("boots at startup and adds its sidebar item", async ({ page, plaid }) => {
  void plaid;
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(`${BASE}/dashboard`);
  await expect.poll(() => logs.find((l) => l.includes("Eager-loaded"))).toContain("Eager-loaded 1 out of 1 pinned addons");
  await page.getByRole("link", { name: "Plaid Importer" }).click();
  await expect(page).toHaveURL(/\/addons\/plaid-importer/);
});

test("checks the Plaid keys", async ({ addon }) => {
  await addon.open();
  await addon.saveKeys();
});
