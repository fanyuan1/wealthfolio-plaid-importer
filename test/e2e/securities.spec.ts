// Securities review: Plaid's currency cash is automatic; a cash-like fund still needs the user (D27).
import { expect, test } from "./fixtures";
import { wf } from "./wealthfolio";

test("currency cash is automatic, a money market fund needs review", async ({ addon, plaid }) => {
  plaid.securities.push({ security_id: "sec_spaxx", ticker_symbol: "SPAXX", name: "Fidelity Government Money Market", type: "mutual fund",
    is_cash_equivalent: true, close_price: 1, iso_currency_code: "USD" });
  plaid.holdings.push({ account_id: "acc_brk", security_id: "sec_spaxx", quantity: 300, institution_price: 1, institution_value: 300, iso_currency_code: "USD" });
  await addon.open();
  await addon.saveKeys();
  await addon.connect();
  await addon.createAccounts();
  await addon.dryRun();

  const needs = addon.frame.getByRole("row", { name: /Needs attention/ });
  await expect(needs).toHaveText(/\(1\)/);
  await expect(addon.frame.getByRole("row", { name: /U S Dollar/ })).toContainText("Automatic");
  await expect(addon.frame.getByRole("button", { name: "Push to Wealthfolio" })).toBeDisabled();

  await addon.review("Fidelity Government Money Market", "Cash");
  await addon.push();
  expect((await wf.activities()).some((a) => (a.comment ?? "").includes("plaid:inv_buy"))).toBe(true);
});
