// Daily closing prices from Yahoo Finance (Wealthfolio's default provider), cached. Used only where Plaid
// gives no price: opening positions without cost basis, and RSU vests.
import { D, type Dec } from "./dec";
import { addDays } from "./plan";

const LOOKBACK_DAYS = 7; // a weekend or holiday takes the last close before it
export type CloseCache = Record<string, Record<string, string>>; // symbol -> day -> close
/** [start, end] days -> {day: close}. Throws on failure; a NotFound error means Yahoo has no such symbol. */
export type CloseFetch = (sym: string, start: string, end: string) => Promise<Record<string, string>>;
class NotFound extends Error {}

/** GET a URL; return the status and body. */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export function yahooFetch(get: HttpGet): CloseFetch {
  const ts = (day: string) => Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
  return async (sym, start, end) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${ts(start)}&period2=${ts(addDays(end, 1))}&interval=1d`;
    const r = await get(url, { "User-Agent": "Mozilla/5.0 plaid-importer" });
    if (r.status === 404) throw new NotFound(sym);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const res = JSON.parse(r.body)?.chart?.result?.[0];
    if (!res) throw new NotFound(sym);
    const closes: (number | null)[] = res.indicators.quote[0].close;
    const out: Record<string, string> = {};
    (res.timestamp ?? []).forEach((t: number, i: number) => {
      const c = closes[i];
      if (c != null) out[new Date(t * 1000).toISOString().slice(0, 10)] = String(Math.round(c * 1e4) / 1e4);
    });
    return out;
  };
}

/** Prices are prefetched with load() before planning, since plan() is synchronous. */
export class Closes {
  failed = new Map<string, string>(); // symbol -> why the lookup failed

  constructor(public cache: CloseCache, private fetch: CloseFetch, private today: string,
    private save: (c: CloseCache) => void | Promise<void> = () => {}) {}

  /** Make sure the cache covers day for each symbol, fetching ~800 days at once. */
  async load(needs: [string, string][]): Promise<void> {
    let changed = false;
    for (const [sym, day] of needs) {
      if (!sym || this.failed.has(sym) || this.lookup(sym, day) !== null || this.covers(sym, day)) continue;
      try {
        this.cache[sym] = { ...this.cache[sym], ...(await this.fetch(sym, addDays(day, -800), this.today)) };
        changed = true;
      } catch (e) { // offline, rate-limited or unknown symbol: fall back, never block a sync
        this.failed.set(sym, e instanceof NotFound ? "no prices for this symbol" : `could not reach it (${(e as Error).message})`);
      }
    }
    if (changed) await this.save(this.cache);
  }

  /** The close on day, or the last one within a week before it. */
  close = (sym: string | null, day: string): Dec | null => {
    if (!sym || this.failed.has(sym)) return null;
    const v = this.lookup(sym, day);
    return v ? D(v) : null;
  };

  /** The close on that very day, or null (no lookback): an exchange ratio needs same-day prices. */
  exact(sym: string | null, day: string): Dec | null {
    if (!sym || this.failed.has(sym)) return null;
    const v = this.cache[sym]?.[day];
    return v ? D(v) : null;
  }

  /** The close nearest to day, before or after (no limit): for an exchange ratio when that very day has no price. */
  nearest(sym: string | null, day: string): { day: string; close: Dec } | null {
    if (!sym || this.failed.has(sym)) return null;
    const t = Date.parse(day);
    let best: string | null = null;
    for (const d of Object.keys(this.cache[sym] ?? {})) {
      if (best === null || Math.abs(Date.parse(d) - t) < Math.abs(Date.parse(best) - t)) best = d;
    }
    return best ? { day: best, close: D(this.cache[sym][best]) } : null;
  }

  warnings(): string[] {
    return [...this.failed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, why]) =>
      `Yahoo Finance price lookup for ${s} failed: ${why}. Its rows used a fallback price; run the dry run again before you push.`);
  }

  private lookup(sym: string, day: string): string | null {
    const closes = this.cache[sym] ?? {};
    for (let i = 0; i < LOOKBACK_DAYS; i++) {
      const v = closes[addDays(day, -i)];
      if (v) return v;
    }
    return null;
  }

  private covers(sym: string, day: string): boolean {
    const ds = Object.keys(this.cache[sym] ?? {}).sort();
    return ds.length > 0 && ds[0] <= day && day <= ds[ds.length - 1];
  }
}

/** plan() needs prices synchronously. Plan once to learn which closes it asks for, fetch them, then plan
 * again with the cache filled. plan() is pure, so the first pass has no effect. */
export async function withPrices<T>(closes: Closes, planFn: (c: (sym: string | null, day: string) => Dec | null) => T): Promise<T> {
  const needs: [string, string][] = [];
  planFn((sym, day) => {
    if (sym) needs.push([sym, day]);
    return closes.close(sym, day);
  });
  await closes.load(needs);
  return planFn(closes.close);
}
