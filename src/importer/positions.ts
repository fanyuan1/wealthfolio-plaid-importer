// Opening positions, split ratios and holdings reconciliation.
import { D, type Dec, dec, EPS, nz, ZERO } from "./dec";
import { Activity, POSITION_SIGN, type Review, review, type Row } from "./models";
import { resolve } from "./securities";

export type PriceOn = (securityId: string, day: string) => Dec | null;
/** Holdings keyed by `${accountId}|${symbol}`. */
export type HoldingMap = Map<string, Row>;
export const hkey = (accountId: string, symbol: string) => `${accountId}|${symbol}`;
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)];
};

// Opening rows first on their date, then by date.
const order = (a: Activity): [string, number] => [a.date, a.plaidId.startsWith("opening:") ? 0 : 1];
const byOrder = (x: Activity, y: Activity) => {
  const [a, b] = [order(x), order(y)];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1];
};

const add = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? ZERO).plus(v));

export function holdingsBySymbol(holdings: Row[], securities: Record<string, Row>, overrides: Record<string, Row>):
  [HoldingMap, Map<string, Dec>, Row[]] {
  const bySym: HoldingMap = new Map();
  const cash = new Map<string, Dec>();
  const unmapped: Row[] = [];
  for (const h of holdings) {
    const sec = securities[h.security_id];
    const r = resolve(sec, overrides, h.iso_currency_code || "USD");
    if (r.kind === "cash") {
      add(cash, h.account_id, dec(h.institution_value) ?? ZERO);
    } else if (r.kind === "security") {
      // Options: Plaid counts single options; Wealthfolio counts contracts.
      const qty = (dec(h.quantity) ?? ZERO).div(r.multiplier);
      bySym.set(hkey(h.account_id, r.symbol!), {
        ...h, quantity: qty, _symbol: r.symbol, _itype: r.instrumentType, _manual: r.manual,
        _name: sec?.name ?? null, _mult: r.multiplier,
      });
    } else if (r.kind === "unmapped") {
      unmapped.push(h);
    }
  }
  return [bySym, cash, unmapped];
}

/** How many shares one opening share has become by now: the product of the splits after the opening. Plaid's cost basis
 * and Yahoo's closes are in today's shares, but the opening quantity is in the shares held on the opening date. */
function splitFactor(opening: Dec, acts: Activity[]): Dec {
  let pos = opening, factor = D(1);
  for (const a of [...acts].sort(byOrder)) {
    if (a.activityType === "SPLIT" && pos.gt(0)) factor = factor.times(pos.plus(a.splitDelta ?? ZERO).div(pos));
    pos = pos.plus(a.positionDelta());
  }
  return factor.round(6, 2);
}

/** Back out positions held before startDate: current holdings minus every pulled change. Without Plaid cost
 * basis, price at the acquisition date: priceOn (a market close), else the earliest price Plaid shows for
 * the security, else today's price. */
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
    const current = h ? dec(h.quantity)! : ZERO;
    const delta = deltas.get(sym) ?? ZERO;
    const opening = current.minus(delta);
    if (opening.abs().lt(EPS)) continue;
    const pid = `opening:${accountId}:${sym}`;
    if (opening.lt(0)) {
      reviews.push(review(accountId, pid, startDate, "negative opening position", `${sym}: holdings ${current}, pulled net ${delta}`));
      continue;
    }
    let price: Dec | null = null;
    const grown = splitFactor(opening, acts.filter((a) => a.accountId === accountId && a.symbol === sym)); // 8 after an 8-for-1 split
    if (h && h.cost_basis != null && nz(current)) {
      price = dec(h.cost_basis)!.abs().div(current.times(h._mult ?? 1)).times(grown); // per opening share, as Wealthfolio prices
    } else {
      const sid = h ? h.security_id : acts.find((a) => a.symbol === sym)?.securityId ?? null;
      let source: string | null;
      [price, source] = acquisitionPrice(sym, sid, startDate, acts, priceOn, grown);
      if (price === null && h) [price, source] = [dec(h.institution_price)?.times(grown) ?? null, "today's price; fix in Wealthfolio"];
      reviews.push(review(accountId, pid, startDate, "opening cost basis missing",
        `${sym}: priced at ${price} (${source || "no price found; set it in Wealthfolio"})`));
    }
    out.push(new Activity({
      accountId, plaidId: pid, date: startDate, activityType: "TRANSFER_IN", currency, symbol: sym,
      instrumentType: h ? h._itype ?? null : null, securityId: h ? h.security_id ?? null : null,
      symbolName: h ? h._name ?? null : null, quoteManual: Boolean(h && h._manual),
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
  if (nz(p)) return [p!.times(grown), `market price on ${day}${grown.eq(1) ? "" : `, times ${grown} for later splits`}`];
  const priced = acts.filter((a) => a.symbol === sym && nz(a.unitPrice)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (priced.length) return [priced[0].unitPrice, `Plaid price on ${priced[0].date}, the earliest it shows`];
  return [null, null];
}

/** Turn SPLIT quantity deltas into Wealthfolio ratios (amount = new/old). prior: positions before the
 * earliest activity in acts. */
export function resolveSplits(acts: Activity[], prior: Map<string, Dec> = new Map()): Review[] {
  const pos = new Map(prior);
  const reviews: Review[] = [];
  for (const a of [...acts].sort(byOrder)) {
    const key = hkey(a.accountId, a.symbol ?? "");
    if (a.activityType === "SPLIT") {
      const before = pos.get(key) ?? ZERO;
      if (before.lte(0)) {
        reviews.push(review(a.accountId, a.plaidId, a.date, "split with unknown position", `${a.symbol}: delta ${a.splitDelta}`));
        a.amount = null;
      } else {
        a.amount = before.plus(a.splitDelta ?? ZERO).div(before).round(6, 2);
      }
    }
    if (a.symbol) add(pos, key, a.positionDelta());
  }
  return reviews;
}

/** Plaid sometimes prices a trade from before a split in today's shares (split-adjusted) while its quantity is in the
 * shares of the day. Wealthfolio applies the split to the quantity later, so the price must be the unadjusted one.
 * A price that matches Yahoo's split-adjusted close, not the close times the later splits, is multiplied by them.
 * acts: the activities to fix. all: the same plus the ledger's, for the splits. Returns one review line per change. */
export function fixSplitPrices(acts: Activity[], all: Activity[], close: (sym: string | null, day: string) => Dec | null): Review[] {
  const splits = new Map<string, [string, Dec][]>();
  for (const a of all) {
    if (a.activityType !== "SPLIT" || !a.symbol || !nz(a.amount)) continue;
    const k = hkey(a.accountId, a.symbol);
    splits.set(k, [...(splits.get(k) ?? []), [a.date, a.amount!]]);
  }
  const out: Review[] = [];
  for (const a of acts) {
    if (!a.symbol || a.marketPrice || a.plaidId.startsWith("opening:") || !POSITION_SIGN[a.activityType] || !nz(a.unitPrice)) continue;
    const later = (splits.get(hkey(a.accountId, a.symbol)) ?? []).filter(([day]) => day > a.date);
    const factor = later.reduce((f, [, r]) => f.times(r), D(1));
    if (factor.gt("0.67") && factor.lt("1.5")) continue; // no split worth checking
    const y = close(a.symbol, a.date);
    if (!nz(y)) continue;
    const price = a.unitPrice!;
    const near = (x: Dec, target: Dec) => x.div(target).minus(1).abs().lte("0.3");
    if (near(price, y!) && !near(price, y!.times(factor))) {
      a.unitPrice = price.times(factor);
      out.push(review(a.accountId, a.plaidId, a.date, "price adjusted for a later split",
        `${a.symbol}: Plaid price ${price} matches Yahoo's split-adjusted close ${y}; used ${a.unitPrice} for ${a.quantity} sh`));
    }
  }
  return out;
}

export function positions(acts: Activity[]): Map<string, Dec> {
  const pos = new Map<string, Dec>();
  for (const a of acts) if (a.symbol) add(pos, hkey(a.accountId, a.symbol), a.positionDelta());
  return pos;
}

export function reconcile(accountIds: Set<string>, computed: Map<string, Dec>, holdings: HoldingMap, tol: Dec = D("0.001")): Review[] {
  const keys = new Set<string>();
  for (const k of [...computed.keys(), ...holdings.keys()]) if (accountIds.has(splitKey(k)[0])) keys.add(k);
  const reviews: Review[] = [];
  for (const k of [...keys].sort(tupleOrder)) {
    const [acct, sym] = splitKey(k);
    const have = holdings.has(k) ? dec(holdings.get(k)!.quantity)! : ZERO;
    const calc = computed.get(k) ?? ZERO;
    if (have.minus(calc).abs().gt(tol)) {
      reviews.push(review(acct, `reconcile:${sym}`, "", "holdings mismatch", `${sym}: Plaid ${have}, computed ${calc}, diff ${have.minus(calc)}`));
    }
  }
  return reviews;
}

// Sort by account, then symbol; "|" in a key would sort differently, so compare parts.
function tupleOrder(x: string, y: string): number {
  const [a1, s1] = splitKey(x), [a2, s2] = splitKey(y);
  return a1 !== a2 ? (a1 < a2 ? -1 : 1) : s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
}
