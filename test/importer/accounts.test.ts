// Account names and settings.
import { expect, test } from "vitest";
import { accountName, MAX_LEN } from "../../src/importer";

test("short names and limit", () => {
  expect(accountName("AB", "Charles Schwab", "Brokerage", "1234")).toBe("AB · Schwab Brokerage ••1234");
  const long = accountName("AB", "Bank of America", "Plaid Gold Standard 0% Interest Checking Account Plus", "0000");
  expect(long.length <= MAX_LEN && long.endsWith("… ••0000") && long.startsWith("AB · BoA Gold Standard")).toBe(true);
});

test("unique within limit", () => {
  expect(accountName("CD", "Vanguard", "Roth IRA", "9", new Set(["CD · Vanguard Roth IRA ••9"]))).toBe("CD · Vanguard Roth IRA ••9 (2)");
  const n = accountName("AB", "Chase", "x".repeat(80), "1", new Set([accountName("AB", "Chase", "x".repeat(80), "1")]));
  expect(n.length <= MAX_LEN && n.endsWith("(2)")).toBe(true);
});

test("unknown institution keeps plaid name", () => {
  expect(accountName("CD", "Second Wombat Bank", "Plaid Checking", null)).toBe("CD · Second Wombat Bank Checking");
});

test("long institution trimmed before account name", () => {
  const n = accountName("AB", "Greater Northwestern Community Federal Credit Union", "Savings", "4321");
  expect(n.length <= MAX_LEN && n.endsWith(" Savings ••4321") && n.includes("…")).toBe(true);
});

test("abbreviation prefix match and plaid word removed", () => {
  expect(accountName("AB", "Charles Schwab - Retirement Plan Center", "401k", "7")).toBe("AB · Schwab 401k ••7");
  expect(accountName("AB", "First Platypus Bank", "Plaid Home Equity Line of Credit", "9004")).toBe("AB · Platypus Home Equity Line of Credit ••9004");
  expect(accountName("AB", "Chase", "Plaid", null)).toBe("AB · Chase Account");
});

test("crypto symbols", async () => {
  const { cryptoSymbol } = await import("../../src/importer/securities");
  expect([cryptoSymbol("BTC"), cryptoSymbol("CUR:eth", "EUR"), cryptoSymbol("SOL-USD")]).toEqual(["BTC-USD", "ETH-EUR", "SOL-USD"]);
});

test("joint accounts from owners or name", async () => {
  const { discoverAccounts, jointOwners } = await import("../../src/importer");
  const cfg: Record<string, any> = {};
  const accts = [{ account_id: "a", name: "Joint Checking", type: "depository", subtype: "checking" },
    { account_id: "b", name: "Savings", type: "depository", subtype: "savings" }];
  discoverAccounts(cfg, "i", { owner: "AB", institution_name: "Chase" }, accts, new Set(), jointOwners({ accounts: [{ account_id: "b", owners: [{}, {}] }] }));
  expect([cfg.a.joint, cfg.b.joint]).toEqual([true, true]);
});

test("crypto filed as cash still maps to a crypto pair", async () => {
  const { resolve } = await import("../../src/importer/securities");
  for (const [ticker, type, cashEq] of [["CUR:BTC", "cash", true], ["DOGE", "other", true], ["ETH", "cryptocurrency", false], ["SOL", "cash", true]] as const) {
    const r = resolve({ security_id: "s", ticker_symbol: ticker, type, is_cash_equivalent: cashEq }, {});
    expect([r.kind, r.instrumentType, r.symbol]).toEqual(["security", "CRYPTO", `${ticker.replace("CUR:", "")}-USD`]);
  }
  expect(resolve({ security_id: "u", ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true }, {}).kind).toBe("cash");
});

test("joint by shared mask under two owners", async () => {
  const { jointByMask } = await import("../../src/importer");
  const c = (owner: string, mask: string) => ({ owner, institution_id: "m", mask, plaid_subtype: "cash management", item_id: "i", kind: "investment" });
  expect([...jointByMask({ a: c("JF", "6F76"), b: c("WY", "6F76"), c: c("JF", "1111") })].sort()).toEqual(["a", "b"]);
});

test("suggestMatch picks the closest name or a shared mask", async () => {
  const { suggestMatch } = await import("../../src/importer");
  const c = [{ id: "a", name: "Vanguard Roth IRA" }, { id: "b", name: "Chase Checking", accountNumber: "9912" }];
  expect(suggestMatch("AB · Vanguard Roth IRA ••9", "9", c)).toBe("a");
  expect(suggestMatch("AB · Chase Account ••9912", "9912", c)).toBe("b");
  expect(suggestMatch("AB · Fidelity 529", "1", c)).toBeNull();
});

test("Closes.nearest takes the closest day, before or after", async () => {
  const { Closes } = await import("../../src/importer");
  const c = new Closes({ VOO: { "2026-01-02": "500", "2026-01-20": "510" } }, async () => ({}), "2026-02-01");
  expect(c.nearest("VOO", "2026-01-05")?.day).toBe("2026-01-02");
  expect(c.nearest("VOO", "2026-01-18")?.day).toBe("2026-01-20");
  expect(c.nearest("XYZ", "2026-01-18")).toBeNull();
});
