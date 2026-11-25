import { valueAt } from "./at";
import { D, type Dec, dec } from "./dec";
import type { LedgerRow } from "./ledger";
import { Activity, isOpening } from "./models";
import type { PlaidHolding, PlaidInvestmentTransaction, PlaidSecurity, Scaled } from "./plaidTypes";
import type { SecurityOverride } from "./securities";

export interface Track { symbol: string; date: string; price: number; close: number; ratio: number }

export function entry(symbol: string, day: string, price: Dec, close: Dec): Track {
  return {
    symbol: symbol.trim().toUpperCase(), date: day, price: price.toNumber(), close: close.toNumber(),
    ratio: price.div(close).round(10, 2).toNumber(),
  };
}

function ratios(symbols: Record<string, SecurityOverride>): Map<string, [Dec, string]> {
  const out = new Map<string, [Dec, string]>();
  for (const [sid, e] of Object.entries(symbols)) {
    if (e.track && !e.exclude) out.set(sid, [D(String(e.track.ratio)), e.track.symbol]);
  }
  return out;
}

const QTY_DP = 10, PRICE_DP = 6;

const times = (v: Scaled, r: Dec): Dec => D(String(v)).times(r).round(QTY_DP, 2);
const over = (v: Scaled, r: Dec): Dec => D(String(v)).div(r).round(PRICE_DP, 2);

export function convert(txns: PlaidInvestmentTransaction[], holdings: PlaidHolding[], securities: Record<string, PlaidSecurity>,
  symbols: Record<string, SecurityOverride>): [PlaidInvestmentTransaction[], PlaidHolding[], Record<string, PlaidSecurity>] {
  const rs = ratios(symbols);
  if (!rs.size) return [txns, holdings, securities];
  const secs = { ...securities };
  for (const [sid, [r, target]] of rs) {
    const s = secs[sid];
    if (s) {
      secs[sid] = { ...s, ticker_symbol: target, market_identifier_code: null, type: "etf", is_cash_equivalent: false,
        ...(s.close_price == null ? {} : { close_price: over(s.close_price, r) }) };
    }
  }
  const tx = txns.map((t) => {
    const r = rs.get(t.security_id ?? "")?.[0];
    return r ? { ...t, quantity: times(t.quantity, r), price: over(t.price, r) } : t;
  });
  const hs = holdings.map((h) => {
    const r = rs.get(h.security_id)?.[0];
    return r ? { ...h, quantity: times(h.quantity, r), institution_price: over(h.institution_price, r) } : h;
  });
  return [tx, hs, secs];
}

function followed(symbols: Record<string, SecurityOverride>, sid: string): Track | undefined {
  const e = symbols[sid];
  return e?.exclude ? undefined : e?.track;
}

export function stampRatios(acts: Activity[], symbols: Record<string, SecurityOverride>): void {
  for (const a of acts) {
    if (a.securityId === null || a.marketPrice) continue;
    const track = followed(symbols, a.securityId);
    if (!track) continue;
    a.fund = a.securityId;
    a.ratio = track.ratio;
  }
}

export function atCurrentRatio(a: Activity, symbols: Record<string, SecurityOverride>): Activity | null {
  const track = a.fund === undefined ? undefined : followed(symbols, a.fund);
  if (!track || a.ratio === undefined || a.ratio === track.ratio || a.symbol !== track.symbol) return null;
  const r = D(String(track.ratio)).div(D(String(a.ratio)));
  const next = new Activity(a);
  next.ratio = track.ratio;
  next.quantity = a.quantity && times(a.quantity, r);
  next.unitPrice = a.unitPrice && over(a.unitPrice, r);
  next.splitDelta = a.splitDelta && times(a.splitDelta, r);
  return next;
}

export function rememberRatio(rows: Iterable<LedgerRow>, fund: string, old: Track, accounts: Set<string>): void {
  for (const r of rows) {
    if (r.fund !== undefined || r.adopted || isOpening(r.plaid_id) || r.symbol !== old.symbol || !accounts.has(r.account_id)) continue;
    Object.assign(r, { fund, ratio: old.ratio });
  }
}

const REBASE_LIMIT = D("0.05");

export const trackedIds = (symbols: Record<string, SecurityOverride>): Set<string> => new Set(ratios(symbols).keys());

export interface HoldingsItem {
  holdings?: { holdings: Pick<PlaidHolding, "security_id" | "institution_price" | "institution_price_as_of">[] } | null | undefined;
}

export function reportedPrice(items: HoldingsItem[], sid: string): [Dec, string] | null {
  let best: [Dec, string] | null = null;
  for (const d of items) {
    for (const h of d.holdings?.holdings ?? []) {
      const price = dec(h.institution_price), day = h.institution_price_as_of;
      if (h.security_id === sid && price && price.gt(0) && day && (best === null || day > best[1])) {
        best = [price, day];
      }
    }
  }
  return best;
}

interface DatedClose { day: string; close: Dec }
export interface RecentCloses { closeOn(symbol: string, day: string): DatedClose | null }

interface RebaseInit {
  sid: string;
  name: string;
  old: Track;
  day: string;
  price: Dec;
  close: DatedClose | null;
}

class Rebase implements RebaseInit {
  sid: string;
  name: string;
  old: Track;
  day: string;
  price: Dec;
  close: DatedClose | null;

  constructor(init: RebaseInit) {
    ({ sid: this.sid, name: this.name, old: this.old, day: this.day, price: this.price, close: this.close } = init);
  }

  get next(): Track | null {
    return this.close ? entry(this.old.symbol, this.close.day, this.price, this.close.close) : null;
  }

  get change(): Dec | null {
    const n = this.next;
    return n ? D(String(n.ratio)).div(D(String(this.old.ratio))).minus(1) : null;
  }

  get safe(): boolean {
    const c = this.change;
    return c !== null && c.abs().lte(REBASE_LIMIT);
  }
}

export function rebases(items: HoldingsItem[], symbols: Record<string, SecurityOverride>, closes: RecentCloses): Rebase[] {
  const out: Rebase[] = [];
  for (const sid of trackedIds(symbols)) {
    const e = valueAt(symbols, sid);
    const track = e.track;
    const got = reportedPrice(items, sid);
    if (track && got && got[1] > track.date && !got[0].eq(D(String(track.price)))) {
      out.push(new Rebase({ sid, name: e.name || sid, old: track, day: got[1], price: got[0], close: closes.closeOn(track.symbol, got[1]) }));
    }
  }
  return out;
}
