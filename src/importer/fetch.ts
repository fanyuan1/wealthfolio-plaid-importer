// Fetch every linked Item from Plaid. One broken Item never stops the others.
import type { Ledger } from "./ledger";
import type { OnProgress, Row } from "./models";
import { type AccountCfg, accountLabel, activeAccounts, addDays, BLOCKING_ITEM_ERRORS, HISTORY_DAYS, type ItemData, OVERLAP_DAYS } from "./plan";
import { type Plaid, PlaidError } from "./plaid";

/** A linked Item with its access token. */
export interface Token { owner: string; institution_name: string; access_token: string; products?: string[]; env?: string; [k: string]: unknown }

export interface FetchResult {
  items: ItemData[];
  skipped: string[]; // labels of Items not pulled
  blocked: string[]; // Item ids whose login expired: they need a reconnect
  pulledAt?: number; // set by the engine, which reuses a recent pull
}

type Log = (msg: string) => void;
export const RECONNECT_DETAIL = "Login expired. Reconnect it in Connections.";

/** tracked: security_ids of funds held by exchange ratio; their accounts get full history each time, so a
 * new ratio updates the quantities already pushed. full: more investment accounts to pull in full. */
export async function fetchItems(plaid: Plaid, tokens: Record<string, Token>, accountsCfg: Record<string, AccountCfg>,
  state: Ledger, today: string, opts: { log?: Log; full?: Set<string>; tracked?: Set<string>;
    progress?: OnProgress } = {}): Promise<FetchResult> {
  const log = opts.log ?? console.log;
  const progress = opts.progress ?? (() => {});
  const out: FetchResult = { items: [], skipped: [], blocked: [] };
  for (const [itemId, tok] of Object.entries(tokens)) {
    const label = `${tok.owner} · ${tok.institution_name}`;
    const accts = activeAccounts(accountsCfg, itemId);
    if (!Object.keys(accts).length) {
      log(`  ${label}: no active accounts`);
      continue;
    }
    progress({ id: itemId, label, state: "running", detail: "Checking the connection" });
    let item: Row;
    try {
      item = (await plaid.item(tok.access_token)).item ?? {};
    } catch (e) {
      if (!(e instanceof PlaidError)) throw e;
      item = { error: { error_code: e.code } };
    }
    const err = item.error;
    if (err && BLOCKING_ITEM_ERRORS.has(err.error_code)) {
      log(`  ${label}: needs a reconnect (${err.error_code})`);
      out.skipped.push(label);
      out.blocked.push(itemId);
      progress({ id: itemId, label, state: "error", detail: RECONNECT_DETAIL });
      continue;
    }
    try {
      out.items.push(await fetchItem(plaid, itemId, tok, accts, state, today, label, log, opts.full ?? new Set(), opts.tracked ?? new Set(), progress));
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

async function fetchItem(plaid: Plaid, itemId: string, tok: Token, accts: Record<string, AccountCfg>, state: Ledger,
  today: string, label: string, log: Log, fullAccts: Set<string>, tracked: Set<string>, progress: OnProgress = () => {}): Promise<ItemData> {
  const d: ItemData = { itemId, owner: tok.owner, institution: tok.institution_name, invStart: {} };
  let invIds = Object.keys(accts).filter((a) => accts[a].kind === "investment");
  if (invIds.length && !(tok.products ?? ["investments"]).includes("investments")) {
    // Plaid can list investment accounts on an Item that was linked without the investments product.
    log(`  ${label}: ${invIds.length} investment accounts skipped (${tok.institution_name} has no investments product in Plaid)`);
    invIds = [];
  }
  const bankIds = Object.keys(accts).filter((a) => accts[a].kind === "cash" || accts[a].kind === "credit");
  if (invIds.length) {
    d.holdings = await plaid.holdings(tok.access_token);
    const full = new Set([...fullAccts, ...(d.holdings.holdings ?? []).filter((h: Row) => tracked.has(h.security_id)).map((h: Row) => h.account_id)]);
    for (const aid of invIds) {
      const last = state.invLastEnd(aid);
      d.invStart[aid] = last && !full.has(aid) ? addDays(last, -OVERLAP_DAYS) : addDays(today, -HISTORY_DAYS);
    }
    const start = Object.values(d.invStart).reduce((m, s) => (s < m ? s : m));
    log(`  ${label}: investments ${start} .. ${today}`);
    const line = { id: `${itemId}:inv`, parent: itemId, label: names(accts, invIds) };
    progress({ ...line, state: "running", detail: `Investments since ${start}` });
    d.inv = await plaid.investmentTransactions(tok.access_token, start, today);
    progress({ ...line, state: "done", detail: `${d.inv?.investment_transactions?.length ?? 0} investment transactions` });
  }
  if (bankIds.length) {
    const cursor = state.cursor(itemId);
    d.firstTxSync = cursor === null;
    log(`  ${label}: transactions (${cursor === null ? "full history" : "since last sync"})`);
    const line = { id: `${itemId}:tx`, parent: itemId, label: names(accts, bankIds) };
    progress({ ...line, state: "running", detail: cursor === null ? "Transactions, full history" : "Transactions since the last sync" });
    d.tx = await plaid.transactionsSync(tok.access_token, cursor);
    if (d.firstTxSync) {
      d.balances = Object.fromEntries((await plaid.accounts(tok.access_token)).map((a) => [a.account_id, a.balances ?? {}]));
    }
    const n = (d.tx?.added?.length ?? 0) + (d.tx?.modified?.length ?? 0);
    progress({ ...line, state: "done", detail: `${n} transactions` });
  }
  return d;
}

const names = (accts: Record<string, AccountCfg>, ids: string[]) => ids.map((a) => accountLabel(accts, a)).join(", ");
