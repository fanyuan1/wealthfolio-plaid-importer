// The Plaid -> Wealthfolio ledger and sync cursors, kept in the addon's own storage. plan() only reads it.
import { D, type Dec, dec } from "./dec";
import { Activity } from "./models";

/** One ledger row. Decimal fields are strings. */
export interface LedgerRow {
  plaid_id: string;
  account_id: string;
  wf_activity_id: string | null;
  activity_type: string;
  date: string;
  symbol: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string | null;
  fee: string | null;
  currency: string;
  transfer_hint: number;
  pair_plaid_id: string | null;
  category_set: number;
  voided: number;
  adopted?: number; // 1: the row was already in Wealthfolio before the importer; the importer never changes or deletes it
}

export interface Ledger {
  cursor(itemId: string): string | null;
  setCursor(itemId: string, cursor: string): void;
  invLastEnd(accountId: string): string | null;
  setInvLastEnd(accountId: string, day: string): void;
  hasOpening(accountId: string): boolean;
  hasAny(accountId: string): boolean;
  historyStart(): string | null;
  openingDate(accountId: string): string | null;
  get(plaidId: string): LedgerRow | null;
  record(a: Activity, wfId: string | null, categorySet?: boolean): void;
  setPair(plaidId: string, activityType: string, pair: string): void;
  setVoided(plaidId: string, deleted?: boolean): void;
  forget(plaidIds: string[], accountIds: Set<string>): void;
  resetCursor(itemId: string): void;
  setCategory(plaidId: string): void;
  /** Ledger rows as Activities (not voided). */
  activities(accountIds?: Set<string> | null, unpairedSince?: string | null): Activity[];
  commit(): void;
}

export const FIELDS = ["activity_type", "date", "symbol", "quantity", "unit_price", "amount", "fee", "currency"] as const;
const NUMERIC = new Set(["quantity", "unit_price", "amount", "fee"]);
// A fixed scale, finer than Plaid or Wealthfolio shows, so rounding noise is not a change.
export const COMPARE_DP = 8;

const str = (v: Dec | null): string | null => (v === null ? null : v.toFixed());

export function toLedgerRow(a: Activity, wfId: string | null, categorySet = false): LedgerRow {
  return {
    plaid_id: a.plaidId, account_id: a.accountId, wf_activity_id: wfId, activity_type: a.activityType, date: a.date,
    symbol: a.symbol, quantity: str(a.activityType === "SPLIT" ? a.splitDelta : a.quantity),
    unit_price: str(a.unitPrice), amount: str(a.amount), fee: str(a.fee), currency: a.currency,
    transfer_hint: a.transferHint ? 1 : 0, pair_plaid_id: a.pairId, category_set: categorySet ? 1 : 0, voided: 0,
  };
}

export function rowToActivity(r: LedgerRow): Activity {
  return new Activity({
    accountId: r.account_id, plaidId: r.plaid_id, date: r.date, activityType: r.activity_type, currency: r.currency,
    symbol: r.symbol, quantity: dec(r.quantity), unitPrice: dec(r.unit_price), amount: dec(r.amount), fee: dec(r.fee),
    transferHint: Boolean(r.transfer_hint), pairId: r.pair_plaid_id,
    splitDelta: r.activity_type === "SPLIT" ? dec(r.quantity) : null,
  });
}

function norm(f: string, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (NUMERIC.has(f)) {
    const x = D(String(v)).round(COMPARE_DP, 2);
    return x.eq(0) ? "0" : x.toFixed(); // -0 equals 0
  }
  return String(v);
}

const activityField = (a: Activity, f: (typeof FIELDS)[number]): unknown => ({
  activity_type: a.activityType, date: a.date, symbol: a.symbol, quantity: a.quantity,
  unit_price: a.unitPrice, amount: a.amount, fee: a.fee, currency: a.currency,
})[f];

/** Fields where Plaid's current view differs from what we pushed. */
export function differs(row: LedgerRow, a: Activity): string[] {
  const out: string[] = [];
  for (const f of FIELDS) {
    if (f === "activity_type" && row.pair_plaid_id) continue; // we retyped it to a transfer leg ourselves
    let v = activityField(a, f);
    if (a.activityType === "SPLIT" && f === "quantity") v = a.splitDelta;
    if (a.activityType === "SPLIT" && f === "amount") v = row.amount; // the ratio depends on our own math
    if (norm(f, row[f]) !== norm(f, v)) out.push(f);
  }
  return out;
}

/** In-memory ledger: the addon's (loaded from and saved to addon storage) and the tests'. */
export class MemoryLedger implements Ledger {
  rows = new Map<string, LedgerRow>();
  cursors = new Map<string, string>();
  invSync = new Map<string, string>();

  constructor(data?: { rows?: LedgerRow[]; cursors?: Record<string, string>; invSync?: Record<string, string> }) {
    for (const r of data?.rows ?? []) this.rows.set(r.plaid_id, r);
    for (const [k, v] of Object.entries(data?.cursors ?? {})) this.cursors.set(k, v);
    for (const [k, v] of Object.entries(data?.invSync ?? {})) this.invSync.set(k, v);
  }

  toJSON() {
    return { rows: [...this.rows.values()], cursors: Object.fromEntries(this.cursors), invSync: Object.fromEntries(this.invSync) };
  }

  cursor(itemId: string) { return this.cursors.get(itemId) ?? null; }
  setCursor(itemId: string, cursor: string) { this.cursors.set(itemId, cursor); }
  invLastEnd(accountId: string) { return this.invSync.get(accountId) ?? null; }
  setInvLastEnd(accountId: string, day: string) { this.invSync.set(accountId, day); }
  private openings(accountId?: string) {
    return [...this.rows.values()].filter((r) => r.plaid_id.startsWith("opening:") && (!accountId || r.account_id === accountId));
  }
  hasOpening(accountId: string) { return this.openings(accountId).length > 0; }
  hasAny(accountId: string) { return [...this.rows.values()].some((r) => r.account_id === accountId); }
  historyStart() { return minDate(this.openings()); }
  openingDate(accountId: string) { return minDate(this.openings(accountId)); }
  get(plaidId: string) { return this.rows.get(plaidId) ?? null; }
  record(a: Activity, wfId: string | null, categorySet = false) {
    const row = toLedgerRow(a, wfId, categorySet);
    if (this.rows.get(a.plaidId)?.adopted) row.adopted = 1;
    this.rows.set(a.plaidId, row);
  }
  setPair(plaidId: string, activityType: string, pair: string) {
    const r = this.rows.get(plaidId);
    if (r) Object.assign(r, { activity_type: activityType, pair_plaid_id: pair });
  }
  setVoided(plaidId: string, deleted = false) {
    const r = this.rows.get(plaidId);
    if (r) Object.assign(r, { voided: 1 }, deleted ? { wf_activity_id: null } : {});
  }
  forget(plaidIds: string[], accountIds: Set<string>) {
    for (const p of plaidIds) this.rows.delete(p);
    for (const a of accountIds) this.invSync.delete(a);
  }
  resetCursor(itemId: string) { this.cursors.delete(itemId); }
  setCategory(plaidId: string) {
    const r = this.rows.get(plaidId);
    if (r) r.category_set = 1;
  }
  activities(accountIds?: Set<string> | null, unpairedSince?: string | null): Activity[] {
    return [...this.rows.values()]
      .filter((r) => !r.voided && (!unpairedSince || (r.pair_plaid_id === null && r.transfer_hint && r.date >= unpairedSince))
        && (!accountIds || accountIds.has(r.account_id)))
      .map(rowToActivity);
  }
  commit() {}
}

/** Accounts the ledger holds rows for but Wealthfolio has no activity in: wiped there. Forget their rows and their
 * Item's cursor, so the next pull starts from scratch and pushes everything again. counts: activities per Wealthfolio account. */
export function forgetEmptied(state: MemoryLedger, cfg: Record<string, { item_id: string; wealthfolio_account_id?: string | null }>,
  counts: Map<string, number>): { accounts: string[]; rows: number } {
  const accounts: string[] = [];
  let rows = 0;
  for (const [aid, c] of Object.entries(cfg)) {
    if (!c.wealthfolio_account_id || counts.get(c.wealthfolio_account_id) !== 0) continue;
    const ids = [...state.rows.values()].filter((r) => r.account_id === aid).map((r) => r.plaid_id);
    if (!ids.length) continue;
    state.forget(ids, new Set([aid]));
    state.resetCursor(c.item_id);
    accounts.push(aid);
    rows += ids.length;
  }
  return { accounts, rows };
}

function minDate(rows: LedgerRow[]): string | null {
  return rows.length ? rows.map((r) => r.date).reduce((m, d) => (d < m ? d : m)) : null;
}
