import { D, type Dec, dec, EPS, ZERO } from "./dec";
import { Activity, CASH_IN, CASH_OUT, POSITION_SIGN } from "./models";

export interface Existing {
  id: string; accountId: string; date: string; type: string; symbol: string | null;
  quantity: string | null; amount: string | null; comment: string | null;
}

type How = "new" | "exact" | "similar";

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

export const symbolRoot = (s: string | null | undefined) => {
  const t = (s ?? "").toUpperCase();
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

type WfAccount = (plaidAccount: string) => string | undefined;

const view = (a: Activity): Adoption["row"] => ({ date: a.date, type: a.activityType, symbol: a.symbol,
  amount: a.amount?.toFixed() ?? null, quantity: a.quantity?.toFixed() ?? null, description: a.description });
const make = (a: Activity, how: How, e: Existing | null, extra: Partial<Adoption> = {}): Adoption =>
  ({ key: a.plaidId, plaidId: a.plaidId, accountId: a.accountId, how, decision: how === "new" ? "add" : "discard", row: view(a), existing: e, ...extra });

export function findAdoptions(acts: Activity[], existing: Existing[], wf: WfAccount, taken: Set<string> = new Set()): Adoption[] {
  const used = new Set<string>(taken);
  const pool = existing.filter((e) => !taken.has(e.id));
  const out = new Map<string, Adoption>();
  const exact = matchById(acts, pool, wf);
  for (const e of exact.values()) used.add(e.id);
  const rest = acts.filter((a) => !exact.has(a.plaidId));
  for (const a of acts) {
    const e = exact.get(a.plaidId);
    if (e) out.set(a.plaidId, make(a, "exact", e));
  }
  const onDay = index(pool, (e) => [`${e.accountId}|${e.date}`]);
  for (const a of rest.filter((x) => !x.plaidId.startsWith("opening:"))) {
    const found = sameDayMatch(a, (onDay.get(`${wf(a.accountId)}|${a.date}`) ?? []).filter((e) => !used.has(e.id)));
    if (found) {
      used.add(found.hit.id);
      out.set(a.plaidId, make(a, found.how, found.hit));
    }
  }
  const inAccount = index(pool, (e) => [e.accountId]);
  for (const a of rest.filter((x) => x.plaidId.startsWith("opening:"))) {
    const adoption = openingAdoption(a, inAccount, wf);
    if (adoption) out.set(a.plaidId, adoption);
  }
  return acts.map((a) => out.get(a.plaidId) ?? make(a, "new", null));
}

function sameDayMatch(a: Activity, sameDay: Existing[]): { hit: Existing; how: How } | null {
  const cands = sameDay.filter((e) => symbolRoot(e.symbol) === symbolRoot(a.symbol) && sameAmount(a, e));
  const sameType = cands.find((e) => e.type === a.activityType);
  const anyType = a.activityType === "TRANSFER_IN" && a.symbol ? cands[0] : undefined;
  const exact = sameType ?? anyType;
  if (exact) return { hit: exact, how: "exact" };
  const similar = cands.find((e) => group(e.type) === group(a.activityType));
  return similar ? { hit: similar, how: "similar" } : null;
}

function openingAdoption(a: Activity, inAccount: Map<string, Existing[]>, wf: WfAccount): Adoption | null {
  const w = wf(a.accountId);
  if (!w || !a.symbol || !a.quantity) return null;
  const parts = (inAccount.get(w) ?? []).filter((e) => !isOurs(e) && e.date < a.date && e.symbol && POSITION_SIGN[e.type]
    && symbolRoot(e.symbol) === symbolRoot(a.symbol)).sort((x, y) => x.date.localeCompare(y.date));
  const held = parts.reduce((s, e) => s.plus((dec(e.quantity) ?? ZERO).abs().times(POSITION_SIGN[e.type] ?? 0)), ZERO);
  if (held.eq(0)) return null;
  return make(a, a.quantity.minus(held).abs().lte(EPS) ? "exact" : "similar", null, { held: held.toFixed(), parts });
}

export function matchById(acts: Activity[], existing: Existing[], wf: WfAccount): Map<string, Existing> {
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
