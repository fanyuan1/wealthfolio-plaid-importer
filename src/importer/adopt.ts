import { D, type Dec, dec, EPS, ZERO } from "./dec";
import { Activity, CASH_IN, CASH_OUT, POSITION_SIGN } from "./models";

export interface Existing {
  id: string; accountId: string; date: string; type: string; symbol: string | null;
  quantity: string | null; amount: string | null; comment: string | null;
}

export type How = "new" | "exact" | "similar";

export interface Adoption {
  key: string;
  plaidId: string;
  accountId: string;
  how: How;
  decision: "add" | "discard";
  row: { date: string; type: string; symbol: string | null; amount: string | null; quantity: string | null; description?: string };
  existing: Existing | null;
  held?: string;
  parts?: Existing[];
}

const TOL = D("0.01");

const norm = (s: string | null | undefined) => {
  const t = String(s ?? "").toUpperCase();
  return !t || t.startsWith("$CASH") ? null : t.split(/[-.]/)[0];
};
const near = (a: Dec | null, b: Dec | null, tol: Dec) => a !== null && b !== null && a.abs().minus(b.abs()).abs().lte(tol);
const group = (t: string) => (CASH_IN.has(t) ? "in" : CASH_OUT.has(t) ? "out" : t);

const isOurs = (e: Existing) => /plaid:/.test(e.comment ?? "");

function index(list: Existing[], keys: (e: Existing) => string[]): Map<string, Existing[]> {
  const out = new Map<string, Existing[]>();
  for (const e of list) {
    for (const k of keys(e)) {
      const g = out.get(k);
      if (g) g.push(e);
      else out.set(k, [e]);
    }
  }
  return out;
}
const byNote = (list: Existing[]) => index(list, (e) => (e.comment ?? "").split(/\s+/).filter((w) => w.startsWith("plaid:")).map((w) => w.slice(6)));

function sameAmount(a: Activity, e: Existing): boolean {
  const [aq, eq] = [dec(a.quantity), dec(e.quantity)];
  if (a.symbol && aq && eq && !aq.eq(0)) return near(aq, eq, EPS);
  return near(dec(a.amount), dec(e.amount), TOL);
}

export function findAdoptions(acts: Activity[], existing: Existing[], wf: (plaidAccount: string) => string | undefined,
  taken: Set<string> = new Set()): Adoption[] {
  const used = new Set<string>(taken);
  const pool = existing.filter((e) => !taken.has(e.id));
  const view = (a: Activity) => ({ date: a.date, type: a.activityType, symbol: a.symbol,
    amount: a.amount?.toFixed() ?? null, quantity: a.quantity?.toFixed() ?? null, description: a.description });
  const make = (a: Activity, how: How, e: Existing | null, extra: Partial<Adoption> = {}): Adoption =>
    ({ key: a.plaidId, plaidId: a.plaidId, accountId: a.accountId, how, decision: how === "new" ? "add" : "discard", row: view(a), existing: e, ...extra });
  const out = new Map<string, Adoption>();
  const rest: Activity[] = [];
  const noted = byNote(pool);
  const onDay = index(pool, (e) => [`${e.accountId}|${e.date}`]);
  const inAccount = index(pool, (e) => [e.accountId]);
  for (const a of acts) {
    const hit = noted.get(a.plaidId)?.find((e) => !used.has(e.id) && e.accountId === wf(a.accountId));
    if (hit) {
      used.add(hit.id);
      out.set(a.plaidId, make(a, "exact", hit));
    } else rest.push(a);
  }
  const opening: Activity[] = [];
  for (const a of rest) {
    if (a.plaidId.startsWith("opening:")) { opening.push(a); continue; }
    const cands = (onDay.get(`${wf(a.accountId)}|${a.date}`) ?? []).filter((e) => !used.has(e.id)
      && norm(e.symbol) === norm(a.symbol) && sameAmount(a, e));
    const sameType = cands.find((e) => e.type === a.activityType);
    const anyType = a.activityType === "TRANSFER_IN" && a.symbol ? cands[0] : undefined;
    const similar = cands.find((e) => group(e.type) === group(a.activityType));
    const hit = sameType ?? anyType ?? similar;
    if (hit) {
      used.add(hit.id);
      out.set(a.plaidId, make(a, sameType || anyType ? "exact" : "similar", hit));
    }
  }
  for (const a of opening) {
    const w = wf(a.accountId);
    if (!w || !a.symbol || !a.quantity) continue;
    const parts = (inAccount.get(w) ?? []).filter((e) => !isOurs(e) && e.date < a.date && e.symbol && POSITION_SIGN[e.type]
      && norm(e.symbol) === norm(a.symbol)).sort((x, y) => x.date.localeCompare(y.date));
    const held = parts.reduce((s, e) => s.plus((dec(e.quantity) ?? ZERO).abs().times(POSITION_SIGN[e.type])), ZERO);
    if (held.eq(0)) continue;
    out.set(a.plaidId, make(a, a.quantity.minus(held).abs().lte(EPS) ? "exact" : "similar", null, { held: held.toFixed(), parts }));
  }
  return acts.map((a) => out.get(a.plaidId) ?? make(a, "new", null));
}

export function matchById(acts: Activity[], existing: Existing[], wf: (plaidAccount: string) => string | undefined): Map<string, Existing> {
  const out = new Map<string, Existing>();
  const used = new Set<string>();
  const noted = byNote(existing);
  for (const a of acts) {
    const hit = noted.get(a.plaidId)?.find((e) => !used.has(e.id) && e.accountId === wf(a.accountId));
    if (hit) {
      used.add(hit.id);
      out.set(a.plaidId, hit);
    }
  }
  return out;
}
