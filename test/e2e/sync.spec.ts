// The flow a user goes through, against a real Wealthfolio: keys, connect, accounts, dry run, push.
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

  // A new card purchase: the next sync pushes it alone.
  plaid.transactions.push({ ...plaid.transactions[1], transaction_id: "tx_lunch", name: "Lunch", merchant_name: "Lunch", amount: 15 });
  await addon.dryRun();
  await addon.frame.getByRole("button", { name: "Pull fresh from Plaid" }).click(); // a dry run reuses a pull for 15 minutes
  await expect(addon.frame.getByText("1 new", { exact: true })).toBeVisible({ timeout: 60_000 });
  await addon.push();
  const second = await wf.activities();
  expect(second.length).toBe(first.length + 1);
  expect(second.some((a) => (a.comment ?? "").includes("plaid:tx_lunch"))).toBe(true);
});
