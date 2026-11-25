import { D, type Dec, dec, nz, ZERO } from "./dec";
import { Activity, type ActivityInit, mapResult, type MapResult, type Review, review } from "./models";
import type { PlaidInvestmentTransaction, PlaidSecurity } from "./plaidTypes";
import { resolve, type SecurityOverride } from "./securities";
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

const currencyOf = (t: PlaidInvestmentTransaction, def: string): string => t.iso_currency_code || t.unofficial_currency_code || def;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export interface InvestmentMapOptions {
  currency?: string;
  stockPlan?: Set<string>;
}

export function mapInvestmentTransactions(txns: PlaidInvestmentTransaction[], securities: Record<string, PlaidSecurity>,
  overrides: Record<string, SecurityOverride>, opts: InvestmentMapOptions = {}): MapResult {
  const defaultCurrency = opts.currency ?? "USD";
  const stockPlan = opts.stockPlan ?? new Set<string>();
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
    const [act, rev] = mapOne(t, { securities, overrides, defaultCurrency, stockPlan: stockPlan.has(t.account_id) }, r);
    if (rev) r.reviews.push(rev);
    if (act) r.activities.push(act);
  }
  return r;
}

function reinvestMemos(txns: PlaidInvestmentTransaction[]): Set<string> {
  const reinv = txns.filter((t) => t.type === "buy" && t.subtype.toLowerCase() === "dividend reinvestment");
  const fills = reinv.filter((t) => nz(dec(t.quantity)));
  const used = new Set<string>();
  const memos = new Set<string>();
  for (const m of reinv.filter((t) => !nz(dec(t.quantity)) && !nz(dec(t.price)))) {
    const f = fills.find((f) => !used.has(f.investment_transaction_id) && f.account_id === m.account_id
      && f.security_id === m.security_id && D(f.amount).eq(D(m.amount))
      && daysBetween(f.date, m.date) <= REINVEST_MATCH_DAYS);
    if (f) {
      used.add(f.investment_transaction_id);
      memos.add(m.investment_transaction_id);
    }
  }
  return memos;
}

function reversals(txns: PlaidInvestmentTransaction[]): Set<string> {
  const used = new Set<string>();
  const rows = txns.filter((t) => t.security_id && t.type !== "buy" && t.type !== "sell" && nz(dec(t.quantity)));
  for (const a of rows) {
    const qa = D(String(a.quantity));
    if (used.has(a.investment_transaction_id) || qa.gte(0)) continue;
    const b = rows.find((b) => !used.has(b.investment_transaction_id) && b !== a
      && b.account_id === a.account_id && b.security_id === a.security_id && b.date === a.date
      && D(String(b.quantity)).eq(qa.neg())
      && D(b.amount).eq(D(a.amount).neg()));
    if (b) used.add(a.investment_transaction_id).add(b.investment_transaction_id);
  }
  return used;
}

type Out = [Activity | null, Review | null];

interface MapContext {
  securities: Record<string, PlaidSecurity>;
  overrides: Record<string, SecurityOverride>;
  defaultCurrency: string;
  stockPlan: boolean;
}

interface Txn {
  t: PlaidInvestmentTransaction;
  ttype: string;
  sub: string;
  name: string;
  amount: Dec;
  qty: Dec;
  price: Dec;
  fee: Dec | null;
  rawQty: Dec | null;
  isSec: boolean;
  isOption: boolean;
  mult: Dec;
  secKw: Partial<ActivityInit>;
  stockPlan: boolean;
  rawAbs: Dec;
  rev: (reason: string, shownQty?: Dec) => Out;
  act: (atype: string, kw?: Partial<ActivityInit>) => Out;
}

type Handler = (x: Txn) => Out | undefined;

const SKIPPED: Out = [null, null];

function mapOne(t: PlaidInvestmentTransaction, ctx: MapContext, res: MapResult): Out {
  const sub = t.subtype.toLowerCase();
  const cur = currencyOf(t, ctx.defaultCurrency);
  const sec = t.security_id ? ctx.securities[t.security_id] ?? null : null;
  const r = resolve(sec, ctx.overrides, cur);
  if (r.kind === "exclude" || SKIP_SUBTYPES.has(sub)) return SKIPPED;
  const x = prepare(t, { sec, r, cur, stockPlan: ctx.stockPlan });
  if (r.kind === "unmapped" && sec) {
    res.unmappedSecurities.set(sec.security_id, sec.name || x.name);
    return x.rev("unmapped security", x.rawAbs);
  }
  if (REVIEW_SUBTYPES.has(sub)) return x.rev(`corporate action: ${sub}`, x.rawAbs);
  for (const handle of HANDLERS) {
    const out = handle(x);
    if (out) return out;
  }
  return x.rev(`unknown type ${x.ttype}/${sub}`);
}

interface Resolved {
  sec: PlaidSecurity | null;
  r: ReturnType<typeof resolve>;
  cur: string;
  stockPlan: boolean;
}

function prepare(t: PlaidInvestmentTransaction, { sec, r, cur, stockPlan }: Resolved): Txn {
  const tid = t.investment_transaction_id, acct = t.account_id, date = t.date;
  const ttype = t.type, sub = t.subtype.toLowerCase();
  const amount = dec(t.amount) ?? ZERO;
  const name = t.name || "";
  const isSec = r.kind === "security";
  const mult: Dec = isSec ? r.multiplier : D(1);
  const price = tradePrice(t, amount);
  const qty = filledQuantity(t, amount, price).div(mult);
  const feeAbs = (dec(t.fees) ?? ZERO).abs();
  const rawAbs = (dec(t.quantity) ?? ZERO).abs();
  return {
    t, ttype, sub, name, amount, qty, price, mult, isSec, stockPlan, rawAbs,
    fee: nz(feeAbs) ? feeAbs : null,
    rawQty: dec(t.quantity),
    isOption: isSec && r.instrumentType === "OPTION",
    secKw: isSec && sec ? {
      symbol: r.symbol, instrumentType: r.instrumentType, securityId: sec.security_id,
      symbolName: sec.name ?? null, quoteManual: r.manual,
    } : {},
    rev: (reason, shownQty = qty) => [null, review({ accountId: acct, plaidId: tid, date }, reason, `${ttype}/${sub}: ${name} amount=${String(amount)} qty=${String(shownQty)}`)],
    act: (atype, kw = {}) =>
      [new Activity({ accountId: acct, plaidId: tid, date, activityType: atype, currency: cur, description: name, ...kw }), null],
  };
}

function tradePrice(t: PlaidInvestmentTransaction, amount: Dec): Dec {
  const price = (dec(t.price) ?? ZERO).abs();
  const qty = (dec(t.quantity) ?? ZERO).abs();
  return price.eq(0) && nz(qty) ? amount.abs().div(qty) : price;
}

function filledQuantity(t: PlaidInvestmentTransaction, amount: Dec, price: Dec): Dec {
  const qty = (dec(t.quantity) ?? ZERO).abs();
  const isTrade = t.type === "buy" || t.type === "sell";
  if (!isTrade || !(t.name || "").toLowerCase().includes(PARTIAL_FILL) || !nz(price)) return qty;
  const filled = amount.abs().div(price);
  return filled.gt(0) && filled.lt(qty) ? filled : qty;
}

function corporateAction(x: Txn): Out | undefined {
  if (x.sub === "split") {
    if (!x.isSec) return x.rev("split without security");
    return x.act("SPLIT", { splitDelta: (x.rawQty ?? ZERO).div(x.mult), ...x.secKw });
  }
  if (x.sub === "expire") return x.isSec ? x.act("ADJUSTMENT", { subtype: "OPTION_EXPIRY", quantity: x.qty, ...x.secKw }) : x.rev("expire");
  return undefined;
}

const SHORT_SUBTYPES: Record<string, string> = { "buy to cover": "POSITION_CLOSE", "sell short": "POSITION_OPEN" };

function trade(x: Txn): Out | undefined {
  if (x.ttype !== "buy" && x.ttype !== "sell") return undefined;
  if (!x.isSec) return SKIPPED;
  if (x.qty.eq(0)) return x.rev("trade with zero quantity");
  if (x.sub === "contribution") return x.act("TRANSFER_IN", { quantity: x.qty, unitPrice: x.price, isExternal: true, ...x.secKw });
  const atype = x.ttype === "buy" ? "BUY" : "SELL";
  let subtype: string | null = SHORT_SUBTYPES[x.sub] ?? null;
  if (x.isOption && subtype === null) subtype = x.ttype === "buy" ? "POSITION_OPEN" : "POSITION_CLOSE";
  return x.act(atype, { quantity: x.qty, unitPrice: x.price, fee: x.fee, subtype, ...x.secKw });
}

function income(x: Txn): Out | undefined {
  const { sub, amount } = x;
  if (has(DIVIDEND_SUBTYPES, sub) || (sub === "dividend reinvestment" && x.ttype === "cash")) {
    if (!x.isSec) return x.act("INTEREST", { amount: amount.abs() });
    return x.act("DIVIDEND", { amount: amount.abs(), subtype: DIVIDEND_SUBTYPES[sub] ?? null, ...x.secKw });
  }
  if (INTEREST_SUBTYPES.has(sub)) return x.act("INTEREST", { amount: amount.abs() });
  if (TAX_SUBTYPES.has(sub)) return x.act("TAX", { amount: amount.abs(), subtype: sub === "tax withheld" ? "WITHHOLDING" : null });
  if (x.ttype === "fee" || has(FEE_SUBTYPES, sub)) {
    if (amount.lt(0)) return x.act("CREDIT", { amount: amount.abs(), subtype: "REFUND" });
    return x.act("FEE", { amount: amount.abs(), subtype: FEE_SUBTYPES[sub] ?? null });
  }
  return undefined;
}

const SHARE_MOVE_SUBTYPES = new Set(["deposit", "contribution", "withdrawal", "distribution"]);

function shareMovement(x: Txn): Out | undefined {
  if (!x.isSec) return undefined;
  const { sub, amount, rawQty } = x;
  const noPrice = !nz(dec(x.t.price));
  if (x.ttype === "cash" && (sub === "deposit" || sub === "distribution") && nz(x.qty) && noPrice
    && x.name.toUpperCase().includes("DISTRIBUTION")) {
    return x.act("SPLIT", { splitDelta: (rawQty ?? ZERO).div(x.mult), ...x.secKw });
  }
  if (amount.eq(0) && !x.stockPlan && x.ttype === "cash" && noPrice && rawQty !== null && rawQty.gt(0)) {
    return x.act("SPLIT", { splitDelta: rawQty.div(x.mult), ...x.secKw });
  }
  if (amount.eq(0) && nz(x.qty) && rawQty && SHARE_MOVE_SUBTYPES.has(sub)) {
    const q = rawQty.div(x.mult);
    return x.act(q.gt(0) ? "TRANSFER_IN" : "TRANSFER_OUT", { quantity: q.abs(), unitPrice: ZERO, marketPrice: true,
      isExternal: sub === "contribution" && q.gt(0), ...x.secKw });
  }
  return undefined;
}

function cashMovement(x: Txn): Out | undefined {
  if (x.sub === "deposit" || x.sub === "contribution") return x.act("DEPOSIT", { amount: x.amount.abs(), transferHint: true });
  if (x.sub === "withdrawal" || x.sub === "distribution") return x.act("WITHDRAWAL", { amount: x.amount.abs(), transferHint: true });
  return undefined;
}

function transfer(x: Txn): Out | undefined {
  if (x.ttype !== "transfer" && !TRANSFER_SUBTYPES.has(x.sub)) return undefined;
  const { amount } = x;
  if (x.isSec) {
    const q = (x.rawQty ?? ZERO).div(x.mult);
    if (q.eq(0) && amount.eq(0)) return x.rev("security transfer with zero quantity");
    if (!q.eq(0)) {
      const out = q.lt(0) || (x.stockPlan && amount.eq(0));
      return x.act(out ? "TRANSFER_OUT" : "TRANSFER_IN", { quantity: q.abs(), unitPrice: x.price, marketPrice: !nz(x.price), ...x.secKw });
    }
  }
  if (amount.eq(0)) return SKIPPED;
  return x.act(amount.lt(0) ? "DEPOSIT" : "WITHDRAWAL", { amount: amount.abs(), transferHint: true });
}

const HANDLERS: readonly Handler[] = [corporateAction, trade, income, shareMovement, cashMovement, transfer];
