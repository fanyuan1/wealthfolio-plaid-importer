import { entryAt, errText, required } from "./at";
import type { Dec } from "./dec";
import type { Ledger, LedgerField, LedgerRow } from "./ledger";
import { Activity, type OnProgress } from "./models";
import type { AccountCfg, Plan } from "./plan";

export const IMPORT_CHUNK = 500;
export const SMALL_CHUNK = 100;

export class WealthfolioError extends Error {}

export interface ImportRow {
  lineNumber: number;
  accountId: string;
  date: string;
  activityType: string;
  currency: string;
  comment?: string;
  symbol?: string;
  instrumentType?: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  fee?: number;
  tax?: number;
  subtype?: string;
  isExternal?: boolean;
  quoteMode?: "MANUAL";
  symbolName?: string;
}

interface UpdateFields {
  activityType?: string;
  date?: string;
  symbol?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
  fee?: number | null;
  currency?: string;
}

export interface Update extends UpdateFields {
  activityId: string | null;
  void?: boolean;
}

export interface Writer {
  commitImport(rows: ImportRow[]): Promise<Map<number, [string, string | null, string?]>>;
  update(updates: Update[]): Promise<{ errors?: { index: number; message: string }[] }[]>;
  delete(ids: string[]): Promise<void>;
  linkTransfers(pairs: [string, string][]): Promise<void>;
  categoryIds(): Promise<Map<string, string>>;
  setCategories(assignments: { activityId: string; taxonomyId: string; categoryId: string }[]): Promise<void>;
  rerunRules(): Promise<number>;
}

const num = (v: Dec | null): number | null => (v === null ? null : v.toNumber());

export function toImportRow(a: Activity, wfAccountId: string, line: number): ImportRow {
  const [quantity, unitPrice, amount, fee, tax] = [num(a.quantity), num(a.unitPrice), num(a.amount), num(a.fee), num(a.tax)];
  const row: ImportRow = {
    lineNumber: line, accountId: wfAccountId, date: a.date, activityType: a.activityType, currency: a.currency, comment: a.comment,
    ...(a.symbol !== null && { symbol: a.symbol }), ...(a.instrumentType !== null && { instrumentType: a.instrumentType }),
    ...(quantity !== null && { quantity }), ...(unitPrice !== null && { unitPrice }), ...(amount !== null && { amount }),
    ...(fee !== null && { fee }), ...(tax !== null && { tax }), ...(a.subtype !== null && { subtype: a.subtype }),
    ...(a.isExternal && { isExternal: true }),
  };
  if (a.quoteManual) {
    row.quoteMode = "MANUAL";
    const name = a.symbolName || a.symbol;
    if (name !== null) row.symbolName = name;
  }
  return row;
}

export const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export interface PushStats {
  imported: number; duplicates: number; failed: number; updated: number; voided: number; linked: number;
  categorized: number; ruled: number;
  failures: string[];
  refused: Record<string, string>;
}

type Log = (msg: string) => void;

type CategoryAssignment = [string, { activityId: string; taxonomyId: string; categoryId: string }];

async function setCategoryChunk(wf: Writer, chunk: CategoryAssignment[], errors: Map<string, string[]>): Promise<CategoryAssignment[]> {
  try {
    await wf.setCategories(chunk.map(([, a]) => a));
    return chunk;
  } catch {
    const ok: CategoryAssignment[] = [];
    for (const [pid, a] of chunk) {
      try {
        await wf.setCategories([a]);
        ok.push([pid, a]);
      } catch (e) {
        const msg = errText(e).slice(0, 200);
        errors.set(msg, [...(errors.get(msg) ?? []), pid]);
      }
    }
    return ok;
  }
}

export async function assignCategories(wf: Writer, state: Ledger, categories: Map<string, [string, string]>, log: Log): Promise<number> {
  const ids = await wf.categoryIds();
  const todo: CategoryAssignment[] = [];
  for (const [pid, [tax, key]] of categories) {
    const row = state.get(pid);
    const cid = ids.get(`${tax}|${key}`) ?? ids.get(`${tax}|${key.split("_")[0]}`);
    if (row && row.wf_activity_id && cid) todo.push([pid, { activityId: row.wf_activity_id, taxonomyId: tax, categoryId: cid }]);
  }
  let done = 0;
  const errors = new Map<string, string[]>();
  for (const chunk of chunks(todo, SMALL_CHUNK)) {
    const ok = await setCategoryChunk(wf, chunk, errors);
    for (const [pid] of ok) state.setCategory(pid);
    done += ok.length;
    state.commit();
  }
  for (const [msg, pids] of errors) log(`  categories not set on ${pids.length} rows: ${msg}`);
  if (errors.size) log("  Turn on Spending for those accounts, then categorize again");
  return done;
}

export interface PushOptions {
  accounts: Record<string, AccountCfg>;
  log: Log;
  rows?: ImportRow[] | undefined;
  progress?: OnProgress;
}

export async function push(p: Plan, wf: Writer, state: Ledger, opts: PushOptions): Promise<PushStats> {
  return new Pusher(p, wf, state, opts).run();
}

type UpdateSource =
  | { kind: "activity"; activity: Activity }
  | { kind: "void"; row: LedgerRow }
  | { kind: "pair"; pair: [string, string, string] };

const UPDATED: Record<LedgerField, (a: Activity) => UpdateFields> = {
  activity_type: (a) => ({ activityType: a.activityType }),
  date: (a) => ({ date: a.date }),
  symbol: (a) => ({ symbol: a.symbol }),
  quantity: (a) => ({ quantity: num(a.quantity) }),
  unit_price: (a) => ({ unitPrice: num(a.unitPrice) }),
  amount: (a) => ({ amount: num(a.amount) }),
  fee: (a) => ({ fee: num(a.fee) }),
  currency: (a) => ({ currency: a.currency }),
};

function activityUpdate(row: LedgerRow, a: Activity, fields: LedgerField[]): Update {
  const u: Update = { activityId: row.wf_activity_id };
  for (const f of fields) Object.assign(u, UPDATED[f](a));
  if (a.activityType === "SPLIT" && "quantity" in u) {
    delete u.quantity;
    u.amount = num(a.amount);
  }
  return u;
}

class Pusher {
  private readonly stats: PushStats = { imported: 0, duplicates: 0, failed: 0, updated: 0, voided: 0, linked: 0, categorized: 0, ruled: 0, failures: [], refused: {} };
  private readonly progress: OnProgress;
  private readonly log: Log;

  constructor(private readonly p: Plan, private readonly wf: Writer, private readonly state: Ledger, private readonly opts: PushOptions) {
    this.progress = opts.progress ?? (() => {});
    this.log = opts.log;
  }

  private step(id: string, label: string, run: boolean, detail?: string): void {
    this.progress({ id: `push:${id}`, label, state: run ? "running" : "done", detail });
  }

  async run(): Promise<PushStats> {
    const { p, state } = this;
    await this.addNew();
    const updates: [Update, UpdateSource][] = p.updates.map(([row, a, fields]) => [activityUpdate(row, a, fields), { kind: "activity", activity: a }]);
    const deleted = await this.deleteGone();
    for (const row of p.voids) if (!deleted.has(row)) updates.push([{ activityId: row.wf_activity_id, void: true }, { kind: "void", row }]);
    for (const [pid, atype, pair] of p.retype) {
      updates.push([{ activityId: required(state.get(pid), `ledger row ${pid}`).wf_activity_id, activityType: atype }, { kind: "pair", pair: [pid, atype, pair] }]);
    }
    if (updates.length) await this.applyUpdates(updates);
    await this.linkPairs();
    await this.categorize();

    for (const [itemId, cur] of Object.entries(p.cursors)) state.setCursor(itemId, cur);
    for (const [aid, d] of Object.entries(p.invLastEnd)) state.setInvLastEnd(aid, d);
    for (const aid of p.fullHistory) state.setFullHistory(aid);
    state.commit();
    return this.stats;
  }

  private async addNew(): Promise<void> {
    const { p, stats, state } = this;
    const byLine = new Map(p.new.map((a, i) => [i + 1, a] as const));
    const rows = this.opts.rows ?? [...byLine].map(([n, a]) => toImportRow(a, this.opts.accounts[a.accountId]?.wealthfolio_account_id ?? "", n));
    if (!rows.length) return;
    this.step("add", "Add new activities", true, `${rows.length} rows`);
    const results = await this.wf.commitImport(rows);
    for (const [line, [status, wfId, why]] of results) {
      const a = entryAt(byLine, line);
      if ((status === "imported" || status === "duplicate_skipped") && wfId) {
        state.record(a, wfId);
        stats[status === "imported" ? "imported" : "duplicates"] += 1;
      } else {
        this.recordFailure(a, why);
      }
    }
    state.commit();
    this.progress({ id: "push:add", label: "Add new activities", state: stats.failed ? "warn" : "done",
      detail: `${stats.imported} added${stats.failed ? `, ${stats.failed} not saved` : ""}` });
  }

  private recordFailure(a: Activity, why: string | undefined): void {
    const { stats } = this;
    stats.failed += 1;
    const msg = `${a.date} ${a.activityType} ${a.symbol ?? ""} ${String(a.amount ?? "")} (plaid:${a.plaidId})${why ? ` — ${why}` : ""}`;
    stats.failures.push(msg);
    if (a.symbol) stats.refused[a.symbol] ??= why || "Wealthfolio did not save it";
    this.log(`  failed: ${msg}`);
  }

  private async deleteGone(): Promise<Set<LedgerRow>> {
    const gone = this.p.voids.filter((r) => !r.pair_plaid_id && r.wf_activity_id);
    if (!gone.length) return new Set();
    this.step("delete", "Delete rows removed at Plaid", true, `${gone.length} rows`);
    await this.wf.delete(gone.flatMap((r) => (r.wf_activity_id ? [r.wf_activity_id] : [])));
    for (const r of gone) this.state.setVoided(r.plaid_id, true);
    this.stats.voided += gone.length;
    this.state.commit();
    this.step("delete", "Delete rows removed at Plaid", false, `${gone.length} deleted`);
    return new Set(gone);
  }

  private async applyUpdates(updates: [Update, UpdateSource][]): Promise<void> {
    this.step("update", "Update changed activities", true, `${updates.length} rows`);
    const out = await this.wf.update(updates.map(([u]) => u));
    const failed = new Map<number, string>();
    out.forEach((r, n) => (r.errors ?? []).forEach((e) => failed.set(n * SMALL_CHUNK + e.index, e.message)));
    updates.forEach(([u, src], idx) => {
      const failure = failed.get(idx);
      if (failure !== undefined) this.log(`  update failed for ${String(u.activityId)}: ${failure}`);
      else this.applyUpdate(u, src);
    });
    this.state.commit();
    this.progress({ id: "push:update", label: "Update changed activities", state: failed.size ? "warn" : "done",
      detail: `${updates.length - failed.size} updated${failed.size ? `, ${failed.size} failed` : ""}` });
  }

  private applyUpdate(u: Update, src: UpdateSource): void {
    if (src.kind === "void") {
      this.state.setVoided(src.row.plaid_id);
      this.stats.voided += 1;
    } else if (src.kind === "activity") {
      this.state.record(src.activity, String(u.activityId));
      this.stats.updated += 1;
    } else {
      this.state.setPair(...src.pair);
    }
  }

  private async linkPairs(): Promise<void> {
    const { p, state } = this;
    if (p.pairs.length) this.step("link", "Link transfers", true, `${p.pairs.length} pairs`);
    for (const [o, i] of p.pairs) {
      if (!(await this.linkPair(o, i))) continue;
      state.setPair(o, "TRANSFER_OUT", i);
      state.setPair(i, "TRANSFER_IN", o);
      this.stats.linked += 1;
    }
    state.commit();
    if (p.pairs.length) this.step("link", "Link transfers", false, `${this.stats.linked} linked`);
  }

  private async linkPair(o: string, i: string): Promise<boolean> {
    const ro = this.state.get(o), ri = this.state.get(i);
    if (!(ro && ri && ro.wf_activity_id && ri.wf_activity_id)) return false;
    try {
      await this.wf.linkTransfers([[ro.wf_activity_id, ri.wf_activity_id]]);
    } catch (e) {
      if (!errText(e).toLowerCase().includes("already")) {
        this.log(`  link failed ${o} <-> ${i}: ${errText(e)}`);
        return false;
      }
    }
    return true;
  }

  private async categorize(): Promise<void> {
    const { p, stats } = this;
    if (p.categories.size) {
      this.step("categories", "Set spending categories", true, `${p.categories.size} rows`);
      stats.categorized = await assignCategories(this.wf, this.state, p.categories, this.log);
      this.step("categories", "Set spending categories", false, `${stats.categorized} set`);
    }
    if (!stats.imported) return;
    try {
      stats.ruled = await this.wf.rerunRules();
    } catch (e) {
      if (!(e instanceof WealthfolioError)) throw e;
      this.log(`  categorization rules not applied: ${e.message}`);
    }
  }
}
