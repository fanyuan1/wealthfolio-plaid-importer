import { isRecord, itemAt, required } from "../../src/importer";
import type { Ledger } from "../../src/importer";

const ledgerRow = (state: Ledger, id: string) => required(state.get(id), id);
import { describe, expect, test } from "vitest";
import {
  Activity, D, type ImportRow, type ItemData, MemoryLedger, openingDay, plan, push, type PlaidHolding,
  type PlaidInvestmentTransaction, type PlaidSecurity, type PlaidTransaction,
  toImportRow, type Update, type Writer,
} from "../../src/importer";

const TODAY = "2026-11-05";
const ACCOUNTS = {
  brk: { item_id: "i_schwab", kind: "investment", name: "AB · Schwab", wealthfolio_account_id: "wf_brk" },
  chk: { item_id: "i_boa", kind: "cash", name: "AB · BoA Checking", wealthfolio_account_id: "wf_chk" },
  card: { item_id: "i_boa", kind: "credit", name: "AB · BoA Card", wealthfolio_account_id: "wf_card" },
  old: { item_id: "i_boa", kind: "cash", skip: true, name: "skipped" },
};
const SECS: Record<string, PlaidSecurity> = {
  s_vti: { security_id: "s_vti", ticker_symbol: "VTI", type: "etf" },
  s_cash: { security_id: "s_cash", ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true },
};

const invTx = (i: string, type: string, sub: string, amount: number, qty = 0, price = 0, sec: string | null = null, d = "2026-10-01", kw: Partial<PlaidInvestmentTransaction> = {}): PlaidInvestmentTransaction =>
  ({ investment_transaction_id: i, account_id: "brk", type, subtype: sub, amount, quantity: qty, price, security_id: sec,
    fees: null, date: d, name: sub, iso_currency_code: "USD", ...kw });

const bank = (i: string, acct: string, amount: number, primary = "", detailed = "", d = "2026-10-02"): PlaidTransaction =>
  ({ transaction_id: i, account_id: acct, amount, date: d, pending: false, name: i, merchant_name: null,
    iso_currency_code: "USD", personal_finance_category: { primary, detailed } });

function items(invTxns: PlaidInvestmentTransaction[], holdings: PlaidHolding[], added: PlaidTransaction[], modified: PlaidTransaction[] = [], removed: string[] = [], first = true,
  start = "2024-11-06", secs = SECS): ItemData[] {
  return [
    { itemId: "i_schwab", owner: "AB", institution: "Schwab", invStart: { brk: start },
      inv: { investment_transactions: invTxns, securities: secs, accounts: [] },
      holdings: { holdings, securities: Object.values(secs), accounts: [] } },
    { itemId: "i_boa", owner: "AB", institution: "BoA", invStart: {}, firstTxSync: first,
      tx: { added, modified, removed: removed.map((r) => ({ transaction_id: r })), next_cursor: "c1" },
      balances: first ? { chk: { current: 700 }, card: { current: 40 } } : {} },
  ];
}

class FakeWF implements Writer {
  n = 0; imported: ImportRow[] = []; updates: Update[] = []; links: [string, string][] = []; reruns = 0;
  cats: { activityId: string; taxonomyId: string; categoryId: string }[] = []; deleted: string[] = [];
  delete(ids: string[]) { this.deleted.push(...ids); return Promise.resolve(); }
  commitImport(rows: ImportRow[]) {
    const out = new Map<number, [string, string | null]>();
    for (const r of rows) {
      this.n += 1;
      this.imported.push(r);
      out.set(Number(r.lineNumber), ["imported", `wf${this.n}`]);
    }
    return Promise.resolve(out);
  }
  update(updates: Update[]) { this.updates.push(...updates); return Promise.resolve([{ errors: [] }]); }
  linkTransfers(pairs: [string, string][]) { this.links.push(...pairs); return Promise.resolve(); }
  categoryIds() { return Promise.resolve(new Map([["spending_categories|food", "cat_food"], ["spending_categories|shopping", "cat_shopping"]])); }
  setCategories(a: FakeWF["cats"]) { this.cats.push(...a); return Promise.resolve(); }
  rerunRules() { this.reruns += 1; return Promise.resolve(0); }
}

const run = (p: ReturnType<typeof plan>, wf: Writer, state: MemoryLedger) => push(p, wf, state, { accounts: ACCOUNTS, log: () => {} });

describe("sync", () => {
  test("full cycle", async () => {
    const state = new MemoryLedger();
    const wf = new FakeWF();
    const first = items(
      [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("t2", "cash", "deposit", -500, 0, 0, null, "2026-10-03"),
        invTx("t3", "buy", "buy", 50, 50, 1, "s_cash")],
      [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_price: 110, institution_value: 0 },
        { account_id: "brk", security_id: "s_cash", quantity: 300, institution_value: 300, institution_price: 1 }],
      [bank("b1", "chk", 500, "TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"),
        bank("b2", "card", 25, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), bank("b3", "old", 1)]);
    const p = plan(first, { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p.new.map((a) => [a.plaidId, a.activityType]).sort()).toEqual([["b1", "TRANSFER_OUT"], ["b2", "WITHDRAWAL"],
      ["opening:brk:VTI", "TRANSFER_IN"], ["opening:brk:cash", "TRANSFER_IN"], ["opening:card:cash", "TRANSFER_OUT"],
      ["opening:chk:cash", "TRANSFER_IN"], ["t1", "BUY"], ["t2", "TRANSFER_IN"]]);
    expect(p.pairs).toEqual([["b1", "t2"]]);
    expect(Object.fromEntries(p.categories)).toEqual({ b2: ["spending_categories", "food_coffee"] });
    expect(p.reviews).toEqual([]);
    const stats = await run(p, wf, state);
    expect([stats.imported, stats.linked, stats.categorized]).toEqual([8, 1, 1]);
    expect(itemAt(wf.cats, 0).categoryId).toBe("cat_food");
    expect(wf.reruns).toBe(1);
    expect(state.cursor("i_boa")).toBe("c1");
    expect(state.invLastEnd("brk")).toBe("2026-11-05");

    const second = items(
      [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("t4", "cancel", "cancel", 0, 0, 0, "s_vti", "2026-10-20", { cancel_transaction_id: "t1" })],
      [{ account_id: "brk", security_id: "s_vti", quantity: 2, cost_basis: 240, institution_price: 110, institution_value: 0 }],
      [bank("b5", "card", -30, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "2026-10-21")],
      [bank("b2", "card", 26, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE")], [], false, "2026-09-17");
    state.record(new Activity({ accountId: "chk", plaidId: "b4", date: "2026-10-20", activityType: "WITHDRAWAL", amount: D(30), transferHint: true }), "wf_old");
    const p2 = plan(second, { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p2.new.map((a) => a.plaidId)).toEqual(["b5"]);
    expect(p2.voids.map((r) => r.plaid_id)).toEqual(["t1"]);
    expect(p2.updates.map(([, a, f]) => [a.plaidId, f])).toEqual([["b2", ["amount"]]]);
    expect(p2.retype).toEqual([["b4", "TRANSFER_OUT", "b5"]]);
    expect(p2.reviews).toEqual([]);
    await run(p2, wf, state);
    expect(wf.updates).toContainEqual({ activityId: "wf_old", activityType: "TRANSFER_OUT" });
    expect(wf.deleted.length > 0 && !wf.updates.some((u) => u.void)).toBe(true);
    expect([ledgerRow(state, "t1").voided, ledgerRow(state, "t1").wf_activity_id, ledgerRow(state, "b4").pair_plaid_id]).toEqual([1, null, "b5"]);

    const p3 = plan(items([invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti")], [{ account_id: "brk", security_id: "s_vti", quantity: 2, institution_value: 0, institution_price: 0 }],
      [], [], [], false, "2026-09-17"), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect([p3.new, p3.updates, p3.voids, p3.pairs]).toEqual([[], [], [], []]);
  });

  test("backfill adds history for newly mapped security", async () => {
    const state = new MemoryLedger();
    const wf = new FakeWF();
    const secs = { ...SECS, s_fund: { security_id: "s_fund", ticker_symbol: null, type: "mutual fund", name: "Plan Fund" } };
    const txns = [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("f1", "buy", "buy", 50, 5, 10, "s_fund", "2025-01-10"),
      invTx("f2", "buy", "buy", 50, 5, 10, "s_fund", "2025-02-10")];
    const holdings = [{ account_id: "brk", security_id: "s_vti", quantity: 10, cost_basis: 1000, institution_value: 0, institution_price: 0 },
      { account_id: "brk", security_id: "s_fund", quantity: 12, cost_basis: 120, institution_value: 0, institution_price: 0 },
      { account_id: "brk", security_id: "s_cash", quantity: 500, institution_value: 500, institution_price: 1 }];
    const p1 = plan(items(txns, holdings, [], [], [], true, "2024-11-06", secs), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(new Set(p1.reviews.map((r) => r.reason))).toEqual(new Set(["unmapped security"]));
    await run(p1, wf, state);
    const cashBefore = required(ledgerRow(state, "opening:brk:cash").amount, "amount");

    const symbols = { s_fund: { manual: true } };
    const p2 = plan(items(txns, holdings, [], [], [], false, "2024-11-06", secs), { accounts: ACCOUNTS, symbols }, state, { today: TODAY, backfill: new Set(["brk"]) });
    expect(p2.new.map((a) => a.plaidId).sort()).toEqual(["f1", "f2", "opening:brk:PLANFUND-S_FU"]);
    expect(p2.new.filter((a) => a.plaidId.startsWith("opening:")).map((a) => required(a.quantity, "quantity").toNumber())).toEqual([2]);
    expect(p2.updates.length).toBe(1);
    const [row, a, fields] = itemAt(p2.updates, 0);
    expect([row.plaid_id, fields]).toEqual(["opening:brk:cash", ["amount"]]);
    expect(required(a.amount, "amount").eq(D(cashBefore).plus(100))).toBe(true);
    expect(p2.reviews).toEqual([]);
  });

  test("an account with a sync date but no rows gets its opening position", () => {
    const state = new MemoryLedger();
    state.setInvLastEnd("brk", "2026-11-01");
    const p = plan(items([invTx("t1", "buy", "buy", 600, 6, 100, "s_vti", "2026-11-03")],
      [{ account_id: "brk", security_id: "s_vti", quantity: 3289, cost_basis: 1240, institution_value: 0, institution_price: 0 }], [], [], [], false), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(required(required(p.new.find((a) => a.plaidId === "opening:brk:VTI"), "opening").quantity, "quantity").toNumber()).toBe(3283);
    expect(p.reviews.filter((r) => r.reason === "holdings mismatch")).toEqual([]);
  });

  test("the positions check counts the updated quantity of a pushed row", async () => {
    const state = new MemoryLedger();
    const buy = (qty: number) => invTx("t1", "buy", "buy", 1000, qty, 1000 / qty, "s_vti");
    await run(plan(items([buy(10)], [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_value: 0, institution_price: 0 }], []),
      { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY }), new FakeWF(), state);
    const p = plan(items([buy(20)], [{ account_id: "brk", security_id: "s_vti", quantity: 22, cost_basis: 1240, institution_value: 0, institution_price: 0 }], [], [], [], false),
      { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p.updates.map(([r]) => r.plaid_id)).toEqual(["t1"]);
    expect(p.reviews.filter((r) => r.reason === "holdings mismatch")).toEqual([]);
  });

  test("a mismatch lists the rows this pull adds", async () => {
    const state = new MemoryLedger();
    await run(plan(items([], [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_value: 0, institution_price: 0 }], []),
      { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY }), new FakeWF(), state);
    const p = plan(items([invTx("t9", "transfer", "transfer", 0, 5, 0, "s_vti", TODAY)],
      [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_value: 0, institution_price: 0 }], [], [], [], false), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p.reviews.filter((r) => r.reason === "holdings mismatch").map((r) => r.detail))
      .toEqual([`VTI: Plaid 12, computed 17, diff -5; this pull adds ${TODAY} TRANSFER_IN 5`]);
  });

  test("a trade reported after the opening was computed comes out of the opening", async () => {
    const state = new MemoryLedger();
    const holdings = [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1200, institution_value: 0, institution_price: 0 },
      { account_id: "brk", security_id: "s_cash", quantity: 300, institution_value: 300, institution_price: 1 }];
    await run(plan(items([], holdings, []), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY }), new FakeWF(), state);
    const p = plan(items([invTx("late", "buy", "buy", 500, 5, 100, "s_vti", "2026-11-03")], holdings, [], [], [], false),
      { accounts: ACCOUNTS, symbols: {} }, state, { today: "2026-11-08" });
    const opening = (sym: string) => required(p.updates.find(([r]) => r.plaid_id === `opening:brk:${sym}`), sym)[1];
    expect([required(opening("VTI").quantity, "quantity").toNumber(), required(opening("cash").amount, "amount").toNumber()]).toEqual([7, 800]);
    expect(p.reviews.filter((r) => r.reason === "holdings mismatch")).toEqual([]);
  });

  test("an account pulled only recently gets its full history once", async () => {
    const state = new MemoryLedger();
    state.record(new Activity({ accountId: "brk", plaidId: "recent", date: "2026-10-30", activityType: "INTEREST", amount: D(1) }), "wf1");
    state.setInvLastEnd("brk", "2026-11-01");
    const holdings = [{ account_id: "brk", security_id: "s_vti", quantity: 2, cost_basis: 200, institution_value: 0, institution_price: 0 }];
    const p = plan(items([invTx("old", "buy", "buy", 200, 2, 100, "s_vti", "2024-11-29")], holdings, [], [], [], false), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p.new.map((a) => a.plaidId)).toContain("old");
    expect(p.reviews.filter((r) => r.reason === "holdings mismatch")).toEqual([]);
    expect(p.fullHistory).toEqual(["brk"]);
    await run(p, new FakeWF(), state);
    expect(state.hasFullHistory("brk")).toBe(true);
  });

  test("rebuilt account opens on the shared history start", () => {
    const state = new MemoryLedger();
    expect(openingDay(state, "2024-11-08")).toBe("2024-11-08");
    state.record(new Activity({ accountId: "chk", plaidId: "opening:chk:cash", date: "2024-11-07", activityType: "TRANSFER_IN", amount: D(1) }), "wf1");
    const p = plan(items([invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti")], [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_value: 0, institution_price: 0 }],
      [], [], [], false, "2024-11-08"), { accounts: ACCOUNTS, symbols: {} }, state, { today: TODAY });
    expect(p.new.filter((a) => a.plaidId.startsWith("opening:")).map((a) => [a.plaidId, a.date])).toEqual([["opening:brk:VTI", "2024-11-07"]]);
    expect(openingDay(state, "2025-06-01")).toBe("2025-06-01");
  });

  test("import rows: manual quote mode and comment", () => {
    const a = new Activity({ accountId: "a", plaidId: "t2", date: "2026-03-02", activityType: "BUY", symbol: "TARGET2050CIT-S_CI",
      quantity: D(2), unitPrice: D(50), quoteManual: true, symbolName: "Target 2050 CIT", description: "buy buy" });
    const row = toImportRow(a, "wf1", 1);
    expect([row.quoteMode, row.symbolName, row.comment, row.quantity]).toEqual(["MANUAL", "Target 2050 CIT", "buy buy · plaid:t2", 2]);
    expect("quoteMode" in toImportRow(new Activity({ accountId: "a", plaidId: "x", date: "2026-03-02", activityType: "BUY" }), "wf1", 2)).toBe(false);
  });
});

describe("fetch", () => {
  test("skips investments without the product and isolates errors", async () => {
    const { fetchItems, Plaid, PlaidError } = await import("../../src/importer");
    const calls: string[] = [];
    const plaidStub = new Plaid({ clientId: "id", secret: "secret" }, "sandbox", (url, body) => {
      const ep = url.replace(/^https:\/\/[^/]+/, "");
      const request: unknown = JSON.parse(body);
      const tok = isRecord(request) ? request.access_token : undefined;
      calls.push(ep);
      if (ep.startsWith("/investments")) return Promise.reject(new Error("must not call investments"));
      if (ep === "/item/get") return Promise.resolve({ status: 200, body: JSON.stringify({ item: tok === "exp" ? { consent_expiration_time: "2026-11-10T00:00:00Z" } : {} }) });
      if (ep === "/transactions/sync" && tok === "bad") return Promise.resolve({ status: 500, body: JSON.stringify({ error_code: "INTERNAL_SERVER_ERROR", error_message: "boom" }) });
      if (ep === "/transactions/sync") return Promise.resolve({ status: 200, body: JSON.stringify({ added: [], modified: [], removed: [], next_cursor: "c", has_more: false }) });
      return Promise.resolve({ status: 200, body: JSON.stringify({ accounts: [] }) });
    });
    const tokens = {
      i1: { owner: "AB", institution_name: "Amex", access_token: "ok", products: ["transactions"] },
      i2: { owner: "AB", institution_name: "Broken", access_token: "bad", products: ["transactions"] },
      i3: { owner: "AB", institution_name: "EuroBank", access_token: "exp", products: ["transactions"] },
    };
    const cfg = { ira: { item_id: "i1", kind: "investment" }, card: { item_id: "i1", kind: "credit" },
      chk: { item_id: "i2", kind: "cash" }, eu: { item_id: "i3", kind: "cash" } };
    const logs: string[] = [];
    const last = new Map<string, string>();
    const r = await fetchItems(plaidStub, tokens,
      { accounts: cfg, state: new MemoryLedger(), today: "2026-11-05", log: (m) => logs.push(m), progress: (p) => last.set(p.id, p.state) });
    expect(Object.fromEntries(last)).toEqual({ i1: "done", "i1:tx": "done", i2: "error", "i2:tx": "running", i3: "done", "i3:tx": "done" });
    expect(r.items.map((d) => [d.itemId, d.inv ?? null])).toEqual([["i1", null], ["i3", null]]);
    expect(r.skipped).toEqual(["AB · Broken"]);
    expect(r.blocked).toEqual([]);
    expect(logs.some((m) => m.includes("investment accounts skipped"))).toBe(true);
    expect(PlaidError).toBeDefined();
  });
});
