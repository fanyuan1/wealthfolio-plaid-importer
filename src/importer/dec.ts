// Exact decimal math. Never use JS numbers for money: 0.1 + 0.2 !== 0.3 breaks amount matching.
import BigBase from "big.js";

export const D = BigBase(); // own constructor, so its settings never leak to other users of big.js
D.DP = 28; // division keeps 28 decimal places
D.RM = 2; // round half to even
export type Dec = BigBase.Big;

export const ZERO: Dec = D(0);
export const EPS: Dec = D("0.000001");

/** Parse a Plaid number or ledger string; null for null, undefined and "". */
export function dec(v: unknown): Dec | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof D) return v as Dec;
  return D(typeof v === "number" ? String(v) : (v as string));
}

/** False for null and zero. */
export function nz(v: Dec | null | undefined): v is Dec {
  return v != null && !v.eq(0);
}
