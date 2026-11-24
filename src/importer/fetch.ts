import { valueAt } from "./at";
import type { Ledger } from "./ledger";
import type { OnProgress } from "./models";
import { type AccountCfg, accountLabel, activeAccounts, addDays, BLOCKING_ITEM_ERRORS, HISTORY_DAYS, type ItemData, OVERLAP_DAYS } from "./plan";
import { type Plaid, PlaidError } from "./plaid";

export interface Token { owner: string; institution_name: string; access_token: string; products?: string[] | undefined; env?: string }

export interface FetchResult {
  items: ItemData[];
  skipped: string[];
  blocked: string[];
  pulledAt?: number;
}

type Log = (msg: string) => void;
export const RECONNECT_DETAIL = "Login expired. Reconnect it in Connections.";

export interface FetchRun {
  accounts: Record<string, AccountCfg>;
  state: Ledger;
  today: string;
  log: Log;
  full?: Set<string>;
  tracked?: Set<string>;
  progress?: OnProgress;
}

type ItemRun = Required<FetchRun> & { plaid: Plaid };

interface ItemRef {
  itemId: string;
  tok: Token;
  accts: Record<string, AccountCfg>;
  label: string;
}

export async function fetchItems(plaid: Plaid, tokens: Record<string, Token>, opts: FetchRun): Promise<FetchResult> {
  const run: ItemRun = { ...opts, plaid, full: opts.full ?? new Set(), tracked: opts.tracked ?? new Set(), progress: opts.progress ?? (() => {}) };
  const { log, progress } = run;
  const out: FetchResult = { items: [], skipped: [], blocked: [] };
  for (const [itemId, tok] of Object.entries(tokens)) {
    const label = `${tok.owner} · ${tok.institution_name}`;
    const accts = activeAccounts(run.accounts, itemId);
    if (!Object.keys(accts).length) {
      log(`  ${label}: no active accounts`);
      continue;
    }
    progress({ id: itemId, label, state: "running", detail: "Checking the connection" });
    const code = await itemError(plaid, tok.access_token);
    if (code !== null && BLOCKING_ITEM_ERRORS.has(code)) {
      log(`  ${label}: needs a reconnect (${code})`);
      out.skipped.push(label);
      out.blocked.push(itemId);
      progress({ id: itemId, label, state: "error", detail: RECONNECT_DETAIL });
      continue;
    }
    try {
      out.items.push(await fetchItem(run, { itemId, tok, accts, label }));
      progress({ id: itemId, label, state: "done" });
    } catch (e) {
      if (!(e instanceof PlaidError)) throw e;
      log(`  ${label}: skipped, Plaid error ${e.message}`);
      out.skipped.push(label);
      progress({ id: itemId, label, state: "error", detail: `Skipped: ${e.message}` });
    }
  }
  return out;
}

async function itemError(plaid: Plaid, accessToken: string): Promise<string | null> {
  try {
    return (await plaid.item(accessToken)).error?.error_code ?? null;
  } catch (e) {
    if (!(e instanceof PlaidError)) throw e;
    return e.code;
  }
}

async function fetchItem(run: ItemRun, ref: ItemRef): Promise<ItemData> {
  const { itemId, tok, accts, label } = ref;
  const d: ItemData = { itemId, owner: tok.owner, institution: tok.institution_name, invStart: {} };
  let invIds = Object.keys(accts).filter((a) => valueAt(accts, a).kind === "investment");
  if (invIds.length && !(tok.products ?? ["investments"]).includes("investments")) {
    run.log(`  ${label}: ${invIds.length} investment accounts skipped (${tok.institution_name} has no investments product in Plaid)`);
    invIds = [];
  }
  const bankIds = Object.keys(accts).filter((a) => valueAt(accts, a).kind === "cash" || valueAt(accts, a).kind === "credit");
  if (invIds.length) await fetchInvestments(run, ref, { d, invIds });
  if (bankIds.length) await fetchTransactions(run, ref, { d, bankIds });
  return d;
}

async function fetchInvestments(run: ItemRun, ref: ItemRef, { d, invIds }: { d: ItemData; invIds: string[] }): Promise<void> {
  const { plaid, state, today } = run;
  const { itemId, tok, accts, label } = ref;
  d.holdings = await plaid.holdings(tok.access_token);
  const full = new Set([...run.full, ...d.holdings.holdings.filter((h) => run.tracked.has(h.security_id)).map((h) => h.account_id)]);
  for (const aid of invIds) {
    const last = state.hasAny(aid) && state.hasFullHistory(aid) ? state.invLastEnd(aid) : null;
    d.invStart[aid] = last && !full.has(aid) ? addDays(last, -OVERLAP_DAYS) : addDays(today, -HISTORY_DAYS);
  }
  const start = Object.values(d.invStart).reduce((m, s) => (s < m ? s : m));
  run.log(`  ${label}: investments ${start} .. ${today}`);
  const line = { id: `${itemId}:inv`, parent: itemId, label: names(accts, invIds) };
  run.progress({ ...line, state: "running", detail: `Investments since ${start}` });
  d.inv = await plaid.investmentTransactions(tok.access_token, start, today);
  run.progress({ ...line, state: "done", detail: `${d.inv.investment_transactions.length} investment transactions` });
}

async function fetchTransactions(run: ItemRun, ref: ItemRef, { d, bankIds }: { d: ItemData; bankIds: string[] }): Promise<void> {
  const { plaid } = run;
  const { itemId, tok, accts, label } = ref;
  const cursor = run.state.cursor(itemId);
  d.firstTxSync = cursor === null;
  run.log(`  ${label}: transactions (${cursor === null ? "full history" : "since last sync"})`);
  const line = { id: `${itemId}:tx`, parent: itemId, label: names(accts, bankIds) };
  run.progress({ ...line, state: "running", detail: cursor === null ? "Transactions, full history" : "Transactions since the last sync" });
  d.tx = await plaid.transactionsSync(tok.access_token, cursor);
  if (d.firstTxSync) {
    d.balances = Object.fromEntries((await plaid.accounts(tok.access_token)).map((a) => [a.account_id, a.balances]));
  }
  const n = d.tx.added.length + d.tx.modified.length;
  run.progress({ ...line, state: "done", detail: `${n} transactions` });
}

const names = (accts: Record<string, AccountCfg>, ids: string[]) => ids.map((a) => accountLabel(accts, a)).join(", ");
