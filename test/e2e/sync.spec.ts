import { itemAt, required } from "../../src/importer/at";
import { expect, test } from "./fixtures";
import { wf } from "./wealthfolio";

test("connect, create accounts, push, and push only what is new", async ({ addon, plaid }) => {
  await addon.firstPush();
  expect((await wf.accounts()).map((a) => a.name)).toEqual(expect.arrayContaining([expect.stringContaining("Everyday Checking")]));
  const first = await wf.activities();
  const comments = first.map((a) => a.comment ?? "");
  for (const id of ["tx_pay", "tx_coffee", "tx_grocery", "inv_buy", "inv_div", "opening:acc_brk:VTI"]) {
    expect(comments.some((c) => c.includes(`plaid:${id}`)), id).toBe(true);
  }

  plaid.transactions.push({ ...itemAt(plaid.transactions, 1), transaction_id: "tx_lunch", name: "Lunch", merchant_name: "Lunch", amount: 15 });
  await addon.dryRun();
  await addon.frame.getByRole("button", { name: "Pull fresh from Plaid" }).click();
  await expect(addon.frame.getByText("1 new", { exact: true })).toBeVisible({ timeout: 60_000 });
  await addon.push();
  const second = await wf.activities();
  expect(second.length).toBe(first.length + 1);
  expect(second.some((a) => (a.comment ?? "").includes("plaid:tx_lunch"))).toBe(true);
});

test("shares contributed to a plan arrive marked external", async ({ addon, plaid }) => {
  plaid.investments.push({ ...itemAt(plaid.investments, 0), investment_transaction_id: "inv_plan", subtype: "contribution",
    amount: 100, quantity: 1, price: 100, name: "Plan Contribution" });
  await addon.firstPush();
  const rows = await wf.activities();
  const external = (id: string) => required(rows.find((a) => (a.comment ?? "").includes(`plaid:${id}`)), id).metadata?.flow;
  expect([external("inv_plan"), external("inv_buy")]).toEqual([{ is_external: true }, undefined]);
});
