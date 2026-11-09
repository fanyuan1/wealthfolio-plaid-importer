// Pair transfer legs across linked accounts.
import type { Activity } from "./models";

export const MAX_DAYS = 3;
const REF = /\d{6,}/g; // e.g. Chase "transaction#: 23473949867", printed on both legs

const refs = (a: Activity): Set<string> => new Set(a.description?.match(REF) ?? []);
export const daysBetween = (a: string, b: string): number =>
  Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

const cmp = (a: (string | number)[], b: (string | number)[]): number => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
};

/** Greedy match of WITHDRAWAL->DEPOSIT legs. Both legs must carry Plaid's transfer hint, be in different
 * accounts, share currency and amount, and be within maxDays. Matched legs are retyped in place. */
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
        // A shared reference number beats date and id order: two same-day legs of one amount
        // are otherwise paired by plaid_id, which is arbitrary.
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
