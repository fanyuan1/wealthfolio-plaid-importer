// Plaid /investments/transactions/get rows -> Wealthfolio activities.
import { D, type Dec, dec, nz, ZERO } from "./dec";
import { Activity, type ActivityInit, mapResult, type MapResult, type Review, review, type Row } from "./models";
import { resolve } from "./securities";
import { daysBetween } from "./transfers";

const DIVIDEND_SUBTYPES: Record<string, string | null> = {
  dividend: null, "qualified dividend": "QUALIFIED", "non-qualified dividend": "ORDINARY",
  "long-term capital gain": null, "short-term capital gain": null,
};
const INTEREST_SUBTYPES = new Set(["interest", "interest receivable"]);
const TAX_SUBTYPES = new Set(["tax", "tax withheld", "non-resident tax"]);
const FEE_SUBTYPES: Record<string, string | null> = {
  "account fee": null, "legal fee": null, "management fee": "MANAGEMENT_FEE",
  "margin expense": "INTEREST_CHARGE", "miscellaneous fee": null, "transfer fee": null, "trust fee": null,
};
const SKIP_SUBTYPES = new Set(["pending credit", "pending debit"]);
const REVIEW_SUBTYPES = new Set(["merger", "spin off", "exercise", "assignment", "adjustment", "return of principal"]);
const TRANSFER_SUBTYPES = new Set(["transfer", "send", "request", "trade"]);
const PARTIAL_FILL = "partially filled";
const REINVEST_MATCH_DAYS = 7;

const currencyOf = (t: Row, def: string): string => t.iso_currency_code || t.unofficial_currency_code || def;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** stockPlan: account ids of employee stock plans (Plaid subtype "stock plan"). */
export function mapInvestmentTransactions(txns: Row[], securities: Record<string, Row>, overrides: Record<string, Row>,
  defaultCurrency = "USD", stockPlan: Set<string> = new Set()): MapResult {
  const r = mapResult();
  for (const t of txns) {
    if (t.type === "cancel") {
      r.cancelledIds.add(t.investment_transaction_id);
      if (t.cancel_transaction_id) r.cancelledIds.add(t.cancel_transaction_id);
    }
  }
  const memos = new Set([...reinvestMemos(txns), ...reversals(txns)]);
  for (const t of txns) {
    const tid = t.investment_transaction_id;
    if (r.cancelledIds.has(tid) || memos.has(tid)) continue;
    const [act, rev] = mapOne(t, securities, overrides, defaultCurrency, r, stockPlan.has(t.account_id));
    if (rev) r.reviews.push(rev);
    if (act) r.activities.push(act);
  }
  return r;
}

/** Merrill reports a dividend reinvestment twice: a memo with quantity 0, then the fill with shares and
 * price, sometimes days later. The memo is dropped when its fill is present. */
function reinvestMemos(txns: Row[]): Set<string> {
  const reinv = txns.filter((t) => t.type === "buy" && String(t.subtype ?? "").toLowerCase() === "dividend reinvestment");
  const fills = reinv.filter((t) => nz(dec(t.quantity)));
  const used = new Set<string>();
  const memos = new Set<string>();
  for (const m of reinv.filter((t) => !nz(dec(t.quantity)) && !nz(dec(t.price)))) {
    const f = fills.find((f) => !used.has(f.investment_transaction_id) && f.account_id === m.account_id
      && f.security_id === m.security_id && dec(f.amount)!.eq(dec(m.amount)!)
      && daysBetween(String(f.date), String(m.date)) <= REINVEST_MATCH_DAYS);
    if (f) {
      used.add(f.investment_transaction_id);
      memos.add(m.investment_transaction_id);
    }
  }
  return memos;
}

/** Same account, security and day, one row out and one back in with nothing net: a 401(k) "Source to
 * Source/Fund to Fund" move, or Merrill reposting a row. Both are dropped. */
function reversals(txns: Row[]): Set<string> {
  const used = new Set<string>();
  const rows = txns.filter((t) => t.security_id && t.type !== "buy" && t.type !== "sell" && nz(dec(t.quantity)));
  for (const a of rows) {
    if (used.has(a.investment_transaction_id) || dec(a.quantity)!.gte(0)) continue;
    const b = rows.find((b) => !used.has(b.investment_transaction_id) && b !== a
      && b.account_id === a.account_id && b.security_id === a.security_id && String(b.date) === String(a.date)
      && dec(b.quantity)!.eq(dec(a.quantity)!.neg())
      && (dec(b.amount) ?? ZERO).eq((dec(a.amount) ?? ZERO).neg()));
    if (b) used.add(a.investment_transaction_id).add(b.investment_transaction_id);
  }
  return used;
}

type Out = [Activity | null, Review | null];

function mapOne(t: Row, securities: Record<string, Row>, overrides: Record<string, Row>, defaultCurrency: string,
  res: MapResult, stockPlan = false): Out {
  const tid = t.investment_transaction_id, acct = t.account_id, date = String(t.date);
  const ttype = t.type, sub = String(t.subtype ?? "").toLowerCase();
  const cur = currencyOf(t, defaultCurrency);
  const sec = t.security_id ? securities[t.security_id] ?? null : null;
  const r = resolve(sec, overrides, cur);
  const amount = dec(t.amount) ?? ZERO;
  let qty = (dec(t.quantity) ?? ZERO).abs();
  let price = (dec(t.price) ?? ZERO).abs();
  const feeAbs = (dec(t.fees) ?? ZERO).abs();
  const fee = nz(feeAbs) ? feeAbs : null;
  const name: string = t.name || "";
  const rawQty = dec(t.quantity);

  const rev = (reason: string): Out =>
    [null, review(acct, tid, date, reason, `${ttype}/${sub}: ${name} amount=${amount} qty=${qty}`)];
  const act = (atype: string, kw: Partial<ActivityInit> = {}): Out =>
    [new Activity({ accountId: acct, plaidId: tid, date, activityType: atype, currency: cur, description: name, ...kw }), null];

  if (r.kind === "exclude" || SKIP_SUBTYPES.has(sub)) return [null, null];
  if (r.kind === "unmapped") {
    res.unmappedSecurities.set(sec!.security_id, sec!.name || name);
    return rev("unmapped security");
  }
  if (REVIEW_SUBTYPES.has(sub)) return rev(`corporate action: ${sub}`);

  const isSec = r.kind === "security";
  const isOption = isSec && r.instrumentType === "OPTION";
  const mult: Dec = isSec ? r.multiplier : D(1);
  if (price.eq(0) && nz(qty)) price = amount.abs().div(qty); // per unit Plaid counts (per share for options)
  qty = qty.div(mult); // options: single options -> contracts
  const secKw: Partial<ActivityInit> = isSec ? {
    symbol: r.symbol, instrumentType: r.instrumentType, securityId: sec!.security_id,
    symbolName: sec!.name ?? null, quoteManual: r.manual,
  } : {};

  if (sub === "split") {
    if (!isSec) return rev("split without security");
    return act("SPLIT", { splitDelta: (rawQty ?? ZERO).div(mult), ...secKw });
  }
  if (sub === "expire") return isSec ? act("ADJUSTMENT", { subtype: "OPTION_EXPIRY", quantity: qty, ...secKw }) : rev("expire");

  if (ttype === "buy" || ttype === "sell") {
    if (!isSec) return [null, null]; // cash sweep trade: cash never left the account
    if (qty.eq(0)) return rev("trade with zero quantity");
    if (name.toLowerCase().includes(PARTIAL_FILL) && nz(price)) {
      const filled = amount.abs().div(price);
      // Plaid can report a partly filled order at its full size; the amount is what filled.
      if (filled.gt(0) && filled.lt(qty)) qty = filled;
    }
    if (sub === "contribution") {
      // 401(k) plan contribution: shares arrive from payroll; no cash moves in the account.
      return act("TRANSFER_IN", { quantity: qty, unitPrice: price, ...secKw });
    }
    const atype = ttype === "buy" ? "BUY" : "SELL";
    // Wealthfolio marks trade intent with POSITION_OPEN / POSITION_CLOSE (shorts, options).
    let subtype: string | null = ({ "buy to cover": "POSITION_CLOSE", "sell short": "POSITION_OPEN" } as Record<string, string>)[sub] ?? null;
    if (isOption && subtype === null) subtype = ttype === "buy" ? "POSITION_OPEN" : "POSITION_CLOSE";
    return act(atype, { quantity: qty, unitPrice: price, fee, subtype, ...secKw });
  }

  if (has(DIVIDEND_SUBTYPES, sub) || (sub === "dividend reinvestment" && ttype === "cash")) {
    if (!isSec) return act("INTEREST", { amount: amount.abs() }); // money-market dividends are effectively interest
    return act("DIVIDEND", { amount: amount.abs(), subtype: DIVIDEND_SUBTYPES[sub] ?? null, ...secKw });
  }
  if (INTEREST_SUBTYPES.has(sub)) return act("INTEREST", { amount: amount.abs() });
  if (TAX_SUBTYPES.has(sub)) return act("TAX", { amount: amount.abs(), subtype: sub === "tax withheld" ? "WITHHOLDING" : null });
  if (ttype === "fee" || has(FEE_SUBTYPES, sub)) {
    if (amount.lt(0)) return act("CREDIT", { amount: amount.abs(), subtype: "REFUND" });
    return act("FEE", { amount: amount.abs(), subtype: FEE_SUBTYPES[sub] ?? null });
  }
  const noPrice = !nz(dec(t.price));
  if (isSec && ttype === "cash" && (sub === "deposit" || sub === "distribution") && nz(qty) && noPrice
    && name.toUpperCase().includes("DISTRIBUTION")) {
    // Fidelity sends a stock split as a cash "DISTRIBUTION" of the new shares, priced at 0 and valued
    // at market in amount. No money moves.
    return act("SPLIT", { splitDelta: (rawQty ?? ZERO).div(mult), ...secKw });
  }
  if (isSec && amount.eq(0) && !stockPlan && ttype === "cash" && noPrice && rawQty !== null && rawQty.gt(0)) {
    // Merrill sends a stock split as a cash row of the new shares, priced at 0. Shares with no cash
    // outside a stock plan are a split, not a vest.
    return act("SPLIT", { splitDelta: rawQty.div(mult), ...secKw });
  }
  if (isSec && amount.eq(0) && nz(qty) && ["deposit", "contribution", "withdrawal", "distribution"].includes(sub)) {
    // Shares with no cash, e.g. Schwab "RESTRICTED STOCK DEPOSIT" (an RSU vest). Plaid sends no vest price.
    const q = rawQty!.div(mult);
    return act(q.gt(0) ? "TRANSFER_IN" : "TRANSFER_OUT", { quantity: q.abs(), unitPrice: ZERO, marketPrice: true, ...secKw });
  }
  if (sub === "deposit" || sub === "contribution") return act("DEPOSIT", { amount: amount.abs(), transferHint: true });
  if (sub === "withdrawal" || sub === "distribution") return act("WITHDRAWAL", { amount: amount.abs(), transferHint: true });
  if (ttype === "transfer" || TRANSFER_SUBTYPES.has(sub)) {
    if (isSec) {
      const q = (rawQty ?? ZERO).div(mult);
      if (q.eq(0) && amount.eq(0)) return rev("security transfer with zero quantity");
      if (!q.eq(0)) {
        // Stock plans only receive shares as vests; Plaid sends their journals out with a positive quantity.
        const out = q.lt(0) || (stockPlan && amount.eq(0));
        // No price (Merrill journals, broker-to-broker moves): the close that day, so cost basis is known.
        return act(out ? "TRANSFER_OUT" : "TRANSFER_IN", { quantity: q.abs(), unitPrice: price, marketPrice: !nz(price), ...secKw });
      }
      // A cash journal tagged with the security, e.g. Schwab "Journal To Account … JRNLFUND".
    }
    if (amount.eq(0)) return [null, null];
    // Plaid: negative amount = cash into the account.
    return act(amount.lt(0) ? "DEPOSIT" : "WITHDRAWAL", { amount: amount.abs(), transferHint: true });
  }
  return rev(`unknown type ${ttype}/${sub}`);
}
