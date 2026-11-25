import { symbolRoot } from "./adopt";
import { dec, ZERO } from "./dec";
import { differs, type LedgerField, type LedgerRow, type MemoryLedger, rowToActivity } from "./ledger";
import { type Activity, isOpening } from "./models";
import { hkey } from "./positions";
import type { Plan } from "./plan";

export interface HeldRow extends Pick<LedgerRow, LedgerField> {
  id: string;
  isUserModified: boolean;
  status: string;
}

export type Held = Map<string, HeldRow>;

const COMPARE_DP = 8;
const CENT = dec("0.01") ?? ZERO;
const FEE_SIGN: Partial<Record<string, number>> = { BUY: 1, SELL: -1 };

const num = (v: string | null) => dec(v) ?? ZERO;
const sameNumber = (a: string | null, b: string | null) => num(a).round(COMPARE_DP).eq(num(b).round(COMPARE_DP));

function sameTotal(row: LedgerRow, stored: string | null): boolean {
  if (row.amount !== null || num(stored).eq(0)) return sameNumber(row.amount, stored);
  const sign = FEE_SIGN[row.activity_type];
  if (sign === undefined) return false;
  const total = num(row.quantity).times(num(row.unit_price)).plus(num(row.fee).times(sign));
  return num(stored).minus(total).abs().lte(CENT);
}

function isAsWritten(row: LedgerRow, now: HeldRow): boolean {
  const sameTrade = row.activity_type === "SPLIT" || (sameNumber(now.quantity, row.quantity)
    && sameNumber(now.unit_price, row.unit_price) && sameNumber(now.fee, row.fee));
  return now.status !== "VOID" && now.activity_type === row.activity_type && now.date === row.date && now.currency === row.currency
    && symbolRoot(now.symbol) === symbolRoot(row.symbol) && sameTrade && sameTotal(row, now.amount);
}

export function isProtected(row: LedgerRow | null, held: Held): boolean {
  if (!row) return false;
  const now = row.wf_activity_id ? held.get(row.wf_activity_id) : undefined;
  return Boolean(row.adopted) || Boolean(now?.isUserModified && !isAsWritten(row, now));
}

interface Change {
  row: Pick<LedgerRow, "plaid_id" | "account_id" | "symbol">;
  movesCash: () => boolean;
}

const shareKey = (c: Change): string | null => (c.row.symbol ? hkey(c.row.account_id, c.row.symbol) : null);
const isCashOpening = (c: Change) => isOpening(c.row.plaid_id) && !c.row.symbol;

function recordMadeByUser(p: Plan, state: MemoryLedger, held: Held): void {
  p.updates = p.updates.filter(([row, a, fields]) => {
    const now = row.wf_activity_id ? held.get(row.wf_activity_id) : undefined;
    if (!now || !isProtected(row, held)) return true;
    const open = differs({ ...now, pair_plaid_id: row.pair_plaid_id }, a);
    if (fields.some((f) => open.includes(f))) return true;
    state.record(a, row.wf_activity_id);
    if (row.category_set) state.setCategory(row.plaid_id);
    return false;
  });
  p.voids = p.voids.filter((row) => {
    if (row.adopted || !row.wf_activity_id || held.has(row.wf_activity_id)) return true;
    state.setVoided(row.plaid_id, true);
    return false;
  });
}

const updateChange = ([row, a]: Plan["updates"][number]): Change =>
  ({ row, movesCash: () => !a.cashDelta().eq(rowToActivity(row).cashDelta()) });
const voidChange = (row: LedgerRow): Change => ({ row, movesCash: () => !rowToActivity(row).cashDelta().eq(0) });
const newChange = (a: Activity): Change =>
  ({ row: { plaid_id: a.plaidId, account_id: a.accountId, symbol: a.symbol }, movesCash: () => false });

function blockedOpenings(changes: Change[], direct: Set<string>): Set<string> {
  const blocked = new Set(direct);
  const keysOf = (list: Change[]) => new Set(list.map(shareKey).filter((k) => k !== null));
  const edited = keysOf(changes.filter((c) => blocked.has(c.row.plaid_id)));
  const recalculated = keysOf(changes.filter((c) => isOpening(c.row.plaid_id)));
  for (const c of changes) {
    const k = shareKey(c);
    if (k !== null && edited.has(k) && recalculated.has(k)) blocked.add(c.row.plaid_id);
  }
  for (const cash of changes.filter(isCashOpening)) {
    const unbalanced = changes.some((c) => c !== cash && c.row.account_id === cash.row.account_id
      && blocked.has(c.row.plaid_id) && c.movesCash());
    if (unbalanced) blocked.add(cash.row.plaid_id);
  }
  return blocked;
}

export function keepProtected(p: Plan, state: MemoryLedger, held: Held): { updates: Plan["updates"]; voids: LedgerRow[] } {
  recordMadeByUser(p, state, held);
  const changes = [...p.updates.map(updateChange), ...p.voids.map(voidChange),
    ...p.new.filter((a) => isOpening(a.plaidId)).map(newChange)];
  const direct = new Set([...p.updates.map(([r]) => r), ...p.voids].filter((r) => isProtected(r, held)).map((r) => r.plaid_id));
  const blocked = blockedOpenings(changes, direct);
  const kept = { updates: p.updates.filter(([r]) => blocked.has(r.plaid_id)), voids: p.voids.filter((r) => blocked.has(r.plaid_id)) };
  p.updates = p.updates.filter(([r]) => !blocked.has(r.plaid_id));
  p.voids = p.voids.filter((r) => !blocked.has(r.plaid_id));
  p.new = p.new.filter((a) => !blocked.has(a.plaidId));
  return kept;
}
