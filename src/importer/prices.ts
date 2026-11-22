import { D, type Dec } from "./dec";
import { arrayOf, isNumber, nullable, orNull, shape } from "./json";
import { addDays } from "./plan";

interface ChartResult { timestamp?: number[] | null; indicators: { quote: { close?: (number | null)[] | null }[] } }
const isChart = shape<{ chart?: { result?: unknown[] | null } | null }>({
  chart: nullable(shape<{ result?: unknown[] | null }>({ result: nullable(arrayOf((v): v is unknown => v !== undefined)) })),
});
const isQuote = shape<{ close?: (number | null)[] | null }>({ close: nullable(arrayOf(orNull(isNumber))) });
const isChartResult = shape<ChartResult>({
  timestamp: nullable(arrayOf(isNumber)), indicators: shape<ChartResult["indicators"]>({ quote: arrayOf(isQuote) }),
});

const LOOKBACK_DAYS = 7;
export type CloseCache = Record<string, Record<string, string>>;
export type CloseFetch = (sym: string, start: string, end: string) => Promise<Record<string, string>>;
class NotFound extends Error {}

export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export function yahooFetch(get: HttpGet): CloseFetch {
  const ts = (day: string) => Math.floor(Date.parse(day + "T00:00:00Z") / 1000);
  return async (sym, start, end) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${ts(start)}&period2=${ts(addDays(end, 1))}&interval=1d`;
    const r = await get(url, { "User-Agent": "Mozilla/5.0 plaid-importer" });
    if (r.status === 404) throw new NotFound(sym);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const body: unknown = JSON.parse(r.body);
    const res = isChart(body) ? body.chart?.result?.[0] : undefined;
    if (!res) throw new NotFound(sym);
    if (!isChartResult(res)) throw new Error("unexpected chart response");
    const closes = res.indicators.quote[0]?.close ?? [];
    const out: Record<string, string> = {};
    (res.timestamp ?? []).forEach((t, i) => {
      const c = closes[i];
      if (c != null) out[new Date(t * 1000).toISOString().slice(0, 10)] = String(Math.round(c * 1e4) / 1e4);
    });
    return out;
  };
}

export class Closes {
  failed = new Map<string, string>();

  constructor(public cache: CloseCache, private fetch: CloseFetch, private today: string,
    private save: (c: CloseCache) => void | Promise<void> = () => {}) {}

  private refreshed = new Set<string>();

  async load(needs: [string, string][], { latest = false } = {}): Promise<void> {
    let changed = false;
    for (const [sym, day] of needs) {
      if (!sym || this.failed.has(sym)) continue;
      const stale = latest && !this.refreshed.has(sym) && this.lastDay(sym) < day;
      if (!stale && (this.lookup(sym, day) !== null || this.covers(sym, day))) continue;
      this.refreshed.add(sym);
      try {
        this.cache[sym] = { ...this.cache[sym], ...(await this.fetch(sym, addDays(day, -800), this.today)) };
        changed = true;
      } catch (e) {
        this.failed.set(sym, e instanceof NotFound ? "no prices for this symbol" : `could not reach it (${(e as Error).message})`);
      }
    }
    if (changed) await this.save(this.cache);
  }

  close = (sym: string | null, day: string): Dec | null => {
    if (!sym || this.failed.has(sym)) return null;
    const v = this.lookup(sym, day);
    return v ? D(v) : null;
  };

  closeOn(sym: string | null, day: string): { day: string; close: Dec } | null {
    if (!sym || this.failed.has(sym)) return null;
    for (let i = 0; i < LOOKBACK_DAYS; i++) {
      const d = addDays(day, -i), v = this.cache[sym]?.[d];
      if (v) return { day: d, close: D(v) };
    }
    return null;
  }

  nearest(sym: string | null, day: string): { day: string; close: Dec } | null {
    if (!sym || this.failed.has(sym)) return null;
    const t = Date.parse(day);
    let best: string | null = null;
    let close: string | undefined;
    for (const [d, c] of Object.entries(this.cache[sym] ?? {})) {
      if (best === null || Math.abs(Date.parse(d) - t) < Math.abs(Date.parse(best) - t)) { best = d; close = c; }
    }
    return best && close !== undefined ? { day: best, close: D(close) } : null;
  }

  warnings(): string[] {
    return [...this.failed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, why]) =>
      `Yahoo Finance price lookup for ${s} failed: ${why}. Its rows used a fallback price; run the dry run again before you push.`);
  }

  private lookup(sym: string, day: string): string | null {
    return this.closeOn(sym, day)?.close.toString() ?? null;
  }

  private lastDay(sym: string): string {
    return Object.keys(this.cache[sym] ?? {}).sort().at(-1) ?? "";
  }

  private covers(sym: string, day: string): boolean {
    const ds = Object.keys(this.cache[sym] ?? {}).sort();
    const first = ds[0], last = ds.at(-1);
    return first !== undefined && last !== undefined && first <= day && day <= last;
  }
}

export async function withPrices<T>(closes: Closes, planFn: (c: (sym: string | null, day: string) => Dec | null) => T): Promise<T> {
  const needs: [string, string][] = [];
  planFn((sym, day) => {
    if (sym) needs.push([sym, day]);
    return closes.close(sym, day);
  });
  await closes.load(needs);
  return planFn(closes.close);
}
