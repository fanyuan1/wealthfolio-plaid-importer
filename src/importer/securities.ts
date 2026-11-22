import { D, type Dec } from "./dec";
import type { PlaidSecurity } from "./plaidTypes";
import type { Track } from "./tracking";

export interface SecurityOverride {
  name?: string; symbol?: string | null; manual?: boolean; cash?: boolean; investment?: boolean; exclude?: boolean;
  instrument_type?: string; multiplier?: string | number; track?: Track;
}

const MIC_SUFFIX: Record<string, string> = {
  XTSE: ".TO", XTSX: ".V", XLON: ".L", XAMS: ".AS", XETR: ".DE",
  XFRA: ".F", XPAR: ".PA", XASX: ".AX", XHKG: ".HK", XSWX: ".SW",
};

const INSTRUMENT_TYPE: Record<string, string> = {
  equity: "EQUITY", etf: "EQUITY", "mutual fund": "EQUITY",
  "fixed income": "BOND", derivative: "OPTION", cryptocurrency: "CRYPTO",
};

export interface Resolved {
  kind: "security" | "cash" | "exclude" | "unmapped";
  symbol: string | null;
  instrumentType: string | null;
  manual: boolean;
  multiplier: Dec;
}

const res = (kind: Exclude<Resolved["kind"], "security">): Resolved => ({ kind, symbol: null, instrumentType: null, manual: false, multiplier: D(1) });
const held = (symbol: string, instrumentType: string | null, manual: boolean, multiplier: Dec = D(1)): Resolved =>
  ({ kind: "security", symbol, instrumentType, manual, multiplier });

const OCC = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;
const OPTION_MULTIPLIER = D(100);
const OPTION_RIGHT: Partial<Record<string, string>> = { call: "C", put: "P" };

function occSymbol(security: PlaidSecurity): string | null {
  const ticker = (security.ticker_symbol ?? "").replace(/ /g, "").toUpperCase();
  if (OCC.test(ticker)) return ticker;
  const c = security.option_contract ?? {};
  try {
    const exp = c.expiration_date ?? "";
    const right = OPTION_RIGHT[(c.contract_type ?? "").toLowerCase()];
    if (!right || !c.underlying_security_ticker || exp.length < 10 || c.strike_price == null) return null;
    const strike = D(String(c.strike_price)).times(1000).round(0, 2).toFixed(0).padStart(8, "0");
    return `${c.underlying_security_ticker.toUpperCase()}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${strike}`;
  } catch {
    return null;
  }
}

const FIAT = new Set(Intl.supportedValuesOf("currency"));
const KNOWN_CRYPTO = new Set(["BTC", "ETH", "SOL", "DOGE", "LTC", "XRP", "ADA", "AVAX", "DOT", "LINK", "SHIB", "BCH", "MATIC", "XLM", "ETC"]);

export function isCrypto(sec: Pick<PlaidSecurity, "type" | "ticker_symbol">): boolean {
  if (sec.type === "cryptocurrency") return true;
  const t = (sec.ticker_symbol ?? "").toUpperCase();
  const base = t.replace(/^CUR:/, "").split("-")[0];
  if (!base || FIAT.has(base)) return false;
  return t.startsWith("CUR:") || ((sec.type == null || sec.type === "cash" || sec.type === "other") && KNOWN_CRYPTO.has(base));
}

export function isCurrency(sec: Pick<PlaidSecurity, "ticker_symbol">): boolean {
  const m = /^CUR:([A-Z]{3})$/.exec((sec.ticker_symbol ?? "").toUpperCase());
  return Boolean(m?.[1] && FIAT.has(m[1]));
}

export function cryptoSymbol(ticker: string, currency = "USD"): string {
  const t = ticker.trim().toUpperCase().replace(/^CUR:/, "");
  return t.includes("-") ? t : `${t}-${currency}`;
}

function manualSymbol(security: PlaidSecurity): string {
  const base = (security.name || "FUND").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16) || "FUND";
  return `${base}-${security.security_id.slice(0, 4).toUpperCase()}`;
}

export function resolve(security: PlaidSecurity | null | undefined, overrides: Record<string, SecurityOverride>, currency = "USD"): Resolved {
  if (security == null) return res("cash");
  const o = overrides[security.security_id] ?? {};
  if (o.exclude) return res("exclude");
  const stype = security.type;
  const mappedToStock = stype === "derivative" && Boolean(o.symbol) && !OCC.test((o.symbol ?? "").toUpperCase());
  const sweep = stype === "other" && (security.ticker_symbol ?? "").toUpperCase() === "DEPOSIT";
  if (!o.cash && !o.symbol && !o.track && isCrypto(security)) {
    return held(cryptoSymbol(security.ticker_symbol ?? "", currency), "CRYPTO", Boolean(o.manual));
  }
  const isCash = o.cash || (!o.investment && (security.is_cash_equivalent || stype === "cash" || sweep));
  if (isCash) return res("cash");
  if (stype === "derivative" && !mappedToStock) return option(security, o);
  const itype = o.instrument_type || (mappedToStock ? "EQUITY" : INSTRUMENT_TYPE[stype ?? ""]) || null;
  return listed(security, o, itype, currency);
}

function option(security: PlaidSecurity, o: SecurityOverride): Resolved {
  const occ = o.symbol || occSymbol(security);
  if (!occ) return res("unmapped");
  return held(occ, "OPTION", Boolean(o.manual), D(String(o.multiplier || OPTION_MULTIPLIER)));
}

function listed(security: PlaidSecurity, o: SecurityOverride, itype: string | null, currency: string): Resolved {
  if (o.track) return held(o.track.symbol, "EQUITY", false);
  if (o.symbol) return held(o.symbol, itype, Boolean(o.manual));
  const ticker = security.ticker_symbol;
  if (!ticker && o.manual) return held(manualSymbol(security), itype || "EQUITY", true);
  if (!ticker) return res("unmapped");
  if (isCrypto(security)) return held(cryptoSymbol(ticker, currency), "CRYPTO", Boolean(o.manual));
  const suffix = MIC_SUFFIX[security.market_identifier_code || ""] ?? "";
  return held(`${ticker}${suffix}`, itype, Boolean(o.manual));
}

export function yahooSymbol(sec: PlaidSecurity | null | undefined): string | null {
  const t = sec?.ticker_symbol;
  if (!sec || !t) return null;
  if (isCrypto(sec)) return cryptoSymbol(t, sec.iso_currency_code || "USD");
  if (sec.type === "derivative" || sec.type === "cash" || sec.is_cash_equivalent) return null;
  return t + (YAHOO_SUFFIX[sec.market_identifier_code || ""] ?? "");
}

const YAHOO_SUFFIX: Record<string, string> = { XTSE: ".TO", XTSX: ".V", XLON: ".L", XASX: ".AX" };
