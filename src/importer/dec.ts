import BigBase from "big.js";

export const D = BigBase();
D.DP = 28;
D.RM = 2;
export type Dec = BigBase.Big;

export const ZERO: Dec = D(0);
export const EPS: Dec = D("0.000001");

export function dec(v: unknown): Dec | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof D) return v;
  return D(typeof v === "number" ? String(v) : (v as string));
}

export function nz(v: Dec | null | undefined): v is Dec {
  return v != null && !v.eq(0);
}
