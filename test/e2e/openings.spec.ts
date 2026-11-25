import { itemAt, required } from "../../src/importer/at";
import { type Addon, expect, test } from "./fixtures";
import type { FakePlaid } from "./fake-plaid";
import { wf } from "./wealthfolio";

const TRADES = "/investments/transactions/get";

async function pushBuyOf(shares: number, { addon, plaid }: { addon: Addon; plaid: FakePlaid }) {
  Object.assign(itemAt(plaid.investments, 0), { quantity: shares, amount: shares * 100 });
  await addon.dryRun();
  await pullFresh({ addon, plaid });
  await addon.push();
}

async function pullFresh({ addon, plaid }: { addon: Addon; plaid: FakePlaid }) {
  const pulls = () => plaid.calls.filter((c) => c === TRADES).length;
  const before = pulls();
  await addon.frame.getByRole("button", { name: "Pull fresh from Plaid" }).click();
  await expect.poll(pulls).toBeGreaterThan(before);
  await expect(addon.frame.getByText("Push would make:")).toBeVisible({ timeout: 60_000 });
}

async function openings() {
  const rows = await wf.activities();
  const find = (id: string) => rows.find((a) => (a.comment ?? "").includes(`plaid:opening:acc_brk:${id}`));
  const shares = find("VTI");
  return { shares: shares ? Number(shares.quantity) : null, cash: Number(required(find("cash"), "cash opening").amount),
    flagged: find("cash")?.isUserModified };
}

test("openings follow a pushed trade each time it changes", async ({ addon, plaid }) => {
  itemAt(plaid.investments, 0).date = itemAt(plaid.investments, 1).date;
  await addon.firstPush();
  expect(await openings()).toEqual({ shares: 2, cash: 1167.5, flagged: false });

  await pushBuyOf(11, { addon, plaid });
  expect(await openings()).toEqual({ shares: 1, cash: 1267.5, flagged: true });

  await pushBuyOf(11.5, { addon, plaid });
  expect(await openings()).toEqual({ shares: 0.5, cash: 1317.5, flagged: true });

  await pushBuyOf(12, { addon, plaid });
  expect(await openings()).toEqual({ shares: null, cash: 1367.5, flagged: true });

  await pushBuyOf(10, { addon, plaid });
  expect(await openings()).toEqual({ shares: 2, cash: 1167.5, flagged: true });
});

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function addTrust(plaid: FakePlaid) {
  const trust = { security_id: "sec_trust", iso_currency_code: "USD" };
  plaid.securities.push({ ...trust, ticker_symbol: null, name: "Index Trust", type: "mutual fund" });
  plaid.holdings.push({ ...trust, account_id: "acc_brk", quantity: 20, institution_price: 100, institution_value: 2000 });
  plaid.investments.push({ ...trust, investment_transaction_id: "inv_trust", account_id: "acc_brk", type: "buy", subtype: "buy",
    amount: 1000, quantity: 10, price: 100, fees: 0, date: itemAt(plaid.investments, 0).date, name: "BUY TRUST" });
}

async function follow(addon: Addon, action: "Review" | "Change", close: string) {
  await addon.frame.getByRole("row", { name: /Index Trust/ }).getByRole("button", { name: action }).click();
  await addon.frame.getByRole("button", { name: "Follow ticker", exact: true }).click();
  await addon.frame.getByLabel("Ticker to follow").fill("VOO");
  await addon.frame.getByLabel("Date").fill(yesterday);
  await addon.frame.getByLabel("This fund's price").fill("100");
  await addon.frame.getByLabel("Close (optional)").fill(close);
  await addon.frame.getByRole("button", { name: "Get ratio" }).click();
  await addon.frame.getByRole("button", { name: "Save", exact: true }).click();
  await addon.frame.getByRole("button", { name: "Update preview" }).click();
}

async function trustRows() {
  const rows = await wf.activities();
  const find = (id: string) => required(rows.find((a) => (a.comment ?? "").includes(`plaid:${id}`)), id);
  const opening = find("opening:acc_brk:VOO");
  return { buy: Number(find("inv_trust").quantity), opening: Number(opening.quantity), price: Number(opening.unitPrice) };
}

test("a new ratio rescales a pushed trade that Plaid no longer sends", async ({ addon, plaid }) => {
  addTrust(plaid);
  await addon.open();
  await addon.saveKeys();
  await addon.connect();
  await addon.createAccounts();
  await addon.dryRun();
  await follow(addon, "Review", "500");
  await addon.push();
  const first = await trustRows();
  expect([first.buy, first.opening]).toEqual([2, 2]);

  plaid.investments.pop();
  for (const [close, units] of [["400", 2.5], ["500", 2]] as const) {
    await addon.dryRun();
    await follow(addon, "Change", close);
    await expect(addon.frame.getByText("Push would make:")).toBeVisible({ timeout: 60_000 });
    await pullFresh({ addon, plaid });
    await addon.push();
    expect(await trustRows()).toEqual({ buy: units, opening: units, price: first.price });
  }
});
