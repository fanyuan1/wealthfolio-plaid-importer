import { D, type Dec, dec } from "./dec";
import type { Row } from "./models";

export interface Track { symbol: string; date: string; price: number; close: number; ratio: number }

export function entry(symbol: string, day: string, price: Dec, close: Dec): Track {
  return {
    symbol: symbol.trim().toUpperCase(), date: day, price: price.toNumber(), close: close.toNumber(),
    ratio: price.div(close).round(10, 2).toNumber(),
  };
}

function ratios(symbols: Record<string, Row>): Map<string, [Dec, string]> {
  const out = new Map<string, [Dec, string]>();
  for (const [sid, e] of Object.entries(symbols)) {
    if (e?.track && !e.exclude) out.set(sid, [D(String(e.track.ratio)), e.track.symbol]);
  }
  return out;
}

const QTY_DP = 10, PRICE_DP = 6;

function scale(row: Row, r: Dec, qty: string, price: string[]): Row {
  const out = { ...row };
  const q = dec(row[qty]);
  if (q !== null) out[qty] = q.times(r).round(QTY_DP, 2);
  for (const k of price) {
    const p = dec(row[k]);
    if (p !== null) out[k] = p.div(r).round(PRICE_DP, 2);
  }
  return out;
}

export function convert(txns: Row[], holdings: Row[], securities: Record<string, Row>, symbols: Record<string, Row>):
  [Row[], Row[], Record<string, Row>] {
  const rs = ratios(symbols);
  if (!rs.size) return [txns, holdings, securities];
  const secs = { ...securities };
  for (const [sid, [r, target]] of rs) {
    if (sid in secs) {
      secs[sid] = scale({ ...secs[sid], ticker_symbol: target, market_identifier_code: null, type: "etf",
        is_cash_equivalent: false }, r, "_", ["close_price"]);
    }
  }
  const tx = txns.map((t) => (rs.has(t.security_id) ? scale(t, rs.get(t.security_id)![0], "quantity", ["price"]) : t));
  const hs = holdings.map((h) => (rs.has(h.security_id) ? scale(h, rs.get(h.security_id)![0], "quantity", ["institution_price"]) : h));
  return [tx, hs, secs];
}

const REBASE_LIMIT = D("0.05");

export const trackedIds = (symbols: Record<string, Row>): Set<string> => new Set(ratios(symbols).keys());

export interface HoldingsItem { holdings?: { holdings?: Row[] } | null }

export function reportedPrice(items: HoldingsItem[], sid: string): [Dec, string] | null {
  let best: [Dec, string] | null = null;
  for (const d of items) {
    for (const h of d.holdings?.holdings ?? []) {
      const price = dec(h.institution_price), day = h.institution_price_as_of;
      if (h.security_id === sid && price && price.gt(0) && day && (best === null || String(day) > best[1])) {
        best = [price, String(day)];
      }
    }
  }
  return best;
}

export interface ExactCloses { exact(symbol: string, day: string): Dec | null }

class Rebase {
  constructor(public sid: string, public name: string, public old: Track, public day: string,
    public price: Dec, public close: Dec | null) {}

  get next(): Track | null {
    return this.close ? entry(this.old.symbol, this.day, this.price, this.close) : null;
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

export function rebases(items: HoldingsItem[], symbols: Record<string, Row>, closes: ExactCloses): Rebase[] {
  const out: Rebase[] = [];
  for (const sid of trackedIds(symbols)) {
    const e = symbols[sid];
    const got = reportedPrice(items, sid);
    if (got && got[1] > String(e.track.date)) {
      out.push(new Rebase(sid, e.name || sid, e.track, got[1], got[0], closes.exact(e.track.symbol, got[1])));
    }
  }
  return out;
}
