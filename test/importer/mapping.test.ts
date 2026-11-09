// Plaid rows -> Wealthfolio activities.
import { describe, expect, test } from "vitest";
import {
  Activity, D, type Dec, INCOME, SPENDING, biltPassthrough, convert, entry, fixSplitPrices, holdingsBySymbol, hkey, mapBankTransaction,
  mapCategory, mapInvestmentTransactions, matchTransfers, openingActivities, positions,
  rebases, reconcile, resolve, resolveSplits, yahooSymbol, type Row,
} from "../../src/importer";

const n = (v: Dec | null | undefined) => (v == null ? null : v.toNumber());

const SECS: Record<string, Row> = {
  s_vti: { security_id: "s_vti", ticker_symbol: "VTI", type: "etf", market_identifier_code: "ARCX" },
  s_td: { security_id: "s_td", ticker_symbol: "TD", type: "equity", market_identifier_code: "XTSE" },
  s_spaxx: { security_id: "s_spaxx", ticker_symbol: "SPAXX", type: "mutual fund", is_cash_equivalent: true },
  s_cit: { security_id: "s_cit", ticker_symbol: null, type: "mutual fund", name: "Target 2050 CIT" },
  s_btc: { security_id: "s_btc", ticker_symbol: "BTC", type: "cryptocurrency" },
  s_opt: { security_id: "s_opt", ticker_symbol: "AAPL240621C00190000", type: "derivative" },
  s_sdba: { security_id: "s_sdba", ticker_symbol: null, type: "other", name: "Self-Directed Brokerage" },
};

function tx(i: string, type: string, sub: string, amount = 0, qty = 0, price = 0, sec: string | null = null,
  fees: number | null = null, kw: Row = {}): Row {
  return { investment_transaction_id: i, account_id: "a1", type, subtype: sub, amount, quantity: qty, price,
    security_id: sec, fees, date: "2026-03-02", name: `${type} ${sub}`, iso_currency_code: "USD", ...kw };
}
const one = (rows: Row[], overrides: Record<string, Row> = {}) => mapInvestmentTransactions(rows, SECS, overrides);

describe("investments", () => {
  test("buy sell absolute values and fee", () => {
    const [b, s] = one([tx("t1", "buy", "buy", 1004.95, 10, 100, "s_vti", 4.95), tx("t2", "sell", "sell", -500, -5, 100, "s_vti")]).activities;
    expect([b.activityType, b.symbol, n(b.quantity), n(b.unitPrice), n(b.fee)]).toEqual(["BUY", "VTI", 10, 100, 4.95]);
    expect([s.activityType, n(s.quantity), s.amount, s.subtype]).toEqual(["SELL", 5, null, null]);
    expect(b.comment.endsWith("plaid:t1")).toBe(true);
  });

  test("mic suffix and crypto", () => {
    const r = one([tx("t1", "buy", "buy", 100, 1, 100, "s_td"), tx("t2", "buy", "buy", 50, 0.001, 50000, "s_btc")]);
    expect(r.activities.map((a) => a.symbol)).toEqual(["TD.TO", "BTC-USD"]);
    expect(r.activities[1].instrumentType).toBe("CRYPTO");
  });

  test("price derived from amount when missing", () => {
    expect(n(one([tx("t1", "buy", "contribution", 200, 4, 0, "s_vti")]).activities[0].unitPrice)).toBe(50);
  });

  test("sweep trades dropped and money-market dividend is interest", () => {
    const r = one([tx("t1", "buy", "buy", 100, 100, 1, "s_spaxx"), tx("t2", "cash", "dividend", -1.23, 0, 0, "s_spaxx")]);
    expect(r.activities.length).toBe(1);
    expect([r.activities[0].activityType, n(r.activities[0].amount), r.activities[0].symbol]).toEqual(["INTEREST", 1.23, null]);
  });

  test("money market override as investment", () => {
    expect(one([tx("t1", "buy", "buy", 100, 100, 1, "s_spaxx")], { s_spaxx: { investment: true } }).activities[0].symbol).toBe("SPAXX");
  });

  test("dividend subtypes, tax, fee", () => {
    const r = one([tx("t1", "cash", "qualified dividend", -10, 0, 0, "s_vti"), tx("t2", "cash", "tax withheld", 1.5),
      tx("t3", "fee", "margin expense", 3), tx("t4", "fee", "account fee", -2), tx("t5", "cash", "interest", -0.5)]);
    expect(r.activities.map((a) => [a.activityType, a.subtype, n(a.amount)])).toEqual([["DIVIDEND", "QUALIFIED", 10],
      ["TAX", "WITHHOLDING", 1.5], ["FEE", "INTEREST_CHARGE", 3], ["CREDIT", "REFUND", 2], ["INTEREST", null, 0.5]]);
  });

  test("cash flows are transfer candidates", () => {
    const r = one([tx("t1", "cash", "deposit", -1000), tx("t2", "transfer", "transfer", 250), tx("t3", "cash", "contribution", -300)]);
    expect(r.activities.map((a) => [a.activityType, n(a.amount), a.transferHint])).toEqual([
      ["DEPOSIT", 1000, true], ["WITHDRAWAL", 250, true], ["DEPOSIT", 300, true]]);
  });

  test("security transfer in and out", () => {
    const r = one([tx("t1", "transfer", "transfer", 0, 3, 200, "s_vti"), tx("t2", "transfer", "send", 0, -1, 200, "s_vti")]);
    expect(r.activities.map((a) => [a.activityType, n(a.quantity)])).toEqual([["TRANSFER_IN", 3], ["TRANSFER_OUT", 1]]);
  });

  test("cancel drops both", () => {
    const r = one([tx("t1", "buy", "buy", 100, 1, 100, "s_vti"),
      tx("t2", "cancel", "cancel", -100, -1, 100, "s_vti", null, { cancel_transaction_id: "t1" })]);
    expect(r.activities).toEqual([]);
    expect([...r.cancelledIds].sort()).toEqual(["t1", "t2"]);
  });

  test("unmapped and corporate action go to review", () => {
    const r = one([tx("t1", "buy", "buy", 100, 1, 100, "s_cit"), tx("t3", "transfer", "merger", 0, 1, 0, "s_vti"), tx("t4", "zzz", "weird", 1)]);
    expect(r.activities).toEqual([]);
    expect(r.reviews.map((x) => x.reason)).toEqual(["unmapped security", "corporate action: merger", "unknown type zzz/weird"]);
    expect(Object.fromEntries(r.unmappedSecurities)).toEqual({ s_cit: "Target 2050 CIT" });
  });

  test("symbol override and exclude", () => {
    const r = one([tx("t1", "buy", "buy", 100, 1, 100, "s_cit"), tx("t2", "buy", "buy", 100, 1, 1, "s_sdba")],
      { s_cit: { symbol: "VFF2050" }, s_sdba: { exclude: true } });
    expect(r.activities.map((a) => a.symbol)).toEqual(["VFF2050"]);
    expect(r.reviews).toEqual([]);
  });

  test("split ratio from position", () => {
    const r = one([tx("t1", "transfer", "split", 0, 30, 0, "s_vti", null, { date: "2026-03-05" })]);
    expect(resolveSplits(r.activities, new Map([[hkey("a1", "VTI"), D(10)]]))).toEqual([]);
    expect(n(r.activities[0].amount)).toBe(4);
    const r2 = one([tx("t1", "transfer", "split", 0, 30, 0, "s_vti")]);
    expect(resolveSplits(r2.activities)[0].reason).toBe("split with unknown position");
  });
});

function bank(i: string, acct: string, amount: number, primary = "", detailed = "", kw: Row = {}): Row {
  return { transaction_id: i, account_id: acct, amount, date: "2026-03-02", pending: false, name: `n${i}`,
    merchant_name: `M${i}`, iso_currency_code: "USD", personal_finance_category: { primary, detailed }, ...kw };
}
const KINDS = { chk: "cash", card: "credit", brk: "investment" };
const act = (accountId: string, plaidId: string, date: string, activityType: string, amount: string, kw: Partial<Activity> = {}) =>
  new Activity({ accountId, plaidId, date, activityType, amount: D(amount), transferHint: true, ...kw });

describe("bank and transfers", () => {
  test("bank and card mapping", () => {
    const txns = [
      bank("1", "chk", 12.5, "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), bank("2", "chk", -2000, "INCOME", "INCOME_WAGES"),
      bank("3", "chk", -0.4, "INCOME", "INCOME_INTEREST_EARNED"), bank("4", "card", 50, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER"),
      bank("5", "card", -20, "GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER"),
      bank("6", "card", -300, "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"), bank("7", "chk", 5, "", "", { pending: true }),
      bank("8", "brk", 100), bank("9", "card", 25, "BANK_FEES", "BANK_FEES_INTEREST_CHARGE"),
    ];
    // As plan.ts does: only bank and card accounts; investment rows come from the Investments product.
    const kinds: Record<string, string> = KINDS;
    const r = { activities: txns.filter((t) => kinds[t.account_id] === "cash" || kinds[t.account_id] === "credit")
      .map((t) => mapBankTransaction(t, kinds[t.account_id])).filter((a) => a != null) };
    expect(r.activities.map((a) => [a.plaidId, a.activityType, a.subtype, n(a.amount), a.transferHint])).toEqual([
      ["1", "WITHDRAWAL", null, 12.5, false], ["2", "DEPOSIT", null, 2000, false], ["3", "INTEREST", null, 0.4, false],
      ["4", "WITHDRAWAL", null, 50, false], ["5", "CREDIT", "REFUND", 20, false], ["6", "TRANSFER_IN", null, 300, true],
      ["9", "FEE", "INTEREST_CHARGE", 25, false]]);
    expect(r.activities[0].description).toBe("M1");
  });

  test("transfer matching within three days", () => {
    const acts = [act("chk", "p1", "2026-03-01", "WITHDRAWAL", "300"), act("card", "p2", "2026-03-03", "DEPOSIT", "300"),
      act("chk", "p3", "2026-03-01", "WITHDRAWAL", "99"), act("brk", "p4", "2026-03-09", "DEPOSIT", "99"),
      act("chk", "p5", "2026-03-01", "WITHDRAWAL", "40", { transferHint: false }), act("card", "p6", "2026-03-01", "DEPOSIT", "40")];
    expect(matchTransfers(acts).map(([o, i]) => [o.plaidId, i.plaidId])).toEqual([["p1", "p2"]]);
    expect([acts[0].activityType, acts[1].activityType, acts[2].activityType]).toEqual(["TRANSFER_OUT", "TRANSFER_IN", "WITHDRAWAL"]);
  });

  test("transfer prefers closest date", () => {
    const acts = [act("chk", "o", "2026-03-01", "WITHDRAWAL", "5"), act("brk", "far", "2026-03-04", "DEPOSIT", "5"),
      act("card", "near", "2026-03-02", "DEPOSIT", "5")];
    expect(matchTransfers(acts)[0][1].plaidId).toBe("near");
  });

  test("transfer prefers shared reference number", () => {
    const acts = [act("chk2", "A_bkrg", "2026-03-01", "WITHDRAWAL", "5000", { description: "Manual DB-Bkrg 03/01" }),
      act("chk2", "z_xfer", "2026-03-01", "WITHDRAWAL", "5000", { description: "Online Transfer to CHK ...1234 transaction#: 12345678901 03/01" }),
      act("chk1", "in", "2026-03-01", "DEPOSIT", "5000", { description: "Online Transfer from CHK ...5678 transaction#: 12345678901" })];
    const pairs = matchTransfers(acts);
    expect(pairs.map(([o, i]) => [o.plaidId, i.plaidId])).toEqual([["z_xfer", "in"]]);
    expect(acts[0].activityType).toBe("WITHDRAWAL");
  });

  test("bilt housing pair dropped and bank card payment is transfer", () => {
    const rows = [bank("c1", "card", -2500.0, "INCOME", "INCOME_RENTAL", { date: "2026-11-02", name: "Payment - Bilt Housing" }),
      bank("h1", "card", 2500.0, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", { date: "2026-11-02", name: "Bilt Housing Payment", merchant_name: "Bilt Housing Payment" }),
      bank("h2", "card", 40, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", { name: "Bilt Rewards", merchant_name: "Bilt Rewards" })];
    expect([...biltPassthrough(rows)].sort()).toEqual(["c1", "h1"]);
    const a = mapBankTransaction(bank("p1", "chk", 2540.0, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", { name: "BILT CARD PMT PPD ID: 1" }), "cash")!;
    expect([a.transferHint, a.category]).toEqual([true, null]);
  });

  test("card statement credit is credit", () => {
    const paze = bank("p", "card", -10, "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", { name: "$10 PAZE CREDIT THANK YOU" });
    const pay = bank("q", "card", -500, "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", { name: "AUTOMATIC PAYMENT - THANK" });
    expect(mapBankTransaction(paze, "credit")!.activityType).toBe("CREDIT");
    expect(mapBankTransaction(pay, "credit")!.activityType).toBe("TRANSFER_IN");
  });
});

describe("positions", () => {
  test("opening positions and cash", () => {
    const [hs, cash] = holdingsBySymbol([
      { account_id: "a1", security_id: "s_vti", quantity: 15, cost_basis: 1500, institution_price: 250 },
      { account_id: "a1", security_id: "s_spaxx", quantity: 400, institution_value: 400 }], SECS, {});
    const acts = one([tx("t1", "buy", "buy", 1000, 10, 100, "s_vti"), tx("t2", "cash", "deposit", -1200)]).activities;
    const [opening, reviews] = openingActivities("a1", "2024-11-05", hs, cash.get("a1")!, acts);
    expect(reviews).toEqual([]);
    const [pos, c] = opening;
    expect([pos.activityType, pos.symbol, n(pos.quantity), n(pos.unitPrice)]).toEqual(["TRANSFER_IN", "VTI", 5, 100]);
    // 400 now = opening + 1200 deposit - 1000 buy -> opening 200
    expect([c.activityType, n(c.amount)]).toEqual(["TRANSFER_IN", 200]);
  });

  test("opening price is per share held at the opening, across a later split", () => {
    // 10 shares at the opening, an 8-for-1 split adds 70: 80 now, cost 4000 (50 per share today).
    const [hs] = holdingsBySymbol([{ account_id: "a1", security_id: "s_vti", quantity: 80, cost_basis: 4000, institution_price: 60 }], SECS, {});
    const split = new Activity({ accountId: "a1", plaidId: "sp", date: "2026-04-21", activityType: "SPLIT", symbol: "VTI", splitDelta: D(70) });
    let [opening] = openingActivities("a1", "2024-11-05", hs, null, [split]);
    expect([n(opening[0].quantity), n(opening[0].unitPrice)]).toEqual([10, 400]); // 400 a pre-split share, 4000 in all
    [opening] = openingActivities("a1", "2024-11-05", new Map([[hkey("a1", "VTI"), { ...hs.get(hkey("a1", "VTI"))!, cost_basis: null }]]), null, [split], "USD", () => D(75));
    expect(n(opening[0].unitPrice)).toBe(600); // Yahoo's split-adjusted 75 on that day, times 8
  });

  test("a pre-split price already adjusted by Plaid is scaled back; an unadjusted one is left", () => {
    const mk = (id: string, date: string, price: number) => new Activity({ accountId: "a1", plaidId: id, date, activityType: "TRANSFER_IN",
      symbol: "VGT", quantity: D(205), unitPrice: D(price) });
    const split = new Activity({ accountId: "a1", plaidId: "sp", date: "2026-04-21", activityType: "SPLIT", symbol: "VGT", splitDelta: D(1435), amount: D(8) });
    const adjusted = mk("x", "2026-04-09", 92.5), raw = mk("y", "2025-12-04", 764), after = mk("z", "2026-06-26", 113);
    const yahoo = (_s: string | null, day: string) => D(day === "2026-04-09" ? 93 : day === "2025-12-04" ? 96 : 113.5); // split-adjusted closes
    const rv = fixSplitPrices([adjusted, raw, after], [split, adjusted, raw, after], yahoo);
    expect([n(adjusted.unitPrice), n(raw.unitPrice), n(after.unitPrice)]).toEqual([740, 764, 113]);
    expect(rv.map((r) => r.plaidId)).toEqual(["x"]);
  });

  test("opening missing cost basis and negative", () => {
    const [hs] = holdingsBySymbol([{ account_id: "a1", security_id: "s_vti", quantity: 2, cost_basis: null, institution_price: 250 }], SECS, {});
    const acts = one([tx("t1", "buy", "buy", 1, 3, 100, "s_td"), tx("t2", "sell", "sell", 1, -3, 100, "s_td"),
      tx("t3", "sell", "sell", 1, -1, 100, "s_td")]).activities;
    let [opening, reviews] = openingActivities("a1", "2024-11-05", hs, null, acts);
    // Sold since: the earliest Plaid price; still held: today's price.
    expect(opening.map((o) => [o.symbol, n(o.quantity), n(o.unitPrice)])).toEqual([["TD.TO", 1, 100], ["VTI", 2, 250]]);
    expect(new Set(reviews.map((r) => r.reason))).toEqual(new Set(["opening cost basis missing"]));
    // A market close on the opening date wins over both.
    [opening] = openingActivities("a1", "2024-11-05", hs, null, acts, "USD", () => D(7));
    expect(opening.map((o) => n(o.unitPrice))).toEqual([7, 7]);
  });

  test("yahoo symbol", () => {
    expect([yahooSymbol(SECS.s_td), yahooSymbol(SECS.s_cit)]).toEqual(["TD.TO", null]);
  });

  test("reconcile flags mismatch", () => {
    const acts = [new Activity({ accountId: "a1", plaidId: "x", date: "2026-01-01", activityType: "BUY", symbol: "VTI", quantity: D(10), unitPrice: D(1) })];
    const hs = new Map<string, Row>([[hkey("a1", "VTI"), { quantity: 9 }], [hkey("a1", "VXUS"), { quantity: 1 }]]);
    expect(reconcile(new Set(["a1"]), positions(acts), hs).map((r) => r.plaidId)).toEqual(["reconcile:VTI", "reconcile:VXUS"]);
  });

  test("category map", () => {
    expect(mapCategory("FOOD_AND_DRINK_COFFEE", false)).toEqual([SPENDING, "food_coffee"]);
    expect(mapCategory("FOOD_AND_DRINK_BEER_WINE", false)).toEqual([SPENDING, "food"]);
    expect(mapCategory("INCOME_SALARY", true)).toEqual([INCOME, "income_salary"]);
    expect(mapCategory("INCOME_WAGES", true)).toEqual([INCOME, "income_salary"]);
    expect(mapCategory("INCOME_CONTRACTOR", true)).toEqual([INCOME, "income_freelance"]);
    expect(mapCategory("SOMETHING_NEW", false)).toEqual([SPENDING, "other_expense"]);
    expect(mapCategory("GENERAL_MERCHANDISE_OTHER", true)).toBeNull();
    expect(mapCategory(null, false)).toBeNull();
  });

  test("manual quote flag and symbol", () => {
    const [td, cit] = one([tx("t1", "buy", "buy", 100, 1, 100, "s_td"), tx("t2", "buy", "buy", 100, 2, 50, "s_cit")],
      { s_td: { manual: true }, s_cit: { manual: true } }).activities;
    expect([td.symbol, td.quoteManual, cit.symbol, cit.quoteManual]).toEqual(["TD.TO", true, "TARGET2050CIT-S_CI", true]);
  });
});

const OPT_SECS: Record<string, Row> = {
  o_occ: { security_id: "o_occ", ticker_symbol: "NFLX180201C00355000", type: "derivative", name: "Nflx Feb 01'18 $355 Call" },
  o_built: { security_id: "o_built", ticker_symbol: null, type: "derivative", name: "SPY put",
    option_contract: { contract_type: "put", expiration_date: "2026-12-18", strike_price: 450.5, underlying_security_ticker: "SPY" } },
  o_bad: { security_id: "o_bad", ticker_symbol: "WEIRD", type: "derivative", name: "Odd option" },
};

describe("options and plans", () => {
  test("option trades in contracts with open/close", () => {
    const r = mapInvestmentTransactions([
      tx("o1", "buy", "buy", 305, 300, 1.0, "o_occ", 5), tx("o2", "sell", "sell", -200, -200, 1.0, "o_occ"),
      tx("o3", "sell", "sell short", -150, -100, 1.5, "o_built"), tx("o4", "buy", "buy to cover", 50, 100, 0.5, "o_built"),
      tx("o5", "transfer", "expire", 0, -100, 0, "o_occ"), tx("o6", "buy", "buy", 10, 100, 0.1, "o_bad")], OPT_SECS, {});
    expect(r.activities.map((a) => [a.activityType, a.subtype, a.symbol, a.instrumentType, n(a.quantity), n(a.unitPrice)])).toEqual([
      ["BUY", "POSITION_OPEN", "NFLX180201C00355000", "OPTION", 3, 1],
      ["SELL", "POSITION_CLOSE", "NFLX180201C00355000", "OPTION", 2, 1],
      ["SELL", "POSITION_OPEN", "SPY261218P00450500", "OPTION", 1, 1.5],
      ["BUY", "POSITION_CLOSE", "SPY261218P00450500", "OPTION", 1, 0.5],
      ["ADJUSTMENT", "OPTION_EXPIRY", "NFLX180201C00355000", "OPTION", 1, null]]);
    expect(n(r.activities[0].fee)).toBe(5);
    expect(r.reviews.map((x) => x.reason)).toEqual(["unmapped security"]);
  });

  test("option price from amount and multiplier override", () => {
    const a = mapInvestmentTransactions([tx("o1", "buy", "buy", 46, 4600, 0, "o_occ")], OPT_SECS, {}).activities[0];
    expect([n(a.quantity), n(a.unitPrice)]).toEqual([46, 0.01]);
    const mini = mapInvestmentTransactions([tx("o1", "buy", "buy", 10, 100, 0.1, "o_occ")], OPT_SECS, { o_occ: { multiplier: 10 } }).activities[0];
    expect(n(mini.quantity)).toBe(10);
  });

  test("equity short uses position subtypes", () => {
    const r = one([tx("t1", "sell", "sell short", -100, -1, 100, "s_vti"), tx("t2", "buy", "buy to cover", 90, 1, 90, "s_vti")]);
    expect(r.activities.map((a) => a.subtype)).toEqual(["POSITION_OPEN", "POSITION_CLOSE"]);
  });

  test("option holdings scaled and opening price per share", () => {
    const [hs] = holdingsBySymbol([{ account_id: "a1", security_id: "o_occ", quantity: 10000, cost_basis: 100, institution_price: 0.011 }], OPT_SECS, {});
    expect(n(hs.get(hkey("a1", "NFLX180201C00355000"))!.quantity)).toBe(100);
    const [opening, reviews] = openingActivities("a1", "2024-11-05", hs, null, []);
    expect(reviews).toEqual([]);
    expect([n(opening[0].quantity), n(opening[0].unitPrice), opening[0].instrumentType]).toEqual([100, 0.01, "OPTION"]);
  });

  test("stock plan vests in, journals out, cash journal", () => {
    const rows = [tx("v1", "cash", "withdrawal", 0, 10.956, 1, "s_vti", null, { name: "RESTRICTED STOCK DEPOSIT" }),
      tx("j1", "transfer", "transfer", 0, 1551.191, 0, "s_vti", null, { name: "JOURNAL - TRANSFER" }),
      tx("j2", "transfer", "transfer", 571.38, 0, 0, "s_vti", null, { name: "Journal To Account 07E3 - JRNLFUND" })];
    const [v, j, c] = mapInvestmentTransactions(rows, SECS, {}, "USD", new Set(["a1"])).activities;
    expect([v.activityType, v.symbol, n(v.quantity), n(v.unitPrice)]).toEqual(["TRANSFER_IN", "VTI", 10.956, 0]);
    expect([j.activityType, n(j.quantity)]).toEqual(["TRANSFER_OUT", 1551.191]);
    expect([c.activityType, c.symbol, n(c.amount)]).toEqual(["WITHDRAWAL", null, 571.38]);
    // Outside a stock plan, a positive share transfer is incoming.
    expect(one(rows.slice(1, 2)).activities[0].activityType).toBe("TRANSFER_IN");
  });

  test("plan contribution is shares in, not a buy", () => {
    const [a] = one([tx("c1", "buy", "contribution", 1420, 11.732, 121.04, "s_vti")]).activities;
    expect([a.activityType, n(a.quantity), n(a.unitPrice)]).toEqual(["TRANSFER_IN", 11.732, 121.04]);
  });

  test("partial fill uses the filled amount", () => {
    const [a] = one([tx("p1", "buy", "buy", 135, 40, 135, "s_vti", null,
      { name: "buy 40.000000 shares for $135.00 each. This order is partially filled." })]).activities;
    expect(n(a.quantity)).toBe(1);
  });

  test("fidelity split distribution and merrill sweep", () => {
    const [a] = one([tx("d1", "cash", "deposit", -12345.67, 120.5, 0, "s_vti", null, { name: "EXAMPLE SECTOR ETF - DISTRIBUTION" })]).activities;
    expect([a.activityType, n(a.splitDelta), a.amount]).toEqual(["SPLIT", 120.5, null]);
    expect(resolve({ security_id: "m", ticker_symbol: "Deposit", type: "other", name: "Ml Direct Deposit Progrm" }, {}).kind).toBe("cash");
  });

  test("merrill reinvestment memo dropped when fill present", () => {
    const r = one([tx("m", "buy", "dividend reinvestment", 50.0, 0, 0, "s_vti", null, { date: "2026-09-25" }),
      tx("f", "buy", "dividend reinvestment", 50.0, 0.5, 100, "s_vti", null, { date: "2026-09-29" }),
      tx("lone", "buy", "dividend reinvestment", 5, 0, 0, "s_vti")]);
    expect(r.activities.map((a) => a.plaidId)).toEqual(["f"]);
    expect(r.reviews.map((x) => x.reason)).toEqual(["trade with zero quantity"]);
  });

  test("same-day reversals, merrill split and unpriced transfer", () => {
    const r = one([tx("c", "buy", "contribution", 1000.0, 25, 40, "s_vti"), tx("i", "transfer", "transfer", -1000.0, 25, 40, "s_vti"),
      tx("o", "transfer", "transfer", 1000.0, -25, 40, "s_vti"),
      tx("s", "cash", "withdrawal", 0, 300, 0, "s_vti", null, { date: "2026-04-21" }),
      tx("rv", "cash", "withdrawal", 0, -300, 0, "s_vti", null, { date: "2026-04-22" }),
      tx("rp", "cash", "withdrawal", 0, 300, 0, "s_vti", null, { date: "2026-04-22" }),
      tx("j", "transfer", "transfer", 0, 203, 0, "s_vti", null, { date: "2026-02-25" })]);
    expect(r.activities.map((a) => [a.plaidId, a.activityType])).toEqual([["c", "TRANSFER_IN"], ["s", "SPLIT"], ["j", "TRANSFER_IN"]]);
    expect([n(r.activities[1].splitDelta), r.activities[2].marketPrice]).toEqual([300, true]);
  });

  test("vest stays a vest in a stock plan", () => {
    const [a] = mapInvestmentTransactions([tx("v", "cash", "withdrawal", 0, 10, 0, "s_vti")], SECS, {}, "USD", new Set(["a1"])).activities;
    expect([a.activityType, a.marketPrice]).toEqual(["TRANSFER_IN", true]);
  });
});

describe("tracking", () => {
  test("tracked fund converted to target units", () => {
    const t = entry("voo", "2026-11-06", D("100.00"), D("500.00"));
    expect([t.symbol, t.ratio]).toEqual(["VOO", 0.2]);
    const symbols = { s_cit: { name: "Target 2050 CIT", symbol: null, track: t } };
    const [rows, holds, secs] = convert([tx("b", "buy", "contribution", 1000.0, 10, 100.0, "s_cit"), tx("v", "buy", "buy", 100, 1, 100, "s_vti")],
      [{ security_id: "s_cit", quantity: 50, institution_price: 100.0, cost_basis: 5000 }], SECS, symbols);
    expect([n(rows[0].quantity), n(rows[0].price), rows[0].amount]).toEqual([2, 500, 1000]);
    expect([rows[1].quantity, SECS.s_cit.ticker_symbol]).toEqual([1, null]); // inputs untouched
    expect([n(holds[0].quantity), n(holds[0].institution_price), holds[0].cost_basis]).toEqual([10, 500, 5000]);
    const r = resolve(secs.s_cit, symbols);
    expect([r.kind, r.manual, r.symbol]).toEqual(["security", false, "VOO"]);
    const [a] = mapInvestmentTransactions(rows.slice(0, 1), secs, symbols).activities;
    expect([a.symbol, n(a.quantity), n(a.unitPrice)]).toEqual(["VOO", 2, 500]);
  });

  test("rebase from reported price", () => {
    const yahoo: Record<string, string> = { "2026-11-06": "600.00", "2026-11-09": "610.00" };
    const closes = { exact: (_s: string, day: string) => (yahoo[day] ? D(yahoo[day]) : null) };
    const symbols = { s_cit: { name: "Trust", symbol: null, track: entry("VOO", "2026-11-06", D("100.00"), D("600.00")) } };
    const items = (price: number, day: string | null) => [{ holdings: { holdings: [{ security_id: "s_cit", account_id: "a1",
      institution_price: price, institution_price_as_of: day }] } }];
    expect(rebases(items(100.0, "2026-11-06"), symbols, closes)).toEqual([]); // not newer than the stored ratio
    expect(rebases(items(101.0, null), symbols, closes)).toEqual([]); // no as-of date: never guess the day
    const [rb] = rebases(items(102.0, "2026-11-09"), symbols, closes);
    expect([n(rb.close), rb.next!.ratio, rb.safe]).toEqual([610, 0.1672131148, true]);
    expect(rebases(items(130, "2026-11-09"), symbols, closes)[0].safe).toBe(false); // over 5%: waits for the user
    const [none] = rebases(items(102.0, "2026-11-10"), symbols, closes);
    expect([none.close, none.next, none.safe]).toEqual([null, null, false]); // no same-day close yet
  });
});

describe("prices and to-do", () => {
  test("closes cache and last trading day", async () => {
    const { Closes } = await import("../../src/importer");
    const calls: string[] = [];
    const c = new Closes({}, async (sym) => { calls.push(sym); return { "2024-11-08": "100.5" }; }, "2026-11-07");
    await c.load([["GOOG", "2024-11-10"]]);
    expect(n(c.close("GOOG", "2024-11-10"))).toBe(100.5); // Sunday: Friday's close
    await c.load([["GOOG", "2024-11-08"]]);
    expect(calls).toEqual(["GOOG"]);
  });

  test("to-do report groups reviews and warns on price failures", async () => {
    const { Closes, todoReport, review } = await import("../../src/importer");
    const c = new Closes({}, async () => { throw new Error("offline"); }, "2026-11-07");
    await c.load([["GOOG", "2024-11-08"], ["GOOG", "2024-11-09"]]);
    expect(c.close("GOOG", "2024-11-08")).toBeNull();
    const reviews = [review("a1", "opening:a1:QQQ", "2024-11-07", "opening cost basis missing", "QQQ: priced at 1"),
      review("a1", "reconcile:X", "", "holdings mismatch", "X: Plaid 0, computed 1"),
      review("a1", "t9", "2025-01-02", "corporate action: merger", "merger")];
    const lines = todoReport(reviews, { a1: "AB · Broker" }, c.warnings());
    expect(lines[0].startsWith("Warning: Yahoo Finance price lookup for GOOG failed: could not reach it")).toBe(true);
    expect(lines[1]).toBe("To do in Wealthfolio: 3 items");
    expect(lines).toContain("Opening cost basis (1)");
    expect(lines).toContain("Positions that do not add up (1)");
    expect(lines).toContain("  - AB · Broker: 2025-01-02 corporate action: merger: merger");
    expect(todoReport([], {})).toEqual([]);
  });
});

describe("todoGroups", () => {
  test("reads the report back as groups", async () => {
    const { todoGroups, todoReport } = await import("../../src/importer");
    const lines = [...todoReport([{ accountId: "A", plaidId: "p", date: "2026-01-02", reason: "unmapped security", detail: "Fund X" }] as never, { A: "AB · Bank" }, ["Yahoo down"]),
      "\nKept as they are in Wealthfolio (1)", "  Edit them in Wealthfolio.", "  - AB · Bank: 2026-01-01 BUY removed at Plaid"];
    const g = todoGroups(lines);
    expect(g.map((x) => [x.heading, x.count, x.items.length])).toEqual([["Price lookup", 0, 0], ["Securities without a ticker", 1, 1], ["Kept as they are in Wealthfolio", 1, 1]]);
    expect(g[1].text).toMatch(/Sync → Securities/);
  });
});
