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

export function openingActivities(accountId: string, startDate: string, holdings: HoldingMap, currentCash: Dec | null,
  acts: Activity[], currency = "USD", priceOn?: PriceOn): [Activity[], Review[]] {
  const deltas = new Map<string, Dec>();
  let cashDelta = ZERO;
  for (const a of acts) {
    if (a.accountId !== accountId) continue;
    if (a.symbol) add(deltas, a.symbol, a.positionDelta());
    cashDelta = cashDelta.plus(a.cashDelta());
  }
  const out: Activity[] = [];
  const reviews: Review[] = [];
  const symbols = new Set<string>(deltas.keys());
  for (const k of holdings.keys()) {
    const [acct, s] = splitKey(k);
    if (acct === accountId) symbols.add(s);
  }
  for (const sym of [...symbols].sort()) {
    const h = holdings.get(hkey(accountId, sym));
    const current = h ? h.quantity : ZERO;
    const delta = deltas.get(sym) ?? ZERO;
    const opening = current.minus(delta);
    if (opening.abs().lt(EPS)) continue;
    const pid = `opening:${accountId}:${sym}`;
    if (opening.lt(0)) {
      reviews.push(review(accountId, pid, startDate, "negative opening position", `${sym}: holdings ${String(current)}, pulled net ${String(delta)}`));
      continue;
    }
    let price: Dec | null = null;
    const grown = splitFactor(opening, acts.filter((a) => a.accountId === accountId && a.symbol === sym));
    if (h && h.cost_basis != null && nz(current)) {
      price = D(h.cost_basis).abs().div(current.times(h.multiplier)).times(grown);
    } else {
      const sid = h ? h.security_id : acts.find((a) => a.symbol === sym)?.securityId ?? null;
      let source: string | null;
      [price, source] = acquisitionPrice(sym, sid, startDate, acts, priceOn, grown);
      if (price === null && h) [price, source] = [dec(h.institution_price)?.times(grown) ?? null, "today's price; fix in Wealthfolio"];
      reviews.push(review(accountId, pid, startDate, "opening cost basis missing",
        `${sym}: priced at ${String(price)} (${source || "no price found; set it in Wealthfolio"})`));
    }
    out.push(new Activity({
      accountId, plaidId: pid, date: startDate, activityType: "TRANSFER_IN", currency, symbol: sym,
      instrumentType: h ? h.instrumentType : null, securityId: h ? h.security_id : null,
      symbolName: h ? h.name : null, quoteManual: Boolean(h?.manual),
      quantity: opening, unitPrice: nz(price) ? price : ZERO, description: "Opening position",
    }));
  }
  if (currentCash !== null) {
    const openingCash = currentCash.minus(cashDelta);
    if (openingCash.abs().gte("0.01")) {
      out.push(new Activity({
        accountId, plaidId: `opening:${accountId}:cash`, date: startDate,
        activityType: openingCash.gt(0) ? "TRANSFER_IN" : "TRANSFER_OUT", currency,
        amount: openingCash.abs().round(2, 2), description: "Opening cash balance",
      }));
    }
  }
  return [out, reviews];
}

function acquisitionPrice(sym: string, sid: string | null, day: string, acts: Activity[], priceOn?: PriceOn, grown: Dec = D(1)):
  [Dec | null, string | null] {
  const p = priceOn && sid ? priceOn(sid, day) : null;
  if (nz(p)) return [p.times(grown), `market price on ${day}${grown.eq(1) ? "" : `, times ${String(grown)} for later splits`}`];
  const priced = acts.filter((a) => a.symbol === sym && nz(a.unitPrice)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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

export function reconcile(accountIds: Set<string>, computed: Map<string, Dec>, holdings: Map<string, Pick<Position, "quantity">>, fresh: Activity[] = [],
  tol: Dec = D("0.001")): Review[] {
  const keys = new Set<string>();
  for (const k of [...computed.keys(), ...holdings.keys()]) if (accountIds.has(splitKey(k)[0])) keys.add(k);
  const reviews: Review[] = [];
  for (const k of [...keys].sort(tupleOrder)) {
    const [acct, sym] = splitKey(k);
    const have = holdings.get(k)?.quantity ?? ZERO;
    const calc = computed.get(k) ?? ZERO;
    if (have.minus(calc).abs().gt(tol)) {
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
