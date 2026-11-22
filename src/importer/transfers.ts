import type { Activity } from "./models";

export const MAX_DAYS = 3;
const REF = /\d{6,}/g;

const refs = (a: Activity): Set<string> => new Set(a.description.match(REF) ?? []);
export const daysBetween = (a: string, b: string): number =>
  Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

const cmp = (a: (string | number)[], b: (string | number)[]): number => {
  for (const [k, x] of a.entries()) {
    const y = b[k];
    if (y === undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

export function matchTransfers(acts: Activity[], maxDays = MAX_DAYS): [Activity, Activity][] {
  const free = (a: Activity) => a.transferHint && a.pairId === null && a.symbol === null;
  const outs = acts.filter((a) => free(a) && (a.activityType === "WITHDRAWAL" || a.activityType === "TRANSFER_OUT"));
  const ins = acts.filter((a) => free(a) && (a.activityType === "DEPOSIT" || a.activityType === "TRANSFER_IN"));
  const candidates: { key: (string | number)[]; o: Activity; i: Activity }[] = [];
  for (const o of outs) {
    for (const i of ins) {
      const days = daysBetween(o.date, i.date);
      if (o.accountId !== i.accountId && o.currency === i.currency && o.amount !== null && i.amount !== null
        && o.amount.eq(i.amount) && days <= maxDays) {
        const ri = refs(i);
        const shared = [...refs(o)].some((r) => ri.has(r)) ? 0 : 1;
        candidates.push({ key: [shared, days, o.date, o.plaidId, i.plaidId], o, i });
      }
    }
  }
  candidates.sort((a, b) => cmp(a.key, b.key));
  const used = new Set<string>();
  const pairs: [Activity, Activity][] = [];
  for (const { o, i } of candidates) {
    if (used.has(o.plaidId) || used.has(i.plaidId)) continue;
    used.add(o.plaidId).add(i.plaidId);
    o.activityType = "TRANSFER_OUT";
    i.activityType = "TRANSFER_IN";
    o.pairId = i.plaidId;
    i.pairId = o.plaidId;
    o.category = i.category = null;
    pairs.push([o, i]);
  }
  return pairs;
}
