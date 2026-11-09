// plan + push over several runs, with a fake Wealthfolio.
import { describe, expect, test } from "vitest";
import {
  Activity, D, type ImportRow, type ItemData, MemoryLedger, openingDay, plan, push, type Row,
  toImportRow, type Update, type Writer,
} from "../../src/importer";

const TODAY = "2026-11-05";
const ACCOUNTS = {
  brk: { item_id: "i_schwab", kind: "investment", name: "AB · Schwab", wealthfolio_account_id: "wf_brk" },
  chk: { item_id: "i_boa", kind: "cash", name: "AB · BoA Checking", wealthfolio_account_id: "wf_chk" },
  card: { item_id: "i_boa", kind: "credit", name: "AB · BoA Card", wealthfolio_account_id: "wf_card" },
  old: { item_id: "i_boa", kind: "cash", skip: true, name: "skipped" },
};
const SECS: Record<string, Row> = {
  s_vti: { security_id: "s_vti", ticker_symbol: "VTI", type: "etf" },
  s_cash: { security_id: "s_cash", ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true },
};

const invTx = (i: string, type: string, sub: string, amount: number, qty = 0, price = 0, sec: string | null = null, d = "2026-10-01", kw: Row = {}): Row =>
  ({ investment_transaction_id: i, account_id: "brk", type, subtype: sub, amount, quantity: qty, price, security_id: sec,
    fees: null, date: d, name: sub, iso_currency_code: "USD", ...kw });

const bank = (i: string, acct: string, amount: number, primary = "", detailed = "", d = "2026-10-02"): Row =>
  ({ transaction_id: i, account_id: acct, amount, date: d, pending: false, name: i, merchant_name: null,
    iso_currency_code: "USD", personal_finance_category: { primary, detailed } });

function items(invTxns: Row[], holdings: Row[], added: Row[], modified: Row[] = [], removed: string[] = [], first = true,
  start = "2024-11-06", secs = SECS): ItemData[] {
  return [
    { itemId: "i_schwab", owner: "AB", institution: "Schwab", invStart: { brk: start },
      inv: { investment_transactions: invTxns, securities: secs, accounts: [] },
      holdings: { holdings, securities: Object.values(secs) } },
    { itemId: "i_boa", owner: "AB", institution: "BoA", invStart: {}, firstTxSync: first,
      tx: { added, modified, removed: removed.map((r) => ({ transaction_id: r })), next_cursor: "c1" },
      balances: first ? { chk: { current: 700 }, card: { current: 40 } } : {} },
  ];
}

class FakeWF implements Writer {
  n = 0; imported: ImportRow[] = []; updates: Update[] = []; links: [string, string][] = []; reruns = 0;
  cats: { activityId: string; taxonomyId: string; categoryId: string }[] = []; deleted: string[] = [];
  async delete(ids: string[]) { this.deleted.push(...ids); }
  async commitImport(rows: ImportRow[]) {
    const out = new Map<number, [string, string | null]>();
    for (const r of rows) {
      this.n += 1;
      this.imported.push(r);
      out.set(Number(r.lineNumber), ["imported", `wf${this.n}`]);
    }
    return out;
  }
  async update(updates: Update[]) { this.updates.push(...updates); return [{ errors: [] }]; }
  async linkTransfers(pairs: [string, string][]) { this.links.push(...pairs); }
  async categoryIds() { return new Map([["spending_categories|food", "cat_food"], ["spending_categories|shopping", "cat_shopping"]]); }
  async setCategories(a: FakeWF["cats"]) { this.cats.push(...a); }
  async rerunRules() { this.reruns += 1; return 0; }
}

const run = (p: ReturnType<typeof plan>, wf: Writer, state: MemoryLedger) => push(p, wf, state, ACCOUNTS, () => {});

describe("sync", () => {
  test("full cycle", async () => {
    const state = new MemoryLedger();
    const wf = new FakeWF();
    const first = items(
      [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("t2", "cash", "deposit", -500, 0, 0, null, "2026-10-03"),
        invTx("t3", "buy", "buy", 50, 50, 1, "s_cash")], // sweep: dropped
      [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240, institution_price: 110 },
        { account_id: "brk", security_id: "s_cash", quantity: 300, institution_value: 300 }],
      [bank("b1", "chk", 500, "TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"),
        bank("b2", "card", 25, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), bank("b3", "old", 1)]);
    const p = plan(first, ACCOUNTS, {}, state, TODAY);
    expect(p.new.map((a) => [a.plaidId, a.activityType]).sort()).toEqual([["b1", "TRANSFER_OUT"], ["b2", "WITHDRAWAL"],
      ["opening:brk:VTI", "TRANSFER_IN"], ["opening:brk:cash", "TRANSFER_IN"], ["opening:card:cash", "TRANSFER_OUT"],
      ["opening:chk:cash", "TRANSFER_IN"], ["t1", "BUY"], ["t2", "TRANSFER_IN"]]);
    expect(p.pairs).toEqual([["b1", "t2"]]);
    expect(Object.fromEntries(p.categories)).toEqual({ b2: ["spending_categories", "food_coffee"] });
    expect(p.reviews).toEqual([]); // positions reconcile: 2 opening + 10 bought = 12
    const stats = await run(p, wf, state);
    expect([stats.imported, stats.linked, stats.categorized]).toEqual([8, 1, 1]);
    expect(wf.cats[0].categoryId).toBe("cat_food"); // food_coffee missing -> parent
    expect(wf.reruns).toBe(1); // the user's own rules, for rows Wealthfolio imported without them
    expect(state.cursor("i_boa")).toBe("c1");
    expect(state.invLastEnd("brk")).toBe("2026-11-05");

    // Second run: overlap re-pulls t1, a txn is edited, one cancelled, a payment pairs with an old leg.
    const second = items(
      [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("t4", "cancel", "cancel", 0, 0, 0, "s_vti", "2026-10-20", { cancel_transaction_id: "t1" })],
      [{ account_id: "brk", security_id: "s_vti", quantity: 2, cost_basis: 240, institution_price: 110 }],
      [bank("b5", "card", -30, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "2026-10-21")],
      [bank("b2", "card", 26, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE")], [], false, "2026-09-17");
    // an old unpaired checking payment, already in Wealthfolio
    state.record(new Activity({ accountId: "chk", plaidId: "b4", date: "2026-10-20", activityType: "WITHDRAWAL", amount: D(30), transferHint: true }), "wf_old");
    const p2 = plan(second, ACCOUNTS, {}, state, TODAY);
    expect(p2.new.map((a) => a.plaidId)).toEqual(["b5"]);
    expect(p2.voids.map((r) => r.plaid_id)).toEqual(["t1"]);
    expect(p2.updates.map(([, a, f]) => [a.plaidId, f])).toEqual([["b2", ["amount"]]]);
    expect(p2.retype).toEqual([["b4", "TRANSFER_OUT", "b5"]]);
    expect(p2.reviews).toEqual([]); // 2 opening + 10 bought - voided 10 = 2
    await run(p2, wf, state);
    expect(wf.updates).toContainEqual({ activityId: "wf_old", activityType: "TRANSFER_OUT" });
    expect(wf.deleted.length > 0 && !wf.updates.some((u) => u.void)).toBe(true); // Spending counts voided rows
    expect([state.get("t1")!.voided, state.get("t1")!.wf_activity_id, state.get("b4")!.pair_plaid_id]).toEqual([1, null, "b5"]);

    // Third run with nothing new is a no-op.
    const p3 = plan(items([invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti")], [{ account_id: "brk", security_id: "s_vti", quantity: 2 }],
      [], [], [], false, "2026-09-17"), ACCOUNTS, {}, state, TODAY);
    expect([p3.new, p3.updates, p3.voids, p3.pairs]).toEqual([[], [], [], []]);
  });

  test("backfill adds history for newly mapped security", async () => {
    const state = new MemoryLedger();
    const wf = new FakeWF();
    const secs = { ...SECS, s_fund: { security_id: "s_fund", ticker_symbol: null, type: "mutual fund", name: "Plan Fund" } };
    const txns = [invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), invTx("f1", "buy", "buy", 50, 5, 10, "s_fund", "2025-01-10"),
      invTx("f2", "buy", "buy", 50, 5, 10, "s_fund", "2025-02-10")];
    const holdings = [{ account_id: "brk", security_id: "s_vti", quantity: 10, cost_basis: 1000 },
      { account_id: "brk", security_id: "s_fund", quantity: 12, cost_basis: 120 },
      { account_id: "brk", security_id: "s_cash", quantity: 500, institution_value: 500 }];
    const p1 = plan(items(txns, holdings, [], [], [], true, "2024-11-06", secs), ACCOUNTS, {}, state, TODAY);
    expect(new Set(p1.reviews.map((r) => r.reason))).toEqual(new Set(["unmapped security"]));
    await run(p1, wf, state);
    const cashBefore = state.get("opening:brk:cash")!.amount!;

    // User maps the fund later. A normal run sees nothing (old rows are outside the 14-day window).
    const symbols = { s_fund: { manual: true } };
    const p2 = plan(items(txns, holdings, [], [], [], false, "2024-11-06", secs), ACCOUNTS, symbols, state, TODAY, new Set(["brk"]));
    expect(p2.new.map((a) => a.plaidId).sort()).toEqual(["f1", "f2", "opening:brk:PLANFUND-S_FU"]);
    expect(p2.new.filter((a) => a.plaidId.startsWith("opening:")).map((a) => a.quantity!.toNumber())).toEqual([2]);
    // Opening cash grows by the 100 the fund buys spent, since that cash must have been there.
    expect(p2.updates.length).toBe(1);
    const [row, a, fields] = p2.updates[0];
    expect([row.plaid_id, fields]).toEqual(["opening:brk:cash", ["amount"]]);
    expect(a.amount!.eq(D(cashBefore).plus(100))).toBe(true);
    expect(p2.reviews).toEqual([]);
  });

  test("rebuilt account opens on the shared history start", () => {
    const state = new MemoryLedger();
    expect(openingDay(state, "2024-11-08")).toBe("2024-11-08"); // first run: Plaid's window start
    state.record(new Activity({ accountId: "chk", plaidId: "opening:chk:cash", date: "2024-11-07", activityType: "TRANSFER_IN", amount: D(1) }), "wf1");
    // Reimported a day later: Plaid's window starts a day later, the opening keeps the shared day.
    const p = plan(items([invTx("t1", "buy", "buy", 1000, 10, 100, "s_vti")], [{ account_id: "brk", security_id: "s_vti", quantity: 12, cost_basis: 1240 }],
      [], [], [], false, "2024-11-08"), ACCOUNTS, {}, state, TODAY);
    expect(p.new.filter((a) => a.plaidId.startsWith("opening:")).map((a) => [a.plaidId, a.date])).toEqual([["opening:brk:VTI", "2024-11-07"]]);
    expect(openingDay(state, "2025-06-01")).toBe("2025-06-01"); // an account linked much later opens on its own
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
    const plaidStub = new Plaid("id", "secret", "sandbox", async (url, body) => {
      const ep = url.replace(/^https:\/\/[^/]+/, "");
      const tok = JSON.parse(body).access_token;
      calls.push(ep);
      if (ep.startsWith("/investments")) throw new Error("must not call investments");
      if (ep === "/item/get") return { status: 200, body: JSON.stringify({ item: tok === "exp" ? { consent_expiration_time: "2026-11-10T00:00:00Z" } : {} }) };
      if (ep === "/transactions/sync" && tok === "bad") return { status: 500, body: JSON.stringify({ error_code: "INTERNAL_SERVER_ERROR", error_message: "boom" }) };
      if (ep === "/transactions/sync") return { status: 200, body: JSON.stringify({ added: [], modified: [], removed: [], next_cursor: "c", has_more: false }) };
      return { status: 200, body: JSON.stringify({ accounts: [] }) };
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
    const r = await fetchItems(plaidStub, tokens, cfg, new MemoryLedger(), "2026-11-05",
      { log: (m) => logs.push(m), progress: (p) => last.set(p.id, p.state) });
    // Each connection ends done or error; its transactions line ends done. A consent end date is not reported.
    expect(Object.fromEntries(last)).toEqual({ i1: "done", "i1:tx": "done", i2: "error", "i2:tx": "running", i3: "done", "i3:tx": "done" });
    expect(r.items.map((d) => [d.itemId, d.inv ?? null])).toEqual([["i1", null], ["i3", null]]);
    expect(r.skipped).toEqual(["AB · Broken"]);
    expect(r.blocked).toEqual([]); // a Plaid error is not an expired login
    expect(logs.some((m) => m.includes("investment accounts skipped"))).toBe(true);
    expect(PlaidError).toBeDefined();
  });
});
