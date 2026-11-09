// Resolve a Plaid security to a Wealthfolio symbol.
import { D, type Dec } from "./dec";
import type { Row } from "./models";

// Yahoo suffix per exchange MIC. US MICs need no suffix.
export const MIC_SUFFIX: Record<string, string> = {
  XTSE: ".TO", XTSX: ".V", XLON: ".L", XAMS: ".AS", XETR: ".DE",
  XFRA: ".F", XPAR: ".PA", XASX: ".AX", XHKG: ".HK", XSWX: ".SW",
};

export const INSTRUMENT_TYPE: Record<string, string> = {
  equity: "EQUITY", etf: "EQUITY", "mutual fund": "EQUITY",
  "fixed income": "BOND", derivative: "OPTION", cryptocurrency: "CRYPTO",
};

export interface Resolved {
  kind: "security" | "cash" | "exclude" | "unmapped";
  symbol: string | null;
  instrumentType: string | null;
  manual: boolean;
  multiplier: Dec; // options: Plaid counts single options, Wealthfolio counts contracts
}

const res = (kind: Resolved["kind"], symbol: string | null = null, instrumentType: string | null = null,
  manual = false, multiplier: Dec = D(1)): Resolved => ({ kind, symbol, instrumentType, manual, multiplier });

const OCC = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;
export const OPTION_MULTIPLIER = D(100);

/** Compact OCC symbol (Wealthfolio/Yahoo format), e.g. AAPL240621C00190000. */
export function occSymbol(security: Row): string | null {
  const ticker = String(security.ticker_symbol ?? "").replace(/ /g, "").toUpperCase();
  if (OCC.test(ticker)) return ticker;
  const c = security.option_contract ?? {};
  try {
    const exp = String(c.expiration_date);
    const right = ({ call: "C", put: "P" } as Record<string, string>)[String(c.contract_type).toLowerCase()];
    if (!right || !c.underlying_security_ticker || exp.length < 10 || c.strike_price == null) return null;
    const strike = D(String(c.strike_price)).times(1000).round(0, 2).toFixed(0).padStart(8, "0");
    return `${String(c.underlying_security_ticker).toUpperCase()}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${right}${strike}`;
  } catch {
    return null;
  }
}

const FIAT = new Set(["USD", "EUR", "GBP", "CAD", "JPY", "AUD", "CHF", "CNY", "MXN", "INR", "DKK", "NOK", "SEK", "PLN"]);
const KNOWN_CRYPTO = new Set(["BTC", "ETH", "SOL", "DOGE", "LTC", "XRP", "ADA", "AVAX", "DOT", "LINK", "SHIB", "BCH", "MATIC", "XLM", "ETC"]);

/** Plaid files some crypto as type cash or other (ticker CUR:BTC), or flags it cash-equivalent. */
export function isCrypto(sec: Row): boolean {
  if (sec.type === "cryptocurrency") return true;
  const t = String(sec.ticker_symbol ?? "").toUpperCase();
  const base = t.replace(/^CUR:/, "").split("-")[0];
  if (!base || FIAT.has(base)) return false;
  return t.startsWith("CUR:") || (["cash", "other", undefined, null].includes(sec.type) && KNOWN_CRYPTO.has(base));
}

/** Yahoo/Wealthfolio crypto pair, e.g. BTC-USD. Plaid sends BTC, CUR:BTC or an already paired BTC-USD. */
export function cryptoSymbol(ticker: string, currency = "USD"): string {
  const t = ticker.trim().toUpperCase().replace(/^CUR:/, "");
  return t.includes("-") ? t : `${t}-${currency}`;
}

/** Stable made-up symbol for a fund with no ticker, e.g. TARGET2050CIT-1A2B. */
export function manualSymbol(security: Row): string {
  const base = String(security.name || "FUND").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16) || "FUND";
  return `${base}-${String(security.security_id).slice(0, 4).toUpperCase()}`;
}

export function resolve(security: Row | null | undefined, overrides: Record<string, Row>, currency = "USD"): Resolved {
  if (security == null) return res("cash");
  const o = overrides[security.security_id] ?? {};
  if (o.exclude) return res("exclude");
  const stype = security.type;
  const itype = o.instrument_type || INSTRUMENT_TYPE[stype] || null;
  // Sweep/money-market funds are cash unless the user says they are a real holding.
  // Merrill's bank sweep ("Ml Direct Deposit Progrm") comes as type other, ticker "Deposit".
  const sweep = stype === "other" && String(security.ticker_symbol ?? "").toUpperCase() === "DEPOSIT";
  if (!o.cash && !o.symbol && !o.track && isCrypto(security)) {
    return res("security", cryptoSymbol(String(security.ticker_symbol), currency), "CRYPTO", Boolean(o.manual));
  }
  const isCash = o.cash || (!o.investment && (security.is_cash_equivalent || stype === "cash" || sweep));
  if (isCash) return res("cash");
  if (stype === "derivative") {
    const occ = o.symbol || occSymbol(security);
    if (!occ) return res("unmapped");
    return res("security", occ, "OPTION", Boolean(o.manual), D(String(o.multiplier || OPTION_MULTIPLIER)));
  }
  if (o.track) return res("security", o.track.symbol, "EQUITY", false); // held in units of the symbol it follows
  if (o.symbol) return res("security", o.symbol, itype, Boolean(o.manual));
  const ticker = security.ticker_symbol;
  if (!ticker && o.manual) return res("security", manualSymbol(security), itype || "EQUITY", true);
  if (!ticker) return res("unmapped");
  if (isCrypto(security)) return res("security", cryptoSymbol(ticker, currency), "CRYPTO", Boolean(o.manual));
  const suffix = MIC_SUFFIX[security.market_identifier_code || ""] ?? "";
  return res("security", `${ticker}${suffix}`, itype, Boolean(o.manual));
}

/** Plaid's own ticker in Yahoo's form; null for securities Plaid gives no ticker. */
export function yahooSymbol(sec: Row | null | undefined): string | null {
  const t = sec?.ticker_symbol;
  if (sec && t && isCrypto(sec)) return cryptoSymbol(t, sec.iso_currency_code || "USD");
  if (!t || sec!.type === "derivative" || sec!.type === "cash" || sec!.is_cash_equivalent) return null;
  return t + (YAHOO_SUFFIX[sec!.market_identifier_code || ""] ?? "");
}

// Yahoo suffixes for price lookups (a shorter list than MIC_SUFFIX, as in the earlier version).
export const YAHOO_SUFFIX: Record<string, string> = { XTSE: ".TO", XTSX: ".V", XLON: ".L", XASX: ".AX" };
