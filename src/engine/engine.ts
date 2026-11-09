// Everything the addon does, without React: connections, accounts, dry run, push, daily sync, repairs, backup.
import { type AccountCfg, accountName, type OnProgress, type Progress, assignCategories, Closes, D, discoverAccounts, entry, fetchItems, type FetchResult, type Adoption, type Existing, findAdoptions, forgetEmptied, matchById, holdsSecurities, jointCopies, planLinks, type HttpGet, jointOwners, addDays, HISTORY_DAYS, MemoryLedger, Plaid, type PlaidEnv, plan, type Plan, push, type PushStats, rebases, reportedPrice, resolve, type Row, todoReport, type Token, type Track, trackedIds, type Transport, WF_TYPE, withPrices, yahooFetch } from '../importer';
import { type Api, type AutoRun, type Daily, type ItemMeta, type RunRecord, Store } from './store';
import { SdkWriter } from './writer';

export type { AutoRun, Daily, ItemMeta, RunRecord } from './store';
export type { Progress } from '../importer';

const today = () => new Date().toISOString().slice(0, 10);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const RETRY_MS = 2 * 3600_000; // a failed daily sync tries again after this
const RUNS_KEPT = 7;
const PULL_REUSE_MS = 15 * 60_000; // a dry run reuses a Plaid pull this recent, unless asked for a fresh one
const REFRESH_MS = 24 * 3600_000; // an automatic account refresh runs at most this often per connection
export const DEFAULT_DAILY: Daily = { on: false, time: "07:00" };
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };
const AUTO_RATIO_LIMIT = 0.05; // the daily sync applies ratio changes up to 5%; bigger ones wait for the user
export const BACKUP_FORMAT = "plaid-importer-backup";

/** HTTPS through Wealthfolio's network broker: only hosts in manifest.json are allowed. */
export function brokerTransport(api: Api): Transport {
  return async (url, body, headers) => {
    const r = await api.network.request({ url, method: "POST", body, headers, timeoutSecs: 120 });
    return { status: r.status, body: r.body };
  };
}
export function brokerGet(api: Api): HttpGet {
  return async (url, headers) => {
    const r = await api.network.request({ url, method: "GET", headers, timeoutSecs: 30 });
    return { status: r.status, body: r.body };
  };
}

export class Engine {
  store: Store;
  /** What the Sync step shows; kept here so it survives leaving the page. */
  view: SyncView = EMPTY_VIEW;
  /** Work that outlives the screen that started it, by key. The last run stays until the next one starts. */
  tasks: Record<string, Task | undefined> = {};
  private listeners = new Set<() => void>();
  pageOpen = 0; // the daily sync waits while the user has the page open
  /** A Plaid login in progress; kept here so it survives leaving the page. itemId: a reconnect. */
  pendingLink?: { url: string; linkToken: string; owner: string; itemId?: string; started: number };
  lastLinked?: LinkCheck & { state: "done"; reconnect: boolean };
  /** The last Plaid pull, for dry runs right after it. key: what was pulled (connections, accounts, followed funds). */
  private pulled?: { key: string; fetched: FetchResult };
  constructor(private api: Api) {
    this.store = new Store(api);
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  };
  private emit() { for (const f of this.listeners) f(); }

  setView(patch: Partial<SyncView>) {
    this.view = { ...this.view, ...patch };
    this.emit();
  }

  /** Run fn as the task under key, recording its log, progress, result and error. One run per key at a time. */
  async task<T>(key: string, label: string, fn: (io: { log: (m: string) => void; progress: OnProgress }) => Promise<T>): Promise<T> {
    if (this.tasks[key]?.running) throw new Error("This is still running. Wait for it to finish.");
    let t: Task = { label, running: true, progress: [], log: [] };
    const set = (p: Partial<Task>) => { t = { ...t, ...p }; this.tasks[key] = t; this.emit(); };
    set({});
    try {
      const result = await fn({ log: (m) => set({ log: [...t.log, m] }), progress: (p) => set({ progress: addProgress(t.progress, p) }) });
      set({ running: false, result });
      return result;
    } catch (e) {
      set({ running: false, error: (e as Error).message });
      throw e;
    }
  }

  async plaid(): Promise<Plaid> {
    const { env } = await this.store.settings();
    const k = await this.store.keys(env);
    if (!k.clientId || !k.secret) throw new Error(`Add your Plaid ${env} keys first.`);
    return new Plaid(k.clientId, k.secret, env, brokerTransport(this.api));
  }

  /** A cheap Plaid call that only works with valid keys. */
  async checkKeys(): Promise<void> {
    try {
      await (await this.plaid()).call("/institutions/get", { count: 1, offset: 0, country_codes: ["US"] });
    } catch (e) {
      throw new Error(`Plaid did not accept these keys: ${(e as Error).message}`);
    }
  }

  // ---------- connect ----------

  /** Sandbox only: a test bank with no login page. */
  async connectSandbox(owner: string, institutionId = "ins_109508", products = ["transactions", "investments"]) {
    const plaid = await this.plaid();
    return this.finishLink(plaid, owner, await plaid.sandboxPublicToken(institutionId, products), products);
  }

  /** Plaid's hosted login page. Open the URL in a browser, then call finishHostedLink. */
  async startHostedLink(owner: string): Promise<{ url: string; linkToken: string }> {
    const plaid = await this.plaid();
    const r = await plaid.linkToken(`plaid-importer-${owner.toLowerCase()}`, ["transactions"], ["investments", "auth"], "US",
      undefined, { hosted_link: {} });
    if (!r.hosted_link_url) throw new Error("Plaid returned no hosted link. Ask Plaid support to enable Hosted Link for your account.");
    return { url: r.hosted_link_url, linkToken: r.link_token };
  }

  /** Asks Plaid whether the login on the hosted page finished. The page polls this: Plaid cannot call the addon. */
  async checkHostedLink(owner: string, linkToken: string): Promise<LinkCheck> {
    const plaid = await this.plaid();
    const r = await plaid.linkTokenGet(linkToken);
    for (const s of r.link_sessions ?? []) {
      const add = s.results?.item_add_results?.[0] ?? s.on_success;
      const pt = add?.public_token;
      if (pt) {
        const itemId = await this.finishLink(plaid, owner, pt, add.products ?? ["transactions", "investments"], add.institution);
        return this.linked(itemId);
      }
    }
    return exited(r.link_sessions ?? []);
  }

  /** checkHostedLink for update mode: the Item stays the same, so there is no token to exchange. */
  async checkReconnect(itemId: string, linkToken: string): Promise<LinkCheck> {
    const plaid = await this.plaid();
    const sessions: Row[] = (await plaid.linkTokenGet(linkToken)).link_sessions ?? [];
    if (sessions.some((s) => s.on_success || s.results)) {
      await this.markReconnect([], [itemId]);
      await this.refreshAccounts(itemId, false);
      return this.linked(itemId);
    }
    return exited(sessions);
  }

  private async linked(itemId: string): Promise<LinkCheck> {
    const { env } = await this.store.settings();
    const accounts = Object.values(await this.store.accounts(env)).filter((c) => c.item_id === itemId && WF_TYPE[c.kind]).length;
    return { state: "done", itemId, institution: (await this.store.items(env))[itemId]?.institution_name ?? "Bank", accounts };
  }

  /** Reconnect an Item whose login expired: update mode keeps the same Item, so no new Plaid connection. */
  async startReconnect(itemId: string): Promise<{ url: string; linkToken: string }> {
    const plaid = await this.plaid();
    const { env } = await this.store.settings();
    const meta = (await this.store.items(env))[itemId];
    const tok = await this.store.token(itemId);
    if (!meta || !tok) throw new Error("Unknown connection.");
    const r = await plaid.linkToken(`plaid-importer-${meta.owner.toLowerCase()}`, [], [], "US", tok, { hosted_link: {} });
    return { url: r.hosted_link_url, linkToken: r.link_token };
  }

  private async finishLink(plaid: Plaid, owner: string, publicToken: string, products: string[], institution?: Row): Promise<string> {
    const { env } = await this.store.settings();
    const ex = await plaid.exchange(publicToken);
    const item = (await plaid.item(ex.access_token)).item ?? {};
    const insId = institution?.institution_id ?? item.institution_id;
    let name = institution?.name;
    if (!name && insId) name = (await plaid.institution(insId).catch(() => null))?.name;
    await this.store.saveToken(ex.item_id, ex.access_token);
    const items = await this.store.items(env);
    items[ex.item_id] = { owner: owner.toUpperCase(), institution_name: name || "Bank", institution_id: insId,
      products: item.products ?? products, env };
    await this.store.saveItems(env, items);
    await this.refreshAccounts(ex.item_id);
    return ex.item_id;
  }

  /** New initials for a connection. Renames only the accounts not yet created in Wealthfolio:
   * names there belong to the user. Activities point to accounts by id, so they do not change. */
  async setOwner(itemId: string, owner: string) {
    const o = owner.trim().toUpperCase();
    if (!/^[A-Z]{1,4}$/.test(o)) throw new Error("Type 1 to 4 letters, for example AB.");
    const { env } = await this.store.settings();
    const items = await this.store.items(env);
    if (!items[itemId]) throw new Error("Unknown connection.");
    items[itemId] = { ...items[itemId], owner: o };
    await this.store.saveItems(env, items);
    const cfg = await this.store.accounts(env);
    for (const [aid, c] of Object.entries(cfg)) {
      if (c.item_id !== itemId) continue;
      c.owner = o;
      if (c.wealthfolio_account_id) continue;
      const taken = new Set(Object.entries(cfg).filter(([id]) => id !== aid).map(([, x]) => String(x.name)));
      c.name = accountName(o, String(c.institution ?? items[itemId].institution_name), c.plaid_name as string, c.mask as string, taken);
    }
    await this.store.saveAccounts(env, cfg);
  }

  async removeItem(itemId: string) {
    const { env } = await this.store.settings();
    const items = await this.store.items(env);
    delete items[itemId];
    await this.store.saveItems(env, items);
    const cfg = await this.store.accounts(env);
    for (const [aid, c] of Object.entries(cfg)) if (c.item_id === itemId) delete cfg[aid];
    await this.store.saveAccounts(env, cfg);
    await this.store.deleteToken(itemId);
  }

  /** Add a connection from an access token you already have, for example from another tool.
   * The token alone names the Item; Plaid returns its institution, products and accounts. Only the owner is asked. */
  async addToken(owner: string, accessToken: string): Promise<string> {
    const tok = accessToken.trim();
    const m = /^access-(sandbox|development|production)-[0-9a-f-]{36}$/.exec(tok);
    if (!m) throw new Error("An access token looks like access-production-1a2b3c4d-…, 36 characters after the second dash.");
    const { env } = await this.store.settings();
    if (m[1] !== env) throw new Error(`This is a ${m[1]} token, but the addon is in ${env}. Switch it in Setup first.`);
    if (!/^[A-Za-z]{1,4}$/.test(owner.trim())) throw new Error("Type the owner's initials, for example AB.");
    const plaid = await this.plaid();
    const item = (await plaid.item(tok)).item ?? {};
    if (!item.item_id) throw new Error("Plaid did not accept this token.");
    const items = await this.store.items(env);
    const insId = item.institution_id ?? undefined;
    const name = items[item.item_id]?.institution_name
      ?? (insId ? (await plaid.institution(insId).catch(() => null))?.name : null) ?? "Bank";
    await this.store.saveToken(item.item_id, tok);
    items[item.item_id] = { ...items[item.item_id], owner: owner.trim().toUpperCase(), institution_name: name,
      institution_id: insId, products: item.products ?? [], env, created: today() };
    await this.store.saveItems(env, items);
    await this.refreshAccounts(item.item_id);
    return item.item_id;
  }

  /** connections: connections and their access tokens only; it restores anywhere. full: also account selections,
   * securities settings, pending securities changes and the ledger (the last two only into the same Wealthfolio data). */
  async backup(kind: BackupKind): Promise<string> {
    const { env } = await this.store.settings();
    const items: Record<string, Row> = {};
    for (const [id, m] of Object.entries(await this.store.items(env))) {
      const t = await this.store.token(id);
      if (!t) continue;
      // Without its account selections, a restored connection must read its accounts again on the next visit to Accounts.
      const { checked, ...meta } = m;
      items[id] = { ...(kind === "full" ? m : meta), env, access_token: t };
    }
    const out: Row = { format: BACKUP_FORMAT, kind, env, items };
    if (kind === "full") Object.assign(out, { accounts: await this.store.accounts(env), symbols: await this.store.symbols(env),
      ledger: (await this.store.ledger(env)).toJSON(), remap: await this.store.remap(env) });
    return JSON.stringify(out);
  }

  /** Parse and check a backup for this environment. */
  private async readBackup(text: string): Promise<{ d: Row; env: PlaidEnv }> {
    let d: Row;
    try {
      d = JSON.parse(text.trim());
    } catch {
      throw new Error("This is not a Plaid Importer backup. Make one in Backup.");
    }
    if (d?.format !== BACKUP_FORMAT || (d.kind !== "connections" && d.kind !== "full")) throw new Error("This is not a Plaid Importer backup. Make one in Backup.");
    const { env } = await this.store.settings();
    if (d.env !== env) throw new Error(`This backup is for ${d.env}, but the addon is in ${env}. Switch it in Setup first.`);
    return { d, env };
  }

  /** What an overwrite would remove: the connections here that the backup does not have. */
  async overwriteLoss(text: string): Promise<string[]> {
    const { d, env } = await this.readBackup(text);
    return Object.entries(await this.store.items(env)).filter(([id]) => !d.items?.[id])
      .map(([, m]) => `${m.owner} · ${m.institution_name}`);
  }

  /** merge: what is already stored wins; the backup fills in the rest. overwrite: the backup replaces what it holds.
   * Connections it does not have are removed with their tokens, and so are their accounts. A full backup's ledger
   * and pending changes are used only when this Wealthfolio has at least one of its accounts: in other data the
   * ledger would say rows were pushed that are not there. */
  async restore(text: string, mode: "merge" | "overwrite" = "merge"): Promise<Restored> {
    const { d, env } = await this.readBackup(text);
    const over = mode === "overwrite";
    const full = d.kind === "full";
    const current = await this.store.items(env);
    const incoming = (d.items ?? {}) as Record<string, Row>;
    const removed = over ? Object.keys(current).filter((id) => !incoming[id]) : [];
    for (const id of removed) await this.store.deleteToken(id);
    const items: Record<string, ItemMeta> = over ? {} : current;
    for (const [id, tok] of Object.entries(incoming)) {
      const { access_token, ...meta } = tok;
      if (over || !current[id]) {
        await this.store.saveToken(id, access_token);
        items[id] = meta as ItemMeta;
      }
    }
    await this.store.saveItems(env, items);
    const backed = (d.accounts ?? {}) as Record<string, AccountCfg>;
    const here = await this.store.accounts(env);
    const kept = Object.fromEntries(Object.entries(here).filter(([, c]) => items[c.item_id]));
    await this.store.saveAccounts(env, over ? (full ? backed : kept) : { ...backed, ...here });
    await this.store.saveSymbols(env, over && full ? (d.symbols ?? {}) : { ...(d.symbols ?? {}), ...(await this.store.symbols(env)) });
    const out: Restored = { kind: d.kind, items: Object.keys(incoming).length, accounts: Object.keys(backed).length, rows: 0, ledger: "none", removed: removed.length };
    if (!full) return out;
    const wf = new Set((await this.wealthfolioAccounts()).map((a) => a.id));
    if (!Object.values(backed).some((c) => c.wealthfolio_account_id && wf.has(c.wealthfolio_account_id))) {
      out.ledger = "other-wealthfolio";
      return out;
    }
    if (over) {
      const state = new MemoryLedger(d.ledger ?? {});
      out.rows = state.rows.size;
      await this.store.saveLedger(env, state);
      await this.store.saveRemap(env, { full: d.remap?.full ?? [], dropped: d.remap?.dropped ?? {} });
      out.ledger = "restored";
      return out;
    }
    const state = await this.store.ledger(env);
    for (const r of d.ledger?.rows ?? []) if (!state.rows.has(r.plaid_id)) { state.rows.set(r.plaid_id, r); out.rows++; }
    for (const [k, v] of Object.entries(d.ledger?.cursors ?? {})) if (!state.cursors.has(k)) state.cursors.set(k, String(v));
    for (const [k, v] of Object.entries(d.ledger?.invSync ?? {})) if (!state.invSync.has(k)) state.invSync.set(k, String(v));
    await this.store.saveLedger(env, state);
    // Pending securities changes belong to that ledger's pushed rows.
    const remap = await this.store.remap(env);
    const dropped = { ...remap.dropped };
    for (const [sym, accts] of Object.entries((d.remap?.dropped ?? {}) as Record<string, string[]>)) dropped[sym] = [...new Set([...(dropped[sym] ?? []), ...accts])];
    await this.store.saveRemap(env, { full: [...new Set([...remap.full, ...(d.remap?.full ?? [])])], dropped });
    out.ledger = "restored";
    return out;
  }

  // ---------- accounts ----------

  /** Read an Item's accounts from Plaid; new ones are added unselected. Returns the new account ids.
   * identity: Plaid bills each Identity call, so automatic refreshes leave it out and keep the joint flags they have. */
  async refreshAccounts(itemId: string, identity = true): Promise<string[]> {
    const plaid = await this.plaid();
    const { env } = await this.store.settings();
    const meta = (await this.store.items(env))[itemId];
    const tok = (await this.store.token(itemId))!;
    const accts = await plaid.accounts(tok);
    const holdings = (meta.products ?? []).includes("investments") ? await plaid.holdings(tok).catch(() => null) : null;
    // Identity only if the Item has it already: calling it would ask the bank for new consent.
    const ident = identity && (meta.products ?? []).includes("identity") ? await plaid.identity(tok).catch(() => null) : null;
    const cfg = await this.store.accounts(env);
    const added = discoverAccounts(cfg, itemId, meta, accts, holdsSecurities(accts, holdings), jointOwners(ident));
    await this.store.saveAccounts(env, cfg);
    const items = await this.store.items(env);
    if (items[itemId]) {
      items[itemId] = { ...items[itemId], checked: new Date().toISOString() };
      await this.store.saveItems(env, items);
    }
    return added;
  }

  /** Flag connections whose login expired, and clear the flag on ones that worked. Connections shows it. */
  private async markReconnect(blocked: string[], ok: string[]) {
    const { env } = await this.store.settings();
    const items = await this.store.items(env);
    let changed = false;
    for (const [ids, on] of [[blocked, true], [ok, false]] as const) {
      for (const id of ids) {
        if (items[id] && Boolean(items[id].reconnect) !== on) { items[id] = { ...items[id], reconnect: on }; changed = true; }
      }
    }
    if (changed) await this.store.saveItems(env, items);
  }

  /** Refresh every connection not checked in the last day, without Identity. Errors are per connection. */
  async refreshStale(progress: OnProgress = () => {}, now = Date.now()): Promise<{ added: number; failed: string[] }> {
    const { env } = await this.store.settings();
    let added = 0;
    const failed: string[] = [];
    for (const [id, m] of Object.entries(await this.store.items(env))) {
      if (m.checked && now - Date.parse(m.checked) < REFRESH_MS) continue;
      const label = `${m.owner} · ${m.institution_name}`;
      progress({ id, label, state: "running", detail: "Checking accounts" });
      try {
        const n = (await this.refreshAccounts(id, false)).length;
        added += n;
        progress({ id, label, state: "done", detail: n ? `${n} new account${n === 1 ? "" : "s"}` : "No new accounts" });
      } catch (e) {
        const login = String(e).includes("ITEM_LOGIN_REQUIRED");
        if (login) await this.markReconnect([id], []);
        failed.push(label);
        progress({ id, label, state: "error", detail: login ? "Login expired. Reconnect it in Connections." : (e as Error).message });
      }
    }
    return { added, failed };
  }

  /** Forget Wealthfolio accounts that were deleted there. True when at least one account syncs and all of them exist. */
  async accountsReady(): Promise<boolean> {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    try {
      const ids = new Set((await this.api.accounts.getAll()).map((a) => a.id));
      let changed = false;
      for (const c of Object.values(cfg)) {
        if (c.wealthfolio_account_id && !ids.has(c.wealthfolio_account_id)) { c.wealthfolio_account_id = null; changed = true; }
      }
      if (changed) await this.store.saveAccounts(env, cfg);
    } catch { /* cannot reach Wealthfolio: keep what is stored */ }
    const active = Object.values(cfg).filter((c) => !c.skip && WF_TYPE[c.kind]);
    return active.length > 0 && active.every((c) => c.wealthfolio_account_id);
  }

  /** Wealthfolio accounts that have Spending on; null when it cannot be read. The SDK offers no way to change it. */
  async spendingAccounts(): Promise<Set<string> | null> {
    try {
      const c = await this.api.spending.getContext();
      return c.enabled ? new Set(c.accountIds) : new Set();
    } catch {
      return null;
    }
  }

  async setSync(accountId: string, on: boolean) {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    cfg[accountId].skip = !on;
    await this.store.saveAccounts(env, cfg);
  }

  /** Turn sync on or off for every supported account. A joint account linked under each owner is turned on once:
   * syncing both copies would count it twice. */
  async setSyncAll(on: boolean) {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    for (const c of Object.values(cfg)) if (WF_TYPE[c.kind]) c.skip = !on;
    if (on) for (const id of jointCopies(cfg)) cfg[id].skip = true;
    await this.store.saveAccounts(env, cfg);
  }

  /** Existing Wealthfolio accounts a Plaid account could be linked to. */
  async wealthfolioAccounts(): Promise<{ id: string; name: string; accountType: string; accountNumber?: string }[]> {
    try {
      return (await this.api.accounts.getAll()).map((a) => ({ id: a.id, name: a.name, accountType: a.accountType, accountNumber: a.accountNumber }));
    } catch {
      return [];
    }
  }

  /** Accounts the addon has pushed rows to. Their link is fixed: moving the rows would mean deleting and importing them again. */
  async pushedAccounts(): Promise<Set<string>> {
    const { env } = await this.store.settings();
    return new Set([...(await this.store.ledger(env)).rows.values()].map((r) => r.account_id));
  }

  /** Undo a link made by Create, so the row can pick another Wealthfolio account. Only before the first push to it.
   * A Wealthfolio account the addon created stays in Wealthfolio. */
  async unlinkAccount(accountId: string) {
    if ((await this.pushedAccounts()).has(accountId)) throw new Error("Rows were already pushed to this account, so its link cannot change.");
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    cfg[accountId].wealthfolio_account_id = null;
    delete cfg[accountId].match;
    await this.store.saveAccounts(env, cfg);
  }

  /** match: a Wealthfolio account id, "new", or none to take the closest name. */
  async setMatch(accountId: string, match: string | undefined) {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    if (match === undefined) delete cfg[accountId].match;
    else cfg[accountId].match = match;
    await this.store.saveAccounts(env, cfg);
  }

  /** Link or create the Wealthfolio account for each synced account that has none. */
  async createAccounts(): Promise<number> {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    const links = planLinks(cfg, await this.wealthfolioAccounts());
    let n = 0;
    for (const [aid, pick] of Object.entries(links)) {
      const c = cfg[aid];
      if (pick) {
        c.wealthfolio_account_id = pick;
        continue;
      }
      const made = await this.api.accounts.create({
        name: String(c.name), accountType: WF_TYPE[c.kind], group: String(c.owner ?? "") || null, currency: c.currency || "USD",
        accountNumber: (c.mask as string) || undefined, isDefault: false, isActive: true, trackingMode: "TRANSACTIONS",
      } as never);
      c.wealthfolio_account_id = made.id;
      n++;
    }
    await this.store.saveAccounts(env, cfg);
    return n;
  }

  // ---------- repair ----------

  /** Set Spending categories on pushed bank and card rows that have none. Pulls their full history again, so a
   * changed category mapping also reaches rows not yet categorized. */
  async categorize(log: (m: string) => void = () => {}): Promise<string> {
    const { env } = await this.store.settings();
    const plaid = await this.plaid();
    const bank = Object.fromEntries(Object.entries(await this.store.accounts(env))
      .filter(([, c]) => !c.skip && (c.kind === "cash" || c.kind === "credit")));
    const tokens: Record<string, Token> = {};
    for (const [id, m] of Object.entries(await this.store.items(env))) {
      const tok = await this.store.token(id);
      if (tok) tokens[id] = { ...m, access_token: tok } as Token;
    }
    const scratch = new MemoryLedger({}); // no cursors: the full transaction history
    const fetched = await fetchItems(plaid, tokens, bank, scratch, today(), { log: (m) => { if (!m.includes("no active accounts")) log(m); } });
    const p = plan(fetched.items, bank, {}, scratch, today(), undefined, () => null);
    const state = await this.store.ledger(env);
    const todo = new Map([...p.categories].filter(([pid]) => {
      const r = state.get(pid);
      return r !== null && Boolean(r.wf_activity_id) && !r.category_set;
    }));
    if (!todo.size) return "Every pushed bank and card row with a Plaid category already has one.";
    try {
      const n = await assignCategories(new SdkWriter(this.api, () => null), state, todo, log);
      return `Categorized ${n} of ${todo.size} rows.`;
    } finally {
      await this.store.saveLedger(env, state);
    }
  }

  // ---------- daily ----------

  /** The daily sync, run on a timer while Wealthfolio is open: once a day after the set time.
   * It applies small ratio changes and stops on anything that needs the user. Returns the run, or null if it did not run. */
  async autoSync(now = new Date()): Promise<RunRecord | null> {
    const [s, daily] = [await this.store.settings(), await this.store.daily()];
    if (!daily.on || this.tasks.daily?.running || this.pageOpen > 0) return null;
    if (now.getHours() * 60 + now.getMinutes() < minutes(daily.time)) return null;
    const rec = await this.store.autoRun(s.env);
    if (rec.done === localDay(now) || (rec.tried && now.getTime() - Date.parse(rec.tried) < RETRY_MS)) return null;
    return this.runDaily(now);
  }

  /** Run the daily sync now, whatever the time. Null if one is already running. */
  async runDaily(now = new Date()): Promise<RunRecord | null> {
    if (this.tasks.daily?.running) return null;
    const { env } = await this.store.settings();
    await this.store.saveAutoRun(env, { ...(await this.store.autoRun(env)), tried: now.toISOString() });
    const r = await this.task("daily", "run", (io) => this.daily(now, io.progress));
    const rec: AutoRun = await this.store.autoRun(env);
    // A run that pushed is done for the day, even if it stopped on something: the next try would push nothing new.
    await this.store.saveAutoRun(env, { ...rec, ...(r.totals ? { done: localDay(now) } : {}),
      runs: [r, ...(rec.runs ?? [])].slice(0, RUNS_KEPT) });
    return r;
  }

  /** When the next daily sync runs, or null when it is off. */
  async nextDaily(now = new Date()): Promise<Date | null> {
    const [s, daily] = [await this.store.settings(), await this.store.daily()];
    if (!daily.on) return null;
    const rec = await this.store.autoRun(s.env);
    const m = minutes(daily.time);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(m / 60), m % 60);
    if (rec.done === localDay(now)) at.setDate(at.getDate() + 1);
    else if (at < now) return new Date(Math.max(now.getTime(), rec.tried ? Date.parse(rec.tried) + RETRY_MS : 0));
    return at;
  }

  private async daily(now: Date, progress: OnProgress): Promise<RunRecord> {
    const time = now.toISOString();
    try {
      let d = await this.dryRun(() => {}, progress, true);
      const big: string[] = [];
      let applied = 0;
      for (const r of d.rebases) {
        if (r.next && r.change !== null && Math.abs(r.change) <= AUTO_RATIO_LIMIT) {
          await this.setSecurity(r.sid, r.name, { mode: "track", track: r.next });
          applied++;
        } else if (r.next) big.push(r.name);
      }
      if (applied) d = await this.replan(d);
      const open = d.adoptions.filter((a) => a.how !== "new").length;
      if (open) return { time, status: "stopped", goto: "sync", message: `${open} rows may already be in Wealthfolio. Review them in Sync.` };
      if (d.plan.moved.size) return { time, status: "stopped", goto: "sync", message: "Pushed activities now map to another ticker, to cash or to Leave out. Fix it in Sync." };
      const accounts = perAccount(d.plan, d.cfg);
      const stats = await this.pushAndCategorize(d, () => {}, progress);
      const totals = { new: stats.imported, updated: stats.updated, removed: stats.voided, categorized: stats.categorized, failed: stats.failed };
      const notes: string[] = [];
      if (big.length) notes.push(`Ratio change to confirm in Sync: ${big.join(", ")}`);
      if (stats.failed) notes.push(`${stats.failed} rows were not saved: ${stats.failures[0]}. Fix it in Sync`);
      if (d.fetched.skipped.length) notes.push(`Reconnect in Connections: ${d.fetched.skipped.join(", ")}`);
      // To-do items do not stop the run, but Sync shows them: it gets what is left after this push.
      if (d.plan.reviews.length) {
        notes.push("See the to-do list in Sync");
        const left = await this.afterPush(d);
        this.setView({ dry: left, secs: left.securities, stale: false, result: undefined, failed: stats.failures, refused: stats.refused });
      }
      const status = stats.failed || d.fetched.skipped.length ? "stopped" : "ok";
      return { time, status, accounts, totals, goto: d.fetched.skipped.length ? "connections" : stats.failed || big.length || d.plan.reviews.length ? "sync" : undefined,
        message: [summary(d.plan, d.fetched, stats), ...notes].join(". ") + "." };
    } catch (e) {
      return { time, status: "failed", message: (e as Error).message };
    }
  }

  // ---------- securities ----------

  /** Set how one security maps. Rows already pushed under another symbol, or now mapped to cash or Leave out, show up
   * as "moved" in the next dry run; a security that starts to be imported gets its full history. */
  async setSecurity(sid: string, name: string, o: SecurityChoice): Promise<Row> {
    const { env } = await this.store.settings();
    const symbols = await this.store.symbols(env);
    const before = { ...symbols };
    const keep = Object.fromEntries(Object.entries(symbols[sid] ?? {}).filter(([k]) => k === "instrument_type" || k === "multiplier"));
    const sym = o.symbol?.trim().toUpperCase() || null;
    const e: Row = { ...keep, name };
    if (o.mode === "auto") e.symbol = null;
    else if (o.mode === "ticker") {
      if (!sym) throw new Error("Type a ticker.");
      e.symbol = sym;
    } else if (o.mode === "manual") Object.assign(e, { symbol: sym, manual: true });
    else if (o.mode === "cash") e.cash = true;
    else if (o.mode === "holding") Object.assign(e, { investment: true, symbol: sym });
    else if (o.mode === "exclude") e.exclude = true;
    else if (o.mode === "track") {
      if (!o.track) throw new Error("Set the fund to follow first.");
      e.track = o.track;
    }
    symbols[sid] = e;
    await this.store.saveSymbols(env, symbols);
    await this.noteRemap(env, sid, before, symbols);
    return e;
  }

  /** Record what a securities change means for rows outside the next incremental pull (see Remap). Needs a pull
   * that saw the security; without one nothing was pushed for it yet. */
  private async noteRemap(env: PlaidEnv, sid: string, before: Record<string, Row>, after: Record<string, Row>) {
    let sec: Row | undefined;
    const accts = new Set<string>();
    for (const d of this.pulled?.fetched.items ?? []) {
      sec ??= d.inv?.securities?.[sid] ?? (d.holdings?.securities ?? []).find((s: Row) => s.security_id === sid);
      for (const h of d.holdings?.holdings ?? []) if (h.security_id === sid) accts.add(String(h.account_id));
      for (const t of d.inv?.investment_transactions ?? []) if (t.security_id === sid) accts.add(String(t.account_id));
    }
    if (!sec) return;
    const cur = sec.iso_currency_code || "USD";
    const [was, now] = [resolve(sec, before, cur), resolve(sec, after, cur)];
    const remap = await this.store.remap(env);
    if (now.kind === "security") {
      delete remap.dropped[now.symbol!]; // rows under this symbol are right again
      // Its older rows were never imported, and the 14-day pull would not reach them.
      if (was.kind !== "security") remap.full = [...new Set([...remap.full, ...accts])];
    }
    if (was.kind === "security" && (now.kind !== "security" || now.symbol !== was.symbol)) {
      const state = await this.store.ledger(env);
      const pushed = [...state.rows.values()].filter((r) => r.symbol === was.symbol && !r.voided && !r.adopted).map((r) => r.account_id);
      if (pushed.length) remap.dropped[was.symbol!] = [...new Set([...(remap.dropped[was.symbol!] ?? []), ...pushed])];
    }
    await this.store.saveRemap(env, remap);
  }

  /** Whether Wealthfolio's market data knows a ticker, asked live. */
  async validTicker(symbol: string): Promise<{ ok: boolean; name?: string; suggestions?: { symbol: string; name?: string }[] }> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return { ok: false };
    const hits = await this.api.market.searchTicker(sym);
    const hit = hits.find((h) => [h.symbol, h.canonicalSymbol, h.providerSymbol].some((x) => x?.toUpperCase() === sym));
    if (hit) return { ok: true, name: hit.longName || hit.shortName };
    // Not known under that spelling (a share class: BRK.B vs BRK-B): offer what Wealthfolio's search returned.
    return { ok: false, suggestions: hits.slice(0, 5).map((h) => ({ symbol: h.symbol, name: h.longName || h.shortName })) };
  }

  private tickerOk = new Map<string, boolean | null>(); // null: the lookup failed

  /** validTicker for many symbols, cached for the session. true: known, false: unknown, null: could not check. */
  async checkTickers(symbols: string[]): Promise<Record<string, boolean | null>> {
    const out: Record<string, boolean | null> = {};
    for (const sym of new Set(symbols)) {
      if (!this.tickerOk.has(sym)) {
        this.tickerOk.set(sym, await this.validTicker(sym).then((r) => r.ok).catch(() => null));
      }
      out[sym] = this.tickerOk.get(sym)!;
    }
    return out;
  }

  /** The exchange ratio for a fund held as units of a symbol it follows: price ÷ the symbol's close that day.
   * close: typed by the user; otherwise Yahoo Finance's close that day, or the closest day with one. */
  async ratio(target: string, day: string, price: string, close?: string): Promise<Track> {
    const sym = target.trim().toUpperCase();
    if (!sym) throw new Error("Type the ticker to follow, for example VOO.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) throw new Error("Type a past date as YYYY-MM-DD.");
    const num = (v: string, what: string) => {
      try {
        const d = D(v.trim());
        if (d.gt(0)) return d;
      } catch { /* not a number */ }
      throw new Error(`Type the ${what} as a number above 0, for example 104.25.`);
    };
    const p = num(price, "fund price");
    let c = close?.trim() ? num(close, "close") : null;
    let usedDay = day;
    if (!c) {
      const closes = new Closes(await this.store.prices(), yahooFetch(brokerGet(this.api)), today(), (x) => this.store.savePrices(x));
      await closes.load([[sym, day]]);
      const near = closes.nearest(sym, day);
      if (!near) throw new Error(`Yahoo Finance has no prices for ${sym}. Type the close from your broker.`);
      [c, usedDay] = [near.close, near.day];
    }
    return entry(sym, usedDay, p, c);
  }

  /** Delete a moved security's pushed activities in Wealthfolio and forget them, so the next push imports them
   * under the new symbol. Wealthfolio cannot move an activity to another asset. Returns the count. */
  async retrack(symbol: string, accountIds: Set<string>): Promise<number> {
    const { env } = await this.store.settings();
    const state = await this.store.ledger(env);
    const rows = [...state.rows.values()].filter((r) => r.symbol === symbol && accountIds.has(r.account_id) && !r.adopted);
    const ids = rows.map((r) => r.wf_activity_id).filter((x): x is string => Boolean(x));
    if (ids.length) await new SdkWriter(this.api, () => null).delete(ids);
    state.forget(rows.map((r) => r.plaid_id), new Set(rows.map((r) => r.account_id)));
    await this.store.saveLedger(env, state);
    // The next pull reads these accounts in full; their opening rows are rebuilt with the security as set now.
    const remap = await this.store.remap(env);
    delete remap.dropped[symbol];
    remap.full = [...new Set([...remap.full, ...accountIds])];
    await this.store.saveRemap(env, remap);
    return rows.length;
  }

  // ---------- sync ----------

  /** fresh: pull from Plaid even when a recent pull of the same accounts exists. The daily sync always pulls. */
  async dryRun(log: (m: string) => void, progress: OnProgress = () => {}, fresh = false): Promise<DryRun> {
    const { env } = await this.store.settings();
    const plaid = await this.plaid();
    const [metas, cfg, symbols, state] = [await this.store.items(env), await this.store.accounts(env),
      await this.store.symbols(env), await this.store.ledger(env)];
    const missing = Object.values(cfg).filter((c) => !c.skip && WF_TYPE[c.kind] && !c.wealthfolio_account_id);
    if (missing.length) throw new Error(`Create the Wealthfolio accounts first (${missing.length} missing).`);
    // An account wiped in Wealthfolio: the ledger still says its rows were pushed, so nothing would be pulled again.
    const counts = new Map<string, number>();
    const seen = new Set([...state.rows.values()].map((r) => r.account_id));
    for (const [aid, c] of Object.entries(cfg)) {
      if (!c.wealthfolio_account_id || !seen.has(aid) || counts.has(c.wealthfolio_account_id)) continue;
      try { counts.set(c.wealthfolio_account_id, (await this.api.activities.getAll(c.wealthfolio_account_id)).length); } catch { /* cannot read: leave it */ }
    }
    const wiped = forgetEmptied(state, cfg, counts);
    if (wiped.accounts.length) {
      log(`  ${wiped.accounts.map((a) => String(cfg[a].name)).join(", ")}: empty in Wealthfolio, so ${wiped.rows} remembered rows were forgotten and will be pulled again`);
      await this.store.saveLedger(env, state);
    }
    const tokens: Record<string, Token> = {};
    for (const [id, m] of Object.entries(metas)) {
      const t = await this.store.token(id);
      if (t) tokens[id] = { ...m, access_token: t } as Token;
    }
    const tracked = trackedIds(symbols);
    const full = new Set((await this.store.remap(env)).full);
    // Plan rows are keyed by Plaid id and checked against the ledger, so an older pull still plans right after a push.
    const key = JSON.stringify([env, Object.keys(tokens).sort(), Object.entries(cfg).filter(([, c]) => !c.skip).map(([a]) => a).sort(), [...tracked].sort(), [...full].sort()]);
    const reuse = !fresh && !wiped.accounts.length && this.pulled?.key === key && Date.now() - (this.pulled.fetched.pulledAt ?? 0) < PULL_REUSE_MS;
    let fetched: FetchResult;
    if (reuse) {
      fetched = this.pulled!.fetched;
      log(`  using the Plaid pull from ${new Date(fetched.pulledAt!).toLocaleTimeString()}`);
      progress({ id: "pull", label: "Plaid data", state: "done", detail: `Reused the pull from ${new Date(fetched.pulledAt!).toLocaleTimeString()}` });
    } else {
      fetched = await fetchItems(plaid, tokens, cfg, state, today(),
        { log, tracked, full, progress });
      fetched.pulledAt = Date.now();
      this.pulled = { key, fetched };
      await this.markReconnect(fetched.blocked, fetched.items.map((d) => d.itemId));
    }
    progress({ id: "plan", label: "Compare with Wealthfolio", state: "running", detail: "Prices, duplicates and changes" });
    const d = await this.planFrom(env, fetched, cfg, state, tracked);
    progress({ id: "plan", label: "Compare with Wealthfolio", state: "done" });
    return d;
  }

  /** After a push: plan what is left from the same pull, against the saved ledger. No Plaid call. Rows Wealthfolio
   * refused come back as new, so the user can fix them and push again without a new dry run. */
  async afterPush(d: DryRun): Promise<DryRun> {
    const [cfg, state] = [await this.store.accounts(d.env), await this.store.ledger(d.env)];
    return this.planFrom(d.env, d.fetched, cfg, state, trackedIds(await this.store.symbols(d.env)));
  }

  /** Plan again from the last dry run's Plaid data with the current securities settings: no new pull. */
  async replan(d: DryRun): Promise<DryRun> {
    const symbols = await this.store.symbols(d.env);
    const now = trackedIds(symbols);
    const added = new Set([...now].filter((sid) => !d.tracked.has(sid)));
    // The dry run's pull is incremental, but a new ratio rewrites a fund's whole history, and a security that starts
    // to be imported needs its older rows: pull just those accounts' history.
    const accts = new Set((await this.store.remap(d.env)).full);
    for (const item of d.fetched.items) {
      for (const h of item.holdings?.holdings ?? []) if (added.has(h.security_id)) accts.add(String(h.account_id));
    }
    await this.pullHistory(d, accts);
    return this.planFrom(d.env, d.fetched, d.cfg, d.state, now, d.adoptions);
  }

  /** Replace the investment pull of each Item with one of the accounts by its full history, unless it has it already.
   * Holdings stay cached. */
  private async pullHistory(d: DryRun, want: Set<string>) {
    let plaid: Plaid | undefined;
    const start = addDays(today(), -HISTORY_DAYS);
    for (const item of d.fetched.items) {
      const accts = new Set(Object.keys(item.invStart).filter((a) => want.has(a) && item.invStart[a] > start));
      const tok = accts.size ? await this.store.token(item.itemId) : null;
      if (!tok) continue;
      const full = await (plaid ??= await this.plaid()).investmentTransactions(tok, start, today());
      const from = item.invStart;
      full.investment_transactions = full.investment_transactions.filter((t: Row) => accts.has(t.account_id) || !from[t.account_id] || t.date >= from[t.account_id]);
      for (const a of accts) from[String(a)] = start;
      item.inv = full;
    }
  }

  private async planFrom(env: PlaidEnv, fetched: FetchResult, cfg: Record<string, AccountCfg>, state: MemoryLedger,
    tracked: Set<string>, prev: Adoption[] = []): Promise<DryRun> {
    const day = today();
    const symbols = await this.store.symbols(env);
    const closes = new Closes(await this.store.prices(), yahooFetch(brokerGet(this.api)), day, (c) => this.store.savePrices(c));
    const remap = await this.store.remap(env);
    // Rebuild openings only where this pull has the full history.
    const start = addDays(day, -HISTORY_DAYS);
    const backfill = new Set(remap.full.filter((a) => fetched.items.some((d) => d.invStart[a] !== undefined && d.invStart[a] <= start)));
    const p = await withPrices(closes, (c) => plan(fetched.items, cfg, symbols, state, day, backfill, c));
    for (const [sym, accts] of Object.entries(remap.dropped)) {
      const left = new Set(accts.filter((a) => [...state.rows.values()].some((r) => r.account_id === a && r.symbol === sym && !r.voided && !r.adopted)));
      if (left.size) p.moved.set(sym, new Set([...(p.moved.get(sym) ?? []), ...left]));
    }
    // A tracked fund whose institution reports a newer price: propose a new ratio from the same day's close.
    const asked: [string, string][] = [];
    for (const sid of trackedIds(symbols)) {
      const got = reportedPrice(fetched.items, sid);
      if (got) asked.push([symbols[sid].track.symbol, got[1]]);
    }
    await closes.load(asked);
    const proposals = rebases(fetched.items, symbols, closes).map((rb) => ({
      sid: rb.sid, name: rb.name, old: rb.old as Track, next: rb.next, day: rb.day, price: rb.price.toString(),
      change: rb.change?.toNumber() ?? null,
    }));
    if (p.unmapped.size) {
      for (const [sid, name] of p.unmapped) symbols[sid] ??= { name, symbol: null };
      await this.store.saveSymbols(env, symbols);
    }
    const names = Object.fromEntries(Object.entries(cfg).map(([id, c]) => [id, String(c.name)]));
    const adoptions = await this.adoptions(p, cfg, state, prev);
    const kept = await this.protect(p, cfg, state);
    return { env, plan: p, fetched, adoptions, todo: [...todoReport(p.reviews, names, closes.warnings()), ...kept.map((l) => (l.startsWith("  ") ? l : `\n${l}`))], state, cfg, tracked, backfill, rebases: proposals,
      securities: seenSecurities(fetched.items, symbols) };
  }

  /** Rows the plan would add that Wealthfolio already has. Decisions the user made before are kept. */
  private async adoptions(p: Plan, cfg: Record<string, AccountCfg>, state: MemoryLedger, prev: Adoption[]): Promise<Adoption[]> {
    const wfOf = (a: string) => cfg[a]?.wealthfolio_account_id ?? undefined;
    // Only an account the addon has never pushed to can already hold these rows from elsewhere.
    const synced = new Set([...state.rows.values()].map((r) => r.account_id));
    const accounts = new Set(p.new.map((a) => wfOf(a.accountId)).filter((x): x is string => Boolean(x)));
    if (!accounts.size) return [];
    const existing: Existing[] = [];
    for (const id of accounts) {
      for (const a of await this.api.activities.getAll(id)) {
        if (a.status === "VOID") continue;
        const d = a.date as unknown;
        existing.push({ id: a.id, accountId: a.accountId, type: String(a.activityType), symbol: a.assetSymbol || null,
          date: d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10),
          quantity: a.quantity, amount: a.amount, comment: a.comment ?? null });
      }
    }
    const taken = new Set([...state.rows.values()].map((r) => r.wf_activity_id).filter((x): x is string => Boolean(x)));
    // The ledger can lose track of rows Wealthfolio holds, for example after a restore without it. Their plaid:<id>
    // note is certain: link them as the importer's own, add nothing. Rows the user edited stay protected by protect().
    const known = matchById(p.new, existing.filter((e) => !taken.has(e.id)), wfOf);
    if (known.size) {
      for (const a of p.new) if (known.has(a.plaidId)) state.record(a, known.get(a.plaidId)!.id);
      p.new = p.new.filter((a) => !known.has(a.plaidId));
      p.categories = new Map([...p.categories].filter(([k]) => !known.has(k)));
    }
    const acts = p.new.filter((a) => !synced.has(a.accountId));
    const before = new Map(prev.map((a) => [a.key, a]));
    return findAdoptions(acts, existing, wfOf, taken).map((a) => {
      const was = before.get(a.key);
      return was && was.how === a.how ? { ...a, decision: was.decision } : a; // keep the user's choices across a replan
    });
  }

  /** Never change or delete an activity the user had before the importer or edited in Wealthfolio. Drops those
   * changes from the plan and lists them. Returns report lines. */
  private async protect(p: Plan, cfg: Record<string, AccountCfg>, state: MemoryLedger): Promise<string[]> {
    const touched = new Set<string>([...p.updates.map(([r]) => r.account_id), ...p.voids.map((r) => r.account_id),
      ...p.retype.map(([pid]) => state.get(pid)?.account_id ?? ""), ...p.pairs.flat().map((pid) => state.get(pid)?.account_id ?? "")]);
    const modified = new Set<string>();
    for (const aid of touched) {
      const w = cfg[aid]?.wealthfolio_account_id;
      if (w) for (const a of await this.api.activities.getAll(w)) if (a.isUserModified) modified.add(a.id);
    }
    const mine = (pid: string) => {
      const r = state.get(pid);
      return Boolean(r && (r.adopted || (r.wf_activity_id && modified.has(r.wf_activity_id))));
    };
    const name = (aid: string) => String(cfg[aid]?.name ?? aid);
    const lines: string[] = [];
    const keep = <T,>(list: T[], row: (x: T) => { plaid_id: string; account_id: string; date: string; activity_type: string }, what: (x: T) => string) =>
      list.filter((x) => {
        const r = row(x);
        if (!mine(r.plaid_id)) return true;
        lines.push(`  - ${name(r.account_id)}: ${r.date} ${r.activity_type} ${what(x)}`);
        return false;
      });
    p.updates = keep(p.updates, ([r]) => r, ([, , f]) => `changed at Plaid (${f.join(", ")})`);
    p.voids = keep(p.voids, (r) => r, () => "removed at Plaid");
    const rowOf = (pid: string) => state.get(pid)!;
    p.retype = keep(p.retype, ([pid]) => rowOf(pid), ([, t]) => `would become ${t}`);
    p.pairs = p.pairs.filter(([o, i]) => !(mine(o) || mine(i)));
    return lines.length ? [`Kept as they are in Wealthfolio (${lines.length})`,
      "  These were in Wealthfolio before the importer, or you edited them. The importer does not change or delete them. Edit or delete them in Wealthfolio if Plaid is right.", ...lines] : [];
  }

  /** Drop the rows the user discarded, and record them so a later pull does not offer them again. */
  private applyAdoptions(d: DryRun): Plan {
    const skip = new Set<string>();
    for (const a of d.adoptions) {
      const act = d.plan.new.find((x) => x.plaidId === a.plaidId);
      if (!act || a.decision !== "discard") continue;
      skip.add(a.plaidId);
      d.state.record(act, a.existing?.id ?? null, true); // an existing row keeps its category
      d.state.rows.get(a.plaidId)!.adopted = 1; // the importer never rewrites or deletes it
    }
    if (!skip.size) return d.plan;
    return { ...d.plan, new: d.plan.new.filter((x) => !skip.has(x.plaidId)),
      categories: new Map([...d.plan.categories].filter(([k]) => !skip.has(k))) };
  }

  async push(d: DryRun, log: (m: string) => void, progress: OnProgress = () => {}): Promise<PushStats> {
    const plan = this.applyAdoptions(d);
    const wfAccount = Object.fromEntries(Object.entries(d.cfg).map(([id, c]) => [id, c.wealthfolio_account_id ?? ""]));
    // Updates replace the whole activity, so the writer needs each row's account, type and date.
    const byWfId = () => new Map([...d.state.rows.values()].filter((r) => r.wf_activity_id)
      .map((r) => [r.wf_activity_id!, { accountId: wfAccount[r.account_id], activityType: r.activity_type, date: r.date, currency: r.currency || "USD" }]));
    let index = byWfId();
    const writer = new SdkWriter(this.api, (id) => (index.get(id) ?? (index = byWfId()).get(id)) ?? null);
    try {
      const stats = await push(plan, writer, d.state, d.cfg, log, undefined, progress);
      await this.store.saveLastSync(d.env, summary(d.plan, d.fetched, stats));
      // Done once every row went in; otherwise the next pull reads those accounts in full again.
      if (d.backfill.size && !stats.failed) {
        const remap = await this.store.remap(d.env);
        await this.store.saveRemap(d.env, { ...remap, full: remap.full.filter((a) => !d.backfill.has(a)) });
      }
      return stats;
    } finally {
      await this.store.saveLedger(d.env, d.state); // what was pushed is recorded even if a later step fails
      this.setView(EMPTY_VIEW);
    }
  }

  /** push, then fill in missing categories. A failure there never undoes the push. */
  async pushAndCategorize(d: DryRun, log: (m: string) => void, progress: OnProgress = () => {}): Promise<PushStats & { categories?: string }> {
    const stats: PushStats & { categories?: string } = await this.push(d, log, progress);
    try {
      const cfg = await this.store.accounts(d.env);
      const state = await this.store.ledger(d.env);
      const open = [...state.rows.values()].some((r) => !r.voided && r.wf_activity_id && !r.category_set && ["cash", "credit"].includes(cfg[r.account_id]?.kind));
      if (open) {
        progress({ id: "push:fill", label: "Fill in missing categories", state: "running" });
        stats.categories = await this.categorize(log);
        progress({ id: "push:fill", label: "Fill in missing categories", state: "done", detail: stats.categories });
      }
    } catch (e) {
      log(`  categories not filled in: ${(e as Error).message}`);
    }
    return stats;
  }
}

/** Every security in the pull, with how it maps now. Plaid gives investment securities keyed by id, holdings' as a list. */
export function seenSecurities(items: { inv?: Row | null; holdings?: Row | null }[], symbols: Record<string, Row>): Security[] {
  const out = new Map<string, Security>();
  for (const d of items) {
    for (const s of [...Object.values((d.inv?.securities ?? {}) as Record<string, Row>), ...((d.holdings?.securities ?? []) as Row[])]) {
      if (out.has(s.security_id)) continue;
      const r = resolve(s, symbols, s.iso_currency_code || "USD");
      const rp = reportedPrice(items, s.security_id);
      out.set(s.security_id, { sid: s.security_id, name: s.name || s.security_id, ticker: s.ticker_symbol ?? null,
        type: s.type ?? null, result: r.kind === "security" ? r.symbol! : r.kind, manual: r.manual,
        reported: rp ? [rp[0].toString(), rp[1]] : null, override: symbols[s.security_id] ?? null });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Proposal { sid: string; name: string; old: Track; next: Track | null; day: string; price: string; change: number | null }
/** A security seen in the last pull. result: the Wealthfolio symbol, or cash / exclude / unmapped. */
export interface Security {
  sid: string; name: string; ticker: string | null; type: string | null; result: string; manual: boolean;
  reported: [string, string] | null; override: Row | null;
  pending?: string; // saved after the dry run; shown until the next one
}
export type SecurityMode = "auto" | "ticker" | "manual" | "cash" | "holding" | "exclude" | "track";
export interface SecurityChoice { mode: SecurityMode; symbol?: string; track?: Track }
export interface DryRun {
  env: PlaidEnv; plan: Plan; fetched: FetchResult; todo: string[]; state: MemoryLedger; cfg: Record<string, AccountCfg>;
  tracked: Set<string>; // funds that followed a ticker when Plaid was pulled
  backfill: Set<string>; // accounts whose opening rows this plan rebuilt (Remap.full)
  rebases: Proposal[]; securities: Security[];
  adoptions: Adoption[]; // first-sync accounts: every new row, with how it compares to Wealthfolio
}

export interface Task { label: string; running: boolean; progress: Progress[]; log: string[]; result?: unknown; error?: string }
/** failed: rows Wealthfolio did not save in the last push. refused: symbols whose rows Wealthfolio did not save in the last push, with its reason. */
export interface SyncView { dry?: DryRun; secs: Security[]; stale: boolean; result?: string; failed: string[]; refused: Record<string, string> }
const EMPTY_VIEW: SyncView = { secs: [], stale: false, failed: [], refused: {} };

/** Keep the newest event per id, in the order ids first appeared. */
export function addProgress(list: Progress[], p: Progress): Progress[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return [...list, p];
  const next = list.slice();
  next[i] = p;
  return next;
}

export type BackupKind = "connections" | "full";
/** ledger: restored; none (a connections backup); other-wealthfolio (a full backup whose accounts are not here). */
export interface Restored { kind: BackupKind; items: number; accounts: number; rows: number; ledger: "restored" | "none" | "other-wealthfolio"; removed: number }
export type LinkCheck = { state: "waiting" } | { state: "exited"; message: string } | { state: "done"; itemId: string; institution: string; accounts: number };

/** The user left the hosted page without finishing, or is still on it. */
function exited(sessions: Row[]): LinkCheck {
  for (const s of sessions) {
    const x = s.exit ?? s.on_exit;
    if (x || s.finished_at) {
      const e = x?.error;
      return { state: "exited", message: e ? String(e.display_message || e.error_message || e.error_code) : "You closed Plaid before finishing." };
    }
  }
  return { state: "waiting" };
}

/** Planned new, updated and removed rows per account, by the addon's account name. */
function perAccount(p: Plan, cfg: Record<string, AccountCfg>): NonNullable<RunRecord["accounts"]> {
  const by = new Map<string, { name: string; new: number; updated: number; removed: number }>();
  const at = (aid: string) => {
    if (!by.has(aid)) by.set(aid, { name: String(cfg[aid]?.name ?? aid), new: 0, updated: 0, removed: 0 });
    return by.get(aid)!;
  };
  for (const a of p.new) at(a.accountId).new++;
  for (const [r] of p.updates) at(r.account_id).updated++;
  for (const r of p.voids) at(r.account_id).removed++;
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function summary(p: Plan, f: FetchResult, s?: PushStats): string {
  const parts = s ? [`${s.imported} new`, `${s.updated} updated`, `${s.linked} transfers linked`]
    : [`${p.new.length} new`, `${p.updates.length} updated`, `${p.voids.length} removed`, `${p.pairs.length} transfers`];
  if (p.reviews.length) parts.push(`${p.reviews.length} to do`);
  if (f.skipped.length) parts.push(`reconnect: ${f.skipped.join(", ")}`);
  return parts.join(", ");
}
