import { D, type Dec, dec, EPS, nz, ZERO } from "./dec";
import { Activity, POSITION_SIGN, type Review, review } from "./models";
import type { PlaidHolding, PlaidSecurity } from "./plaidTypes";
import { resolve, type SecurityOverride } from "./securities";

export type PriceOn = (securityId: string, day: string) => Dec | null;
export interface Position {
  security_id: string; quantity: Dec; cost_basis: number | null | undefined; institution_price: PlaidHolding["institution_price"];
  symbol: string; instrumentType: string | null; manual: boolean; name: string | null; multiplier: Dec;
}
export type HoldingMap = Map<string, Position>;
export const hkey = (accountId: string, symbol: string) => `${accountId}|${symbol}`;
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)];
};

const order = (a: Activity): [string, number] => [a.date, a.plaidId.startsWith("opening:") ? 0 : 1];
const byOrder = (x: Activity, y: Activity) => {
  const [a, b] = [order(x), order(y)];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1];
};

const add = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? ZERO).plus(v));

export function holdingsBySymbol(holdings: PlaidHolding[], securities: Record<string, PlaidSecurity>, overrides: Record<string, SecurityOverride>):
  [HoldingMap, Map<string, Dec>, PlaidHolding[]] {
  const bySym: HoldingMap = new Map();
  const cash = new Map<string, Dec>();
  const unmapped: PlaidHolding[] = [];
  for (const h of holdings) {
    const sec = securities[h.security_id];
    const r = resolve(sec, overrides, h.iso_currency_code || "USD");
    if (r.kind === "cash") {
      add(cash, h.account_id, dec(h.institution_value) ?? ZERO);
    } else if (r.kind === "security" && r.symbol !== null) {
      const qty = (dec(h.quantity) ?? ZERO).div(r.multiplier);
      bySym.set(hkey(h.account_id, r.symbol), {
        security_id: h.security_id, quantity: qty, cost_basis: h.cost_basis, institution_price: h.institution_price,
        symbol: r.symbol, instrumentType: r.instrumentType, manual: r.manual, name: sec?.name ?? null, multiplier: r.multiplier,
      });
    } else if (r.kind === "unmapped") {
      unmapped.push(h);
    }
  }
  return [bySym, cash, unmapped];
}

function splitFactor(opening: Dec, acts: Activity[]): Dec {
  let pos = opening, factor = D(1);
  for (const a of [...acts].sort(byOrder)) {
    if (a.activityType === "SPLIT" && pos.gt(0)) factor = factor.times(pos.plus(a.splitDelta ?? ZERO).div(pos));
    pos = pos.plus(a.positionDelta());
  }
  return factor.round(6, 2);
}

export interface OpeningAt {
  accountId: string;
  date: string;
  cash: Dec | null;
  currency?: string;
}

interface OpeningContext {
  at: OpeningAt;
  holdings: HoldingMap;
  acts: Activity[];
  priceOn: PriceOn | undefined;
  currency: string;
}

export function openingActivities(at: OpeningAt, holdings: HoldingMap, acts: Activity[], priceOn?: PriceOn): [Activity[], Review[]] {
  const ctx: OpeningContext = { at, holdings, acts, priceOn, currency: at.currency ?? "USD" };
  const own = acts.filter((a) => a.accountId === at.accountId);
  const deltas = new Map<string, Dec>();
  for (const a of own) if (a.symbol) add(deltas, a.symbol, a.positionDelta());
  const cashDelta = own.reduce((sum, a) => sum.plus(a.cashDelta()), ZERO);

  const out: Activity[] = [];
  const reviews: Review[] = [];
  for (const sym of openingSymbols(at.accountId, holdings, deltas)) {
    const { activity, note } = openingPosition(ctx, sym, deltas.get(sym) ?? ZERO);
    if (activity) out.push(activity);
    if (note) reviews.push(note);
  }
  const cash = openingCash(ctx, cashDelta);
  if (cash) out.push(cash);
  return [out, reviews];
}

function openingSymbols(accountId: string, holdings: HoldingMap, deltas: Map<string, Dec>): string[] {
  const symbols = new Set<string>(deltas.keys());
  for (const k of holdings.keys()) {
    const [acct, s] = splitKey(k);
    if (acct === accountId) symbols.add(s);
  }
  return [...symbols].sort();
}

function openingPosition(ctx: OpeningContext, sym: string, delta: Dec): { activity?: Activity; note?: Review } {
  const { accountId, date } = ctx.at;
  const h = ctx.holdings.get(hkey(accountId, sym));
  const current = h ? h.quantity : ZERO;
  const opening = current.minus(delta);
  if (opening.abs().lt(EPS)) return {};
  const pid = `opening:${accountId}:${sym}`;
  if (opening.lt(0)) {
    return { note: review(accountId, pid, date, "negative opening position", `${sym}: holdings ${String(current)}, pulled net ${String(delta)}`) };
  }
  const grown = splitFactor(opening, ctx.acts.filter((a) => a.accountId === accountId && a.symbol === sym));
  const { price, note } = openingPrice(ctx, { sym, pid, holding: h, current }, grown);
  const activity = new Activity({
    accountId, plaidId: pid, date, activityType: "TRANSFER_IN", currency: ctx.currency, symbol: sym,
    instrumentType: h ? h.instrumentType : null, securityId: h ? h.security_id : null,
    symbolName: h ? h.name : null, quoteManual: Boolean(h?.manual),
    quantity: opening, unitPrice: nz(price) ? price : ZERO, description: "Opening position",
  });
  return note ? { activity, note } : { activity };
}

interface OpeningHolding {
  sym: string;
  pid: string;
  holding: Position | undefined;
  current: Dec;
}

function openingPrice(ctx: OpeningContext, { sym, pid, holding: h, current }: OpeningHolding, grown: Dec): { price: Dec | null; note?: Review } {
  if (h && h.cost_basis != null && nz(current)) {
    return { price: D(h.cost_basis).abs().div(current.times(h.multiplier)).times(grown) };
  }
  const sid = h ? h.security_id : ctx.acts.find((a) => a.symbol === sym)?.securityId ?? null;
  let [price, source] = acquisitionPrice(sym, sid, ctx, grown);
  if (price === null && h) [price, source] = [dec(h.institution_price)?.times(grown) ?? null, "today's price; fix in Wealthfolio"];
  const note = review(ctx.at.accountId, pid, ctx.at.date, "opening cost basis missing",
    `${sym}: priced at ${String(price)} (${source || "no price found; set it in Wealthfolio"})`);
  return { price, note };
}

function openingCash(ctx: OpeningContext, cashDelta: Dec): Activity | null {
  const { accountId, date, cash } = ctx.at;
  if (cash === null) return null;
  const openingBalance = cash.minus(cashDelta);
  if (!openingBalance.abs().gte("0.01")) return null;
  return new Activity({
    accountId, plaidId: `opening:${accountId}:cash`, date,
    activityType: openingBalance.gt(0) ? "TRANSFER_IN" : "TRANSFER_OUT", currency: ctx.currency,
    amount: openingBalance.abs().round(2, 2), description: "Opening cash balance",
  });
}

function acquisitionPrice(sym: string, sid: string | null, ctx: OpeningContext, grown: Dec): [Dec | null, string | null] {
  const day = ctx.at.date;
  const p = ctx.priceOn && sid ? ctx.priceOn(sid, day) : null;
  if (nz(p)) return [p.times(grown), `market price on ${day}${grown.eq(1) ? "" : `, times ${String(grown)} for later splits`}`];
  const priced = ctx.acts.filter((a) => a.symbol === sym && nz(a.unitPrice)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = priced[0];
  if (first) return [first.unitPrice, `Plaid price on ${first.date}, the earliest it shows`];
  return [null, null];
}

export function resolveSplits(acts: Activity[], prior: Map<string, Dec> = new Map()): Review[] {
  const pos = new Map(prior);
  const reviews: Review[] = [];
  for (const a of [...acts].sort(byOrder)) {
    const key = hkey(a.accountId, a.symbol ?? "");
    if (a.activityType === "SPLIT") {
      const before = pos.get(key) ?? ZERO;
      if (before.lte(0)) {
        reviews.push(review(a.accountId, a.plaidId, a.date, "split with unknown position", `${a.symbol}: delta ${String(a.splitDelta)}`));
        a.amount = null;
      } else {
        a.amount = before.plus(a.splitDelta ?? ZERO).div(before).round(6, 2);
      }
    }
    if (a.symbol) add(pos, key, a.positionDelta());
  }
  return reviews;
}

export function fixSplitPrices(acts: Activity[], all: Activity[], close: (sym: string | null, day: string) => Dec | null): Review[] {
  const splits = new Map<string, [string, Dec][]>();
  for (const a of all) {
    if (a.activityType !== "SPLIT" || !a.symbol || !nz(a.amount)) continue;
    const k = hkey(a.accountId, a.symbol);
    splits.set(k, [...(splits.get(k) ?? []), [a.date, a.amount]]);
  }
  const out: Review[] = [];
  for (const a of acts) {
    const price = a.unitPrice;
    if (!a.symbol || a.marketPrice || a.plaidId.startsWith("opening:") || !POSITION_SIGN[a.activityType] || !nz(price)) continue;
    const later = (splits.get(hkey(a.accountId, a.symbol)) ?? []).filter(([day]) => day > a.date);
    const factor = later.reduce((f, [, r]) => f.times(r), D(1));
    if (factor.gt("0.67") && factor.lt("1.5")) continue;
    const y = close(a.symbol, a.date);
    if (!nz(y)) continue;
    const near = (x: Dec, target: Dec) => x.div(target).minus(1).abs().lte("0.3");
    if (near(price, y) && !near(price, y.times(factor))) {
      a.unitPrice = price.times(factor);
      out.push(review(a.accountId, a.plaidId, a.date, "price adjusted for a later split",
        `${a.symbol}: Plaid price ${String(price)} matches Yahoo's split-adjusted close ${String(y)}; used ${String(a.unitPrice)} for ${String(a.quantity)} sh`));
    }
  }
  return out;
}

export function positions(acts: Activity[]): Map<string, Dec> {
  const pos = new Map<string, Dec>();
  for (const a of acts) if (a.symbol) add(pos, hkey(a.accountId, a.symbol), a.positionDelta());
  return pos;
}

const RECONCILE_TOLERANCE = D("0.001");

export function reconcile(accountIds: Set<string>, computed: Map<string, Dec>, holdings: Map<string, Pick<Position, "quantity">>, fresh: Activity[] = []): Review[] {
  const keys = new Set<string>();
  for (const k of [...computed.keys(), ...holdings.keys()]) if (accountIds.has(splitKey(k)[0])) keys.add(k);
  const reviews: Review[] = [];
  for (const k of [...keys].sort(tupleOrder)) {
    const [acct, sym] = splitKey(k);
    const have = holdings.get(k)?.quantity ?? ZERO;
    const calc = computed.get(k) ?? ZERO;
    if (have.minus(calc).abs().gt(RECONCILE_TOLERANCE)) {
      const added = fresh.filter((a) => a.symbol && hkey(a.accountId, a.symbol) === k && !a.positionDelta().eq(0))
        .map((a) => `${a.date} ${a.activityType} ${String(a.positionDelta())}`);
      const why = added.length ? `; this pull adds ${added.join(", ")}` : "";
      reviews.push(review(acct, `reconcile:${sym}`, "", "holdings mismatch", `${sym}: Plaid ${String(have)}, computed ${String(calc)}, diff ${String(have.minus(calc))}${why}`));
    }
  }
  return reviews;
}

function tupleOrder(x: string, y: string): number {
  const [a1, s1] = splitKey(x), [a2, s2] = splitKey(y);
  return a1 !== a2 ? (a1 < a2 ? -1 : 1) : s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
}
