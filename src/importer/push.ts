// Push a plan to Wealthfolio and record it in the ledger, through a Writer (the addon SDK, or a fake in tests).
import type { Dec } from "./dec";
import type { Ledger, LedgerRow } from "./ledger";
import { Activity, type OnProgress } from "./models";
import type { AccountCfg, Plan } from "./plan";

export const IMPORT_CHUNK = 500; // server limit is 1000
export const SMALL_CHUNK = 100; // limit for updates, links, categories

export class WealthfolioError extends Error {}

export type ImportRow = Record<string, string | number | null>;
export type Update = Record<string, string | number | boolean | null>;

export interface Writer {
  /** {lineNumber: [status, activityId]}. Throws if a chunk fails validation. */
  commitImport(rows: ImportRow[]): Promise<Map<number, [string, string | null, string?]>>;
  /** One result per chunk of SMALL_CHUNK, with errors by index inside the chunk. */
  update(updates: Update[]): Promise<{ errors?: { index: number; message: string }[] }[]>;
  delete(ids: string[]): Promise<void>;
  linkTransfers(pairs: [string, string][]): Promise<void>;
  /** {`${taxonomyId}|${key}`: categoryId} */
  categoryIds(): Promise<Map<string, string>>;
  setCategories(assignments: { activityId: string; taxonomyId: string; categoryId: string }[]): Promise<void>;
  /** Apply the saved categorization rules to uncategorized rows. Returns the rows changed. */
  rerunRules(): Promise<number>;
}

const num = (v: Dec | null): number | null => (v === null ? null : v.toNumber());

export function toImportRow(a: Activity, wfAccountId: string, line: number): ImportRow {
  const row: ImportRow = {
    lineNumber: line, accountId: wfAccountId, date: a.date, activityType: a.activityType, currency: a.currency,
    symbol: a.symbol, instrumentType: a.instrumentType, quantity: num(a.quantity), unitPrice: num(a.unitPrice),
    amount: num(a.amount), fee: num(a.fee), tax: num(a.tax), subtype: a.subtype, comment: a.comment,
  };
  if (a.quoteManual) {
    row.quoteMode = "MANUAL";
    row.symbolName = a.symbolName || a.symbol;
  }
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
}

export const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export interface PushStats {
  imported: number; duplicates: number; failed: number; updated: number; voided: number; linked: number;
  categorized: number; ruled: number;
  failures: string[]; // one line per row Wealthfolio did not save, with the reason
  refused: Record<string, string>; // symbol -> Wealthfolio's reason, for rows it did not save
}

type Log = (msg: string) => void;

/** Set categories on pushed rows. A batch is all-or-nothing in Wealthfolio, so a failed batch is retried one
 * row at a time, so one bad row does not leave the others uncategorized. Returns how many were set. */
export async function assignCategories(wf: Writer, state: Ledger, categories: Map<string, [string, string]>, log: Log = console.log): Promise<number> {
  const ids = await wf.categoryIds();
  const todo: [string, { activityId: string; taxonomyId: string; categoryId: string }][] = [];
  for (const [pid, [tax, key]] of categories) {
    const row = state.get(pid);
    const cid = ids.get(`${tax}|${key}`) ?? ids.get(`${tax}|${key.split("_")[0]}`);
    if (row && row.wf_activity_id && cid) todo.push([pid, { activityId: row.wf_activity_id, taxonomyId: tax, categoryId: cid }]);
  }
  let done = 0;
  const errors = new Map<string, string[]>();
  for (const chunk of chunks(todo, SMALL_CHUNK)) {
    let ok = chunk;
    try {
      await wf.setCategories(chunk.map(([, a]) => a));
    } catch {
      ok = [];
      for (const [pid, a] of chunk) {
        try {
          await wf.setCategories([a]);
          ok.push([pid, a]);
        } catch (e) { // e.g. the account is not in Spending
          const msg = String((e as Error).message ?? e).slice(0, 200);
          errors.set(msg, [...(errors.get(msg) ?? []), pid]);
        }
      }
    }
    for (const [pid] of ok) state.setCategory(pid);
    done += ok.length;
    state.commit();
  }
  for (const [msg, pids] of errors) log(`  categories not set on ${pids.length} rows: ${msg}`);
  if (errors.size) log("  Turn on Spending for those accounts, then categorize again");
  return done;
}

/** rows: p.new as import rows, already resolved by the caller; built here when omitted. */
export async function push(p: Plan, wf: Writer, state: Ledger, accountsCfg: Record<string, AccountCfg>,
  log: Log = console.log, rows?: ImportRow[], progress: OnProgress = () => {}): Promise<PushStats> {
  const step = (id: string, label: string, run: boolean, detail?: string) =>
    progress({ id: `push:${id}`, label, state: run ? "running" : "done", detail });
  const stats: PushStats = { imported: 0, duplicates: 0, failed: 0, updated: 0, voided: 0, linked: 0, categorized: 0, ruled: 0, failures: [], refused: {} };
  const byLine = new Map(p.new.map((a, i) => [i + 1, a] as const));
  rows ??= [...byLine].map(([n, a]) => toImportRow(a, String(accountsCfg[a.accountId]?.wealthfolio_account_id ?? ""), n));

  if (rows.length) {
    step("add", "Add new activities", true, `${rows.length} rows`);
    const results = await wf.commitImport(rows);
    for (const [line, [status, wfId, why]] of results) {
      const a = byLine.get(line)!;
      if ((status === "imported" || status === "duplicate_skipped") && wfId) {
        state.record(a, wfId);
        stats[status === "imported" ? "imported" : "duplicates"] += 1;
      } else {
        stats.failed += 1;
        const msg = `${a.date} ${a.activityType} ${a.symbol ?? ""} ${a.amount ?? ""} (plaid:${a.plaidId})${why ? ` — ${why}` : ""}`;
        stats.failures.push(msg);
        if (a.symbol) stats.refused[a.symbol] ??= why || "Wealthfolio did not save it";
        log(`  failed: ${msg}`);
      }
    }
    state.commit();
    progress({ id: "push:add", label: "Add new activities", state: stats.failed ? "warn" : "done",
      detail: `${stats.imported} added${stats.failed ? `, ${stats.failed} not saved` : ""}` });
  }

  type Src = Activity | LedgerRow | [string, string, string];
  const updates: [Update, Src][] = [];
  for (const [row, a, fields] of p.updates) {
    const u: Update = { activityId: row.wf_activity_id };
    for (const f of fields) {
      const key = ({ activity_type: "activityType", unit_price: "unitPrice" } as Record<string, string>)[f] ?? f;
      const v = ({ activity_type: a.activityType, date: a.date, symbol: a.symbol, quantity: a.quantity,
        unit_price: a.unitPrice, amount: a.amount, fee: a.fee, currency: a.currency } as Record<string, unknown>)[f];
      u[key] = v != null && typeof v === "object" ? (v as Dec).toNumber() : (v as string | null);
    }
    if (a.activityType === "SPLIT" && "quantity" in u) {
      delete u.quantity;
      u.amount = num(a.amount);
    }
    updates.push([u, a]);
  }
  const gone = p.voids.filter((r) => !r.pair_plaid_id && r.wf_activity_id);
  if (gone.length) { // deleted, not voided: Spending counts voided rows
    step("delete", "Delete rows removed at Plaid", true, `${gone.length} rows`);
    await wf.delete(gone.map((r) => r.wf_activity_id!));
    for (const r of gone) state.setVoided(r.plaid_id, true);
    stats.voided += gone.length;
    state.commit();
    step("delete", "Delete rows removed at Plaid", false, `${gone.length} deleted`);
  }
  for (const row of p.voids) if (!gone.includes(row)) updates.push([{ activityId: row.wf_activity_id, void: true }, row]);
  for (const [pid, atype, pair] of p.retype) {
    updates.push([{ activityId: state.get(pid)!.wf_activity_id, activityType: atype }, [pid, atype, pair]]);
  }
  if (updates.length) {
    step("update", "Update changed activities", true, `${updates.length} rows`);
    const out = await wf.update(updates.map(([u]) => u));
    const failed = new Map<number, string>();
    out.forEach((r, n) => (r.errors ?? []).forEach((e) => failed.set(n * SMALL_CHUNK + e.index, e.message)));
    updates.forEach(([u, src], idx) => {
      if (failed.has(idx)) log(`  update failed for ${u.activityId}: ${failed.get(idx)}`);
      else if (u.void) {
        state.setVoided((src as LedgerRow).plaid_id);
        stats.voided += 1;
      } else if (src instanceof Activity) {
        state.record(src, String(u.activityId));
        stats.updated += 1;
      } else state.setPair(...(src as [string, string, string]));
    });
    state.commit();
    progress({ id: "push:update", label: "Update changed activities", state: failed.size ? "warn" : "done",
      detail: `${updates.length - failed.size} updated${failed.size ? `, ${failed.size} failed` : ""}` });
  }
  if (p.pairs.length) step("link", "Link transfers", true, `${p.pairs.length} pairs`);

  for (const [o, i] of p.pairs) {
    const ro = state.get(o), ri = state.get(i);
    if (!(ro && ri && ro.wf_activity_id && ri.wf_activity_id)) continue;
    try {
      await wf.linkTransfers([[ro.wf_activity_id, ri.wf_activity_id]]);
    } catch (e) { // Wealthfolio may have auto-linked same-day pairs
      if (!String((e as Error).message ?? e).toLowerCase().includes("already")) {
        log(`  link failed ${o} <-> ${i}: ${(e as Error).message ?? e}`);
        continue;
      }
    }
    state.setPair(o, "TRANSFER_OUT", i);
    state.setPair(i, "TRANSFER_IN", o);
    stats.linked += 1;
  }
  state.commit();
  if (p.pairs.length) step("link", "Link transfers", false, `${stats.linked} linked`);

  if (p.categories.size) {
    step("categories", "Set spending categories", true, `${p.categories.size} rows`);
    stats.categorized = await assignCategories(wf, state, p.categories, log);
    step("categories", "Set spending categories", false, `${stats.categorized} set`);
  }
  if (stats.imported) {
    // Wealthfolio applies the user's own rules only on a rerun, never to rows imported from outside.
    try {
      stats.ruled = await wf.rerunRules();
    } catch (e) {
      if (!(e instanceof WealthfolioError)) throw e;
      log(`  categorization rules not applied: ${e.message}`);
    }
  }

  for (const [itemId, cur] of Object.entries(p.cursors)) state.setCursor(itemId, cur);
  for (const [aid, d] of Object.entries(p.invLastEnd)) state.setInvLastEnd(aid, d);
  state.commit();
  return stats;
}
