import { errText, required, valueAt, accountLabel, accountNames, plural, cryptoSymbol, isCrypto, isCurrency, type AccountCfg, BLOCKING_ITEM_ERRORS, PlaidError, RECONNECT_DETAIL, accountName, type OnProgress, type Progress, assignCategories, Closes, D, discoverAccounts, entry, fetchItems, type FetchResult, type Adoption, type Existing, findAdoptions, forgetEmptied, matchById, holdsSecurities, jointCopies, planLinks, type HttpGet, jointOwners, addDays, HISTORY_DAYS, MemoryLedger, Plaid, type PlaidEnv, plan, type Plan, push, type PushStats, rebases, reportedPrice, resolve, type SecurityOverride, type HoldingsData, type InvestmentData, type LinkSession, type PlaidInstitution, type PlaidSecurity, type HoldingsItem, todoReport, type Token, type Track, trackedIds, type Transport, uncategorized, WF_TYPE, withPrices, yahooFetch } from '../importer';
import { type Api, type AutoRun, type Daily, type ItemMeta, type RunRecord, Store } from './store';
import { type Backup, type BackupItem, type BackupKind, isBackup } from './backup';
import { SdkWriter } from './writer';

export type { AutoRun, Daily, RunRecord } from './store';
export type { Progress } from '../importer';
export type { BackupKind } from './backup';

const today = () => new Date().toISOString().slice(0, 10);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const RETRY_MS = 2 * 3600_000;
const RUNS_KEPT = 7;
const LOCK_MS = 30 * 60_000;
const LOCK_SETTLE_MS = 2000;
const PULL_REUSE_MS = 15 * 60_000;
const REFRESH_MS = 24 * 3600_000;
export const DEFAULT_DAILY: Daily = { on: false, time: "07:00" };
const minutes = (hhmm: string) => { const [h = 0, m = 0] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };
const AUTO_RATIO_LIMIT = 0.05;
const BACKUP_FORMAT = "plaid-importer-backup";
const NOT_A_BACKUP = "This is not a Plaid Importer backup. Make one in Backup.";
const NO_HOSTED_LINK = "Plaid returned no hosted link. Ask Plaid support to enable Hosted Link for your account.";
const DAILY_RUNNING = "The daily sync is running. Wait for it to finish.";
const union = <T,>(...lists: Iterable<T>[]): T[] => [...new Set(lists.flatMap((l) => [...l]))];
const clientUser = (owner: string) => `plaid-importer-${owner.toLowerCase()}`;
const institutionName = (plaid: Plaid, id: string | null | undefined): Promise<string | undefined> =>
  id ? plaid.institution(id).then((r) => r.name ?? undefined, () => undefined) : Promise.resolve(undefined);
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
const securitySymbol = (r: { kind: string; symbol: string | null }): string | null => (r.kind === "security" ? r.symbol : null);
const withoutRows = (p: Plan, ids: Set<string>): Plan =>
  ({ ...p, new: p.new.filter((a) => !ids.has(a.plaidId)), categories: new Map([...p.categories].filter(([k]) => !ids.has(k))) });

const brokerTransport = (api: Api): Transport => async (url, body, headers) => {
  const r = await api.network.request({ url, method: "POST", body, headers, timeoutSecs: 120 });
  return { status: r.status, body: r.body };
};
const brokerGet = (api: Api): HttpGet => async (url, headers) => {
  const r = await api.network.request({ url, method: "GET", headers, timeoutSecs: 30 });
  return { status: r.status, body: r.body };
};

export class Engine {
  store: Store;
  view: SyncView = EMPTY_VIEW;
  tasks: Record<string, Task | undefined> = {};
  private listeners = new Set<() => void>();
  pendingLink?: { url: string; linkToken: string; owner: string; itemId?: string | undefined; started: number } | undefined;
  lastLinked?: (LinkCheck & { state: "done"; reconnect: boolean }) | undefined;
  private pulled?: { key: string; fetched: FetchResult };
  lockSettleMs = LOCK_SETTLE_MS;
  constructor(private api: Api) {
    this.store = new Store(api);
  }

  private writing = 0;
  private doneDay?: string | undefined;
  get busy() { return this.writing > 0 || Object.values(this.tasks).some((t) => t?.running); }

  private async write<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tasks.daily?.running) throw new Error(DAILY_RUNNING);
    this.writing++;
    try {
      return await fn();
    } finally {
      this.writing--;
    }
  }

  private async editAccounts<T>(fn: (cfg: Record<string, AccountCfg>, env: PlaidEnv) => T | Promise<T>): Promise<T> {
    const { env } = await this.store.settings();
    const cfg = await this.store.accounts(env);
    const out = await fn(cfg, env);
    await this.store.saveAccounts(env, cfg);
    return out;
  }

  private async tokens(env: PlaidEnv): Promise<Record<string, Token>> {
    const items = Object.entries(await this.store.items(env));
    const toks = await Promise.all(items.map(([id]) => this.store.token(id)));
    return Object.fromEntries(items.flatMap(([id, m], i) => (toks[i] ? [[id, { ...m, access_token: toks[i] }]] : [])));
  }

  private async closes(day = today()) {
    return new Closes(await this.store.prices(), yahooFetch(brokerGet(this.api)), day, (c) => this.store.savePrices(c));
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

  async task<T>(key: string, label: string, fn: (io: { log: (m: string) => void; progress: OnProgress }) => Promise<T>): Promise<T> {
    if (this.tasks[key]?.running) throw new Error("This is still running. Wait for it to finish.");
    if (key !== "daily" && this.tasks.daily?.running) throw new Error(DAILY_RUNNING);
    let t: Task = { label, running: true, progress: [], log: [] };
    const set = (p: Partial<Task>) => { t = { ...t, ...p }; this.tasks[key] = t; this.emit(); };
    set({});
    try {
      const result = await fn({ log: (m) => set({ log: [...t.log, m] }), progress: (p) => set({ progress: addProgress(t.progress, p) }) });
      set({ running: false, result });
      return result;
    } catch (e) {
      set({ running: false, error: errText(e) });
      throw e;
    }
  }

  async plaid(): Promise<Plaid> {
    const { env } = await this.store.settings();
    const k = await this.store.keys(env);
    if (!k.clientId || !k.secret) throw new Error(`Add your Plaid ${env} keys first.`);
    return new Plaid({ clientId: k.clientId, secret: k.secret }, env, brokerTransport(this.api));
  }

  setEnv(env: PlaidEnv) {
    this.doneDay = undefined;
    return this.write(async () => this.store.saveSettings({ ...(await this.store.settings()), env }));
  }

  saveKeys(env: PlaidEnv, clientId: string, secret: string) {
    return this.write(() => this.store.saveKeys(env, clientId, secret));
  }

  async checkKeys(): Promise<void> {
    try {
      await (await this.plaid()).call("/institutions/get", { count: 1, offset: 0, country_codes: ["US"] });
    } catch (e) {
      throw new Error(`Plaid did not accept these keys: ${errText(e)}`);
    }
  }


  async connectSandbox(owner: string, institutionId = "ins_109508", products = ["transactions", "investments"]) {
    return this.write(async () => {
      const plaid = await this.plaid();
      return this.finishLink(plaid, await plaid.sandboxPublicToken(institutionId, products), { owner, products });
    });
  }

  async startHostedLink(owner: string): Promise<{ url: string; linkToken: string }> {
    const plaid = await this.plaid();
    const r = await plaid.linkToken(clientUser(owner), { products: ["transactions"], optional: ["investments", "auth"] }, { hosted_link: {} });
    if (!r.hosted_link_url) throw new Error(NO_HOSTED_LINK);
    return { url: r.hosted_link_url, linkToken: r.link_token };
  }

  async checkHostedLink(owner: string, linkToken: string): Promise<LinkCheck> {
    if (this.tasks.daily?.running) return { state: "waiting" };
    const plaid = await this.plaid();
    const sessions = await plaid.linkTokenGet(linkToken);
    for (const s of sessions) {
      const add = s.results?.item_add_results?.[0] ?? s.on_success;
      const pt = add?.public_token;
      if (pt) {
        const itemId = await this.write(() => this.finishLink(plaid, pt, { owner, products: add.products ?? ["transactions", "investments"], institution: add.institution }));
        return this.linked(itemId);
      }
    }
    return exited(sessions);
  }

  async checkReconnect(itemId: string, linkToken: string): Promise<LinkCheck> {
    if (this.tasks.daily?.running) return { state: "waiting" };
    const plaid = await this.plaid();
    const sessions = await plaid.linkTokenGet(linkToken);
    if (sessions.some((s) => s.on_success || s.results)) {
      await this.write(async () => {
        await this.markReconnect([], [itemId]);
        await this.refreshAccounts(itemId, false);
      });
      return this.linked(itemId);
    }
    return exited(sessions);
  }

  private async linked(itemId: string): Promise<LinkCheck> {
    const { env } = await this.store.settings();
    const accounts = Object.values(await this.store.accounts(env)).filter((c) => c.item_id === itemId && WF_TYPE[c.kind]).length;
    return { state: "done", itemId, institution: (await this.store.items(env))[itemId]?.institution_name ?? "Bank", accounts };
  }

  async startReconnect(itemId: string): Promise<{ url: string; linkToken: string }> {
    const plaid = await this.plaid();
    const { env } = await this.store.settings();
    const meta = (await this.store.items(env))[itemId];
    const tok = await this.store.token(itemId);
    if (!meta || !tok) throw new Error("Unknown connection.");
    const r = await plaid.linkToken(clientUser(meta.owner), { accessToken: tok }, { hosted_link: {} });
    if (!r.hosted_link_url) throw new Error(NO_HOSTED_LINK);
    return { url: r.hosted_link_url, linkToken: r.link_token };
  }

  private async finishLink(plaid: Plaid, publicToken: string, link: { owner: string; products: string[]; institution?: PlaidInstitution | null | undefined }): Promise<string> {
    const { owner, products, institution } = link;
    const { env } = await this.store.settings();
    const ex = await plaid.exchange(publicToken);
    const item = await plaid.item(ex.access_token);
    const insId = institution?.institution_id ?? item.institution_id;
    const name = institution?.name || await institutionName(plaid, insId);
    await this.store.saveToken(ex.item_id, ex.access_token);
    const items = await this.store.items(env);
    items[ex.item_id] = { owner: owner.toUpperCase(), institution_name: name || "Bank", institution_id: insId,
      products: item.products ?? products, env };
    await this.store.saveItems(env, items);
    await this.refreshAccounts(ex.item_id);
    return ex.item_id;
  }

  async setOwner(itemId: string, owner: string) {
    return this.write(async () => {
      const o = owner.trim().toUpperCase();
      if (!/^[A-Z]{1,4}$/.test(o)) throw new Error("Type 1 to 4 letters, for example AB.");
      const { env } = await this.store.settings();
      const items = await this.store.items(env);
      if (!items[itemId]) throw new Error("Unknown connection.");
      items[itemId] = { ...items[itemId], owner: o };
      await this.store.saveItems(env, items);
      await this.editAccounts((cfg) => {
        for (const [aid, c] of Object.entries(cfg)) {
          if (c.item_id !== itemId) continue;
          c.owner = o;
          if (c.wealthfolio_account_id) continue;
          const taken = new Set(Object.entries(cfg).filter(([id]) => id !== aid).map(([, x]) => String(x.name)));
          c.name = accountName({ owner: o, institution: c.institution ?? valueAt(items, itemId).institution_name, plaidName: c.plaid_name, mask: c.mask }, taken);
        }
      });
    });
  }

  async removeItem(itemId: string) {
    return this.write(async () => {
      const { env } = await this.store.settings();
      await this.store.saveItems(env, without(await this.store.items(env), itemId));
      const cfg = await this.store.accounts(env);
      await this.store.saveAccounts(env, Object.fromEntries(Object.entries(cfg).filter(([, c]) => c.item_id !== itemId)));
      await this.store.deleteToken(itemId);
    });
  }

  async addToken(owner: string, accessToken: string): Promise<string> {
    return this.write(async () => {
      const tok = accessToken.trim();
      const m = /^access-(sandbox|development|production)-[0-9a-f-]{36}$/.exec(tok);
      if (!m) throw new Error("An access token looks like access-production-1a2b3c4d-…, 36 characters after the second dash.");
      const { env } = await this.store.settings();
      if (m[1] !== env) throw new Error(`This is a ${m[1]} token, but the addon is in ${env}. Switch it in Setup first.`);
      if (!/^[A-Za-z]{1,4}$/.test(owner.trim())) throw new Error("Type the owner's initials, for example AB.");
      const plaid = await this.plaid();
      const item = await plaid.item(tok).catch((e: unknown) => {
        if (e instanceof PlaidError && e.code === "INVALID_RESPONSE") throw new Error("Plaid did not accept this token.");
        throw e;
      });
      const items = await this.store.items(env);
      const insId = item.institution_id;
      const name = items[item.item_id]?.institution_name ?? (await institutionName(plaid, insId)) ?? "Bank";
      await this.store.saveToken(item.item_id, tok);
      items[item.item_id] = { ...items[item.item_id], owner: owner.trim().toUpperCase(), institution_name: name,
        institution_id: insId, products: item.products ?? [], env, created: today() };
      await this.store.saveItems(env, items);
      await this.refreshAccounts(item.item_id);
      return item.item_id;
    });
  }

  async backup(kind: BackupKind): Promise<string> {
    const { env } = await this.store.settings();
    const items: Record<string, BackupItem> = {};
    for (const [id, m] of Object.entries(await this.store.items(env))) {
      const t = await this.store.token(id);
      if (!t) continue;
      const meta = { ...m };
      if (kind !== "full") delete meta.checked;
      items[id] = { ...meta, env, access_token: t };
    }
    const out: Backup = { format: BACKUP_FORMAT, kind, env, items };
    if (kind === "full") {
      const [accounts, symbols, ledger, remap] = await Promise.all([this.store.accounts(env), this.store.symbols(env), this.store.ledger(env), this.store.remap(env)]);
      Object.assign(out, { accounts, symbols, ledger: ledger.toJSON(), remap });
    }
    return JSON.stringify(out);
  }

  private async readBackup(text: string): Promise<{ d: Backup; env: PlaidEnv }> {
    let d: unknown;
    try {
      d = JSON.parse(text.trim());
    } catch {
      throw new Error(NOT_A_BACKUP);
    }
    if (!isBackup(d) || d.format !== BACKUP_FORMAT) throw new Error(NOT_A_BACKUP);
    const { env } = await this.store.settings();
    if (d.env !== env) throw new Error(`This backup is for ${d.env}, but the addon is in ${env}. Switch it in Setup first.`);
    return { d, env };
  }

  async overwriteLoss(text: string): Promise<string[]> {
    const { d, env } = await this.readBackup(text);
    return Object.entries(await this.store.items(env)).filter(([id]) => !d.items?.[id])
      .map(([, m]) => `${m.owner} · ${m.institution_name}`);
  }

  async restore(text: string, mode: "merge" | "overwrite" = "merge"): Promise<Restored> {
    return this.write(async () => {
      const { d, env } = await this.readBackup(text);
      const over = mode === "overwrite";
      const full = d.kind === "full";
      const incoming = d.items ?? {};
      const { items, removed } = await this.restoreItems(env, incoming, over);
      const backed = d.accounts ?? {};
      const here = await this.store.accounts(env);
      const kept = Object.fromEntries(Object.entries(here).filter(([, c]) => items[c.item_id]));
      await this.store.saveAccounts(env, over ? (full ? backed : kept) : { ...backed, ...here });
      await this.store.saveSymbols(env, over && full ? (d.symbols ?? {}) : { ...(d.symbols ?? {}), ...(await this.store.symbols(env)) });
      const out: Restored = { kind: d.kind, items: Object.keys(incoming).length, accounts: Object.keys(backed).length, rows: 0, ledger: "none", removed };
      if (!full) return out;
      const wf = new Set((await this.wealthfolioAccounts()).map((a) => a.id));
      if (!Object.values(backed).some((c) => c.wealthfolio_account_id && wf.has(c.wealthfolio_account_id))) {
        out.ledger = "other-wealthfolio";
        return out;
      }
      out.rows = over ? await this.replaceLedger(env, d) : await this.mergeLedger(env, d);
      out.ledger = "restored";
      return out;
    });
  }

  private async restoreItems(env: PlaidEnv, incoming: NonNullable<Backup["items"]>, over: boolean): Promise<{ items: Record<string, ItemMeta>; removed: number }> {
    const current = await this.store.items(env);
    const removed = over ? Object.keys(current).filter((id) => !incoming[id]) : [];
    for (const id of removed) await this.store.deleteToken(id);
    const items: Record<string, ItemMeta> = over ? {} : current;
    for (const [id, tok] of Object.entries(incoming)) {
      const { access_token, ...meta } = tok;
      if (over || !current[id]) {
        await this.store.saveToken(id, access_token);
        items[id] = meta;
      } else if (!(await this.store.token(id))) {
        await this.store.saveToken(id, access_token);
      }
    }
    await this.store.saveItems(env, items);
    return { items, removed: removed.length };
  }

  private async replaceLedger(env: PlaidEnv, d: Backup): Promise<number> {
    const state = new MemoryLedger(d.ledger ?? {});
    await this.store.saveLedger(env, state);
    await this.store.saveRemap(env, { full: d.remap?.full ?? [], dropped: d.remap?.dropped ?? {} });
    return state.rows.size;
  }

  private async mergeLedger(env: PlaidEnv, d: Backup): Promise<number> {
    const state = await this.store.ledger(env);
    let rows = 0;
    for (const r of d.ledger?.rows ?? []) if (!state.rows.has(r.plaid_id)) { state.rows.set(r.plaid_id, r); rows++; }
    for (const [k, v] of Object.entries(d.ledger?.cursors ?? {})) if (!state.cursors.has(k)) state.cursors.set(k, v);
    for (const [k, v] of Object.entries(d.ledger?.invSync ?? {})) if (!state.invSync.has(k)) state.invSync.set(k, v);
    for (const a of d.ledger?.invFull ?? []) state.invFull.add(a);
    await this.store.saveLedger(env, state);
    const remap = await this.store.remap(env);
    const dropped = { ...remap.dropped };
    for (const [sym, accts] of Object.entries(d.remap?.dropped ?? {})) dropped[sym] = union(dropped[sym] ?? [], accts);
    await this.store.saveRemap(env, { full: union(remap.full, d.remap?.full ?? []), dropped });
    return rows;
  }

  async refreshAccounts(itemId: string, identity = true): Promise<string[]> {
    return this.write(async () => {
      const plaid = await this.plaid();
      const { env } = await this.store.settings();
      const meta = valueAt(await this.store.items(env), itemId);
      const tok = required(await this.store.token(itemId), `access token for ${itemId}`);
      const products = meta.products ?? [];
      const [accts, holdings, ident] = await Promise.all([
        plaid.accounts(tok),
        products.includes("investments") ? plaid.holdings(tok).catch(() => null) : null,
        identity && products.includes("identity") ? plaid.identity(tok).catch(() => null) : null,
      ]);
      const added = await this.editAccounts((cfg) => discoverAccounts(cfg, { itemId, tok: meta, accounts: accts }, holdsSecurities(accts, holdings), jointOwners(ident)));
      const items = await this.store.items(env);
      if (items[itemId]) {
        items[itemId] = { ...items[itemId], checked: new Date().toISOString() };
        await this.store.saveItems(env, items);
      }
      return added;
    });
  }

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
        progress({ id, label, state: "done", detail: n ? plural(n, "new account") : "No new accounts" });
      } catch (e) {
        const login = e instanceof PlaidError && BLOCKING_ITEM_ERRORS.has(e.code);
        if (login) await this.markReconnect([id], []);
        failed.push(label);
        progress({ id, label, state: "error", detail: login ? RECONNECT_DETAIL : errText(e) });
      }
    }
    return { added, failed };
  }

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
    } catch {  }
    const active = Object.values(cfg).filter((c) => !c.skip && WF_TYPE[c.kind]);
    return active.length > 0 && active.every((c) => c.wealthfolio_account_id);
  }

  async spendingAccounts(): Promise<Set<string> | null> {
    try {
      const c = await this.api.spending.getContext();
      return c.enabled ? new Set(c.accountIds) : new Set();
    } catch {
      return null;
    }
  }

  async setSync(accountId: string, on: boolean) {
    return this.write(async () => {
      await this.editAccounts((cfg) => { valueAt(cfg, accountId).skip = !on; });
    });
  }

  async setSyncAll(on: boolean) {
    return this.write(async () => {
      await this.editAccounts((cfg) => {
        for (const c of Object.values(cfg)) if (WF_TYPE[c.kind]) c.skip = !on;
        if (on) for (const id of jointCopies(cfg)) valueAt(cfg, id).skip = true;
      });
    });
  }

  async wealthfolioAccounts(): Promise<{ id: string; name: string; accountType: string; accountNumber?: string | undefined }[]> {
    try {
      return (await this.api.accounts.getAll()).map((a) => ({ id: a.id, name: a.name, accountType: a.accountType, accountNumber: a.accountNumber }));
    } catch {
      return [];
    }
  }

  async pushedAccounts(): Promise<Set<string>> {
    const { env } = await this.store.settings();
    return (await this.store.ledger(env)).accountIds();
  }

  async unlinkAccount(accountId: string) {
    return this.write(async () => {
      if ((await this.pushedAccounts()).has(accountId)) throw new Error("Rows were already pushed to this account, so its link cannot change.");
      await this.editAccounts((cfg) => {
        valueAt(cfg, accountId).wealthfolio_account_id = null;
        delete valueAt(cfg, accountId).match;
      });
    });
  }

  async setMatch(accountId: string, match: string | undefined) {
    return this.write(async () => {
      await this.editAccounts((cfg) => {
        if (match === undefined) delete valueAt(cfg, accountId).match;
        else valueAt(cfg, accountId).match = match;
      });
    });
  }

  async createAccounts(): Promise<number> {
    return this.write(async () => {
      return this.editAccounts(async (cfg) => {
        const links = planLinks(cfg, await this.wealthfolioAccounts());
        let n = 0;
        for (const [aid, pick] of Object.entries(links)) {
          const c = valueAt(cfg, aid);
          if (pick) {
            c.wealthfolio_account_id = pick;
            continue;
          }
          const made = await this.api.accounts.create({
            name: c.name, accountType: WF_TYPE[c.kind], group: c.owner || null, currency: c.currency || "USD",
            accountNumber: c.mask || undefined, isDefault: false, isActive: true, trackingMode: "TRANSACTIONS",
          });
          c.wealthfolio_account_id = made.id;
          n++;
        }
        return n;
      });
    });
  }


  async categorize(log: (m: string) => void = () => {}): Promise<string> {
    const { env } = await this.store.settings();
    const [cfg, state] = await Promise.all([this.store.accounts(env), this.store.ledger(env)]);
    if (unlearned(state, cfg).length) await this.learnCategories(env, cfg, state, log);
    const todo = uncategorized(state, cfg);
    if (!todo.size) {
      await this.store.saveLedger(env, state);
      return "Every pushed bank and card row with a Plaid category already has one.";
    }
    try {
      const n = await assignCategories(new SdkWriter(this.api, () => null), state, todo, log);
      return `Categorized ${n} of ${todo.size} rows.`;
    } finally {
      await this.store.saveLedger(env, state);
    }
  }

  private async learnCategories(env: PlaidEnv, cfg: Record<string, AccountCfg>, state: MemoryLedger, log: (m: string) => void) {
    const accts = new Set(unlearned(state, cfg).map((r) => r.account_id));
    const bank = Object.fromEntries(Object.entries(cfg).filter(([aid]) => accts.has(aid)));
    const scratch = new MemoryLedger({});
    const fetched = await fetchItems(await this.plaid(), await this.tokens(env),
      { accounts: bank, state: scratch, today: today(), log: (m) => { if (!m.includes("no active accounts")) log(m); } });
    const pfc = new Map(plan(fetched.items, { accounts: bank, symbols: {} }, scratch, { today: today(), closes: () => null }).new.map((a) => [a.plaidId, a.category ?? null]));
    const pulled = new Set(fetched.items.map((d) => d.itemId));
    for (const r of unlearned(state, cfg)) if (pulled.has(valueAt(cfg, r.account_id).item_id)) r.category = pfc.get(r.plaid_id) ?? null;
  }


  async autoSync(now = new Date()): Promise<RunRecord | null> {
    if (this.busy || this.doneDay === localDay(now)) return null;
    const s = await this.store.settings();
    const daily = await this.store.daily(s);
    if (!daily.on) return null;
    if (now.getHours() * 60 + now.getMinutes() < minutes(daily.time)) return null;
    const rec = await this.store.autoRun(s.env);
    if (rec.done === localDay(now)) this.doneDay = rec.done;
    if (rec.done === localDay(now) || (rec.tried && now.getTime() - Date.parse(rec.tried) < RETRY_MS)) return null;
    return this.runDaily(now);
  }

  async runDaily(now = new Date()): Promise<RunRecord | null> {
    if (this.tasks.daily?.running) return null;
    if (this.busy) throw new Error("Something else is running. Wait for it to finish.");
    const { env } = await this.store.settings();
    const lock = await this.claimDaily(env, now);
    if (!lock) return null;
    try {
      await this.store.saveAutoRun(env, { ...(await this.store.autoRun(env)), tried: now.toISOString() });
      return await this.task("daily", "run", async (io) => {
        const r = await this.daily(now, io.progress);
        const rec: AutoRun = await this.store.autoRun(env);
        await this.store.saveAutoRun(env, { ...rec, ...(r.totals ? { done: localDay(now) } : {}),
          runs: [r, ...(rec.runs ?? [])].slice(0, RUNS_KEPT) });
        if (r.totals) this.doneDay = localDay(now);
        return r;
      });
    } finally {
      if ((await this.store.dailyLock(env))?.id === lock) await this.store.saveDailyLock(env, null);
    }
  }

  private async claimDaily(env: PlaidEnv, now: Date): Promise<string | null> {
    const held = await this.store.dailyLock(env);
    if (held && now.getTime() - Date.parse(held.at) < LOCK_MS) return null;
    const id = Math.random().toString(36).slice(2);
    await this.store.saveDailyLock(env, { id, at: now.toISOString() });
    if (this.lockSettleMs) await new Promise((r) => setTimeout(r, this.lockSettleMs));
    return (await this.store.dailyLock(env))?.id === id ? id : null;
  }

  async nextDaily(now = new Date()): Promise<Date | null> {
    const s = await this.store.settings();
    const [daily, rec] = await Promise.all([this.store.daily(s), this.store.autoRun(s.env)]);
    return nextRun(daily, rec, now);
  }

  private async daily(now: Date, progress: OnProgress): Promise<RunRecord> {
    const time = now.toISOString();
    try {
      const { d, big } = await this.applySmallRebases(await this.dryRun(() => {}, progress, true));
      const blocked = dailyBlocker(d);
      if (blocked) return { time, status: "stopped", goto: "sync", message: blocked };
      const accounts = perAccount(d.plan, d.cfg);
      const stats = await this.pushAndCategorize(d, () => {}, progress);
      const totals = { new: stats.imported, updated: stats.updated, removed: stats.voided, categorized: stats.categorized, failed: stats.failed };
      const notes = dailyNotes(d, stats, big);
      if (d.plan.reviews.length) {
        const left = await this.afterPush(d);
        this.setView({ dry: left, stale: false, result: undefined, failed: stats.failures, refused: stats.refused });
      }
      const status = stats.failed || d.fetched.skipped.length ? "stopped" : "ok";
      const goto = d.fetched.skipped.length ? "connections" : stats.failed || big.length || d.plan.reviews.length ? "sync" : undefined;
      return { time, status, accounts, totals, goto, message: [summary(d.plan, d.fetched, stats), ...notes].join(". ") + "." };
    } catch (e) {
      return { time, status: "failed", message: errText(e) };
    }
  }


  private async applySmallRebases(dry: DryRun): Promise<{ d: DryRun; big: string[] }> {
    const big: string[] = [];
    let applied = 0;
    for (const r of dry.rebases) {
      if (r.next && r.change !== null && Math.abs(r.change) <= AUTO_RATIO_LIMIT) {
        await this.applySecurity(r.sid, r.name, { mode: "track", track: r.next });
        applied++;
      } else if (r.next) big.push(r.name);
    }
    return { d: applied ? await this.replan(dry) : dry, big };
  }

  setSecurity(sid: string, name: string, o: SecurityChoice): Promise<SecurityOverride> {
    return this.write(() => this.applySecurity(sid, name, o));
  }

  private async applySecurity(sid: string, name: string, o: SecurityChoice): Promise<SecurityOverride> {
    const { env } = await this.store.settings();
    const symbols = await this.store.symbols(env);
    const before = { ...symbols };
    const { instrument_type, multiplier } = symbols[sid] ?? {};
    const sym = o.symbol?.trim().toUpperCase() || null;
    const e: SecurityOverride = { ...(instrument_type === undefined ? {} : { instrument_type }),
      ...(multiplier === undefined ? {} : { multiplier }), name };
    if (o.mode === "auto") e.symbol = null;
    else if (o.mode === "ticker") {
      if (!sym) throw new Error("Type a ticker.");
      e.symbol = sym;
    } else if (o.mode === "manual") Object.assign(e, { symbol: sym, manual: true });
    else if (o.mode === "cash") e.cash = true;
    else if (o.mode === "holding") Object.assign(e, { investment: true, symbol: sym });
    else if (o.mode === "exclude") e.exclude = true;
    else {
      if (!o.track) throw new Error("Set the fund to follow first.");
      e.track = o.track;
    }
    symbols[sid] = e;
    await this.store.saveSymbols(env, symbols);
    await this.noteRemap(env, sid, before, symbols);
    return e;
  }

  private async noteRemap(env: PlaidEnv, sid: string, before: Record<string, SecurityOverride>, after: Record<string, SecurityOverride>) {
    const { sec, accts } = pulledSecurity(this.pulled?.fetched.items ?? [], sid);
    if (!sec) return;
    const cur = sec.iso_currency_code || "USD";
    const [was, now] = [securitySymbol(resolve(sec, before, cur)), securitySymbol(resolve(sec, after, cur))];
    const remap = await this.store.remap(env);
    if (now !== null) {
      remap.dropped = without(remap.dropped, now);
      if (was === null) remap.full = union(remap.full, accts);
    }
    if (was !== null && now !== was) {
      const state = await this.store.ledger(env);
      const pushed = state.live(was).map((r) => r.account_id);
      if (pushed.length) remap.dropped[was] = union(remap.dropped[was] ?? [], pushed);
    }
    await this.store.saveRemap(env, remap);
  }

  async validTicker(symbol: string): Promise<{ ok: boolean; name?: string | undefined; suggestions?: { symbol: string; name?: string }[] | undefined }> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return { ok: false };
    const hits = await this.api.market.searchTicker(sym);
    const hit = hits.find((h) => [h.symbol, h.canonicalSymbol, h.providerSymbol].some((x) => x?.toUpperCase() === sym));
    if (hit) return { ok: true, name: hit.longName || hit.shortName };
    return { ok: false, suggestions: hits.slice(0, 5).map((h) => ({ symbol: h.symbol, name: h.longName || h.shortName })) };
  }

  private tickerOk = new Map<string, boolean | null>();

  async checkTickers(symbols: string[]): Promise<Record<string, boolean | null>> {
    const todo = [...new Set(symbols)].filter((s) => !this.tickerOk.has(s));
    const got = await Promise.all(todo.map((s) => this.validTicker(s).then((r) => r.ok, () => null)));
    todo.forEach((s, i) => this.tickerOk.set(s, got[i] ?? null));
    return Object.fromEntries(symbols.map((s) => [s, this.tickerOk.get(s) ?? null]));
  }

  async ratio(target: string, day: string, price: string, close?: string): Promise<Track> {
    const sym = target.trim().toUpperCase();
    if (!sym) throw new Error("Type the ticker to follow, for example VOO.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) throw new Error("Type a past date as YYYY-MM-DD.");
    const num = (v: string, what: string) => {
      try {
        const d = D(v.trim());
        if (d.gt(0)) return d;
      } catch {  }
      throw new Error(`Type the ${what} as a number above 0, for example 104.25.`);
    };
    const p = num(price, "fund price");
    let c = close?.trim() ? num(close, "close") : null;
    let usedDay = day;
    if (!c) {
      const closes = await this.closes();
      await closes.load([[sym, day]]);
      const near = closes.nearest(sym, day);
      if (!near) throw new Error(`Yahoo Finance has no prices for ${sym}. Type the close from your broker.`);
      [c, usedDay] = [near.close, near.day];
    }
    return entry(sym, usedDay, p, c);
  }

  async retrack(symbol: string, accountIds: Set<string>): Promise<number> {
    return this.write(async () => {
      const { env } = await this.store.settings();
      const state = await this.store.ledger(env);
      const rows = [...state.rows.values()].filter((r) => r.symbol === symbol && accountIds.has(r.account_id) && !r.adopted);
      const ids = rows.map((r) => r.wf_activity_id).filter((x): x is string => Boolean(x));
      if (ids.length) await new SdkWriter(this.api, () => null).delete(ids);
      state.forget(rows.map((r) => r.plaid_id), new Set(rows.map((r) => r.account_id)));
      await this.store.saveLedger(env, state);
      const remap = await this.store.remap(env);
      remap.dropped = without(remap.dropped, symbol);
      remap.full = union(remap.full, accountIds);
      await this.store.saveRemap(env, remap);
      return rows.length;
    });
  }


  async dryRun(log: (m: string) => void, progress: OnProgress = () => {}, fresh = false): Promise<DryRun> {
    const { env } = await this.store.settings();
    const plaid = await this.plaid();
    const [cfg, symbols, state, remap] = await Promise.all([this.store.accounts(env), this.store.symbols(env),
      this.store.ledger(env), this.store.remap(env)]);
    const missing = Object.values(cfg).filter((c) => !c.skip && WF_TYPE[c.kind] && !c.wealthfolio_account_id);
    if (missing.length) throw new Error(`Create the Wealthfolio accounts first (${missing.length} missing).`);
    const counts = new Map<string, number>();
    const seen = state.accountIds();
    const check = new Set(Object.entries(cfg).flatMap(([aid, c]) => (c.wealthfolio_account_id && seen.has(aid) ? [c.wealthfolio_account_id] : [])));
    await Promise.all([...check].map(async (w) => {
      try { counts.set(w, (await this.api.activities.getAll(w)).length); } catch {  }
    }));
    const wiped = forgetEmptied(state, cfg, counts);
    if (wiped.accounts.length) {
      log(`  ${wiped.accounts.map((a) => String(valueAt(cfg, a).name)).join(", ")}: empty in Wealthfolio, so ${wiped.rows} remembered rows were forgotten and will be pulled again`);
      await this.store.saveLedger(env, state);
    }
    const tokens = await this.tokens(env);
    const tracked = trackedIds(symbols);
    const full = new Set(remap.full);
    const key = JSON.stringify([env, Object.keys(tokens).sort(), Object.entries(cfg).filter(([, c]) => !c.skip).map(([a]) => a).sort(), [...tracked].sort(), [...full].sort()]);
    const prior = this.pulled;
    const reuse = !fresh && !wiped.accounts.length && prior?.key === key && Date.now() - (prior.fetched.pulledAt ?? 0) < PULL_REUSE_MS;
    let fetched: FetchResult;
    if (reuse) {
      fetched = prior.fetched;
      const at = new Date(fetched.pulledAt ?? 0).toLocaleTimeString();
      log(`  using the Plaid pull from ${at}`);
      progress({ id: "pull", label: "Plaid data", state: "done", detail: `Reused the pull from ${at}` });
    } else {
      fetched = await fetchItems(plaid, tokens, { accounts: cfg, state, today: today(), log, tracked, full, progress });
      fetched.pulledAt = Date.now();
      this.pulled = { key, fetched };
      await this.markReconnect(fetched.blocked, fetched.items.map((d) => d.itemId));
    }
    progress({ id: "plan", label: "Compare with Wealthfolio", state: "running", detail: "Prices, duplicates and changes" });
    const d = await this.planFrom(env, { fetched, cfg, state, tracked });
    progress({ id: "plan", label: "Compare with Wealthfolio", state: "done" });
    return d;
  }

  async afterPush(d: DryRun): Promise<DryRun> {
    const [cfg, state, symbols] = await Promise.all([this.store.accounts(d.env), this.store.ledger(d.env), this.store.symbols(d.env)]);
    return this.planFrom(d.env, { fetched: d.fetched, cfg, state, tracked: trackedIds(symbols) });
  }

  async replan(d: DryRun): Promise<DryRun> {
    const symbols = await this.store.symbols(d.env);
    const now = trackedIds(symbols);
    const added = new Set([...now].filter((sid) => !d.tracked.has(sid)));
    const accts = new Set((await this.store.remap(d.env)).full);
    for (const item of d.fetched.items) {
      for (const h of item.holdings?.holdings ?? []) if (added.has(h.security_id)) accts.add(h.account_id);
    }
    await this.pullHistory(d, accts);
    return this.planFrom(d.env, { fetched: d.fetched, cfg: d.cfg, state: d.state, tracked: now }, d.adoptions);
  }

  private async pullHistory(d: DryRun, want: Set<string>) {
    let plaid: Plaid | undefined;
    const start = addDays(today(), -HISTORY_DAYS);
    for (const item of d.fetched.items) {
      const accts = new Set(Object.keys(item.invStart).filter((a) => want.has(a) && valueAt(item.invStart, a) > start));
      const tok = accts.size ? await this.store.token(item.itemId) : null;
      if (!tok) continue;
      const full = await (plaid ??= await this.plaid()).investmentTransactions(tok, start, today());
      const from = item.invStart;
      full.investment_transactions = full.investment_transactions.filter((t) => {
        const since = from[t.account_id];
        return accts.has(t.account_id) || !since || t.date >= since;
      });
      for (const a of accts) from[a] = start;
      item.inv = full;
    }
  }

  private async planFrom(env: PlaidEnv, input: PlanInput, prev: Adoption[] = []): Promise<DryRun> {
    const { fetched, cfg, state, tracked } = input;
    const day = today();
    const [symbols, closes, remap] = await Promise.all([this.store.symbols(env), this.closes(day), this.store.remap(env)]);
    const start = addDays(day, -HISTORY_DAYS);
    const fullPull = (a: string) => fetched.items.some((d) => d.invStart[a] !== undefined && d.invStart[a] <= start);
    const holdsTracked = new Set(fetched.items.flatMap((d) => (d.holdings?.holdings ?? []).filter((h) => trackedIds(symbols).has(h.security_id)).map((h) => h.account_id)));
    const backfill = new Set([...remap.full, ...holdsTracked].filter(fullPull));
    const p = await withPrices(closes, (c) => plan(fetched.items, { accounts: cfg, symbols }, state, { today: day, backfill, closes: c }));
    for (const [sym, accts] of Object.entries(remap.dropped)) {
      const live = new Set(state.live(sym).map((r) => r.account_id));
      const left = new Set(accts.filter((a) => live.has(a)));
      if (left.size) p.moved.set(sym, new Set([...(p.moved.get(sym) ?? []), ...left]));
    }
    const asked: [string, string][] = [];
    for (const sid of trackedIds(symbols)) {
      const got = reportedPrice(fetched.items, sid);
      const track = valueAt(symbols, sid).track;
      if (got && track) asked.push([track.symbol, got[1]]);
    }
    await closes.load(asked, { latest: true });
    const proposals = rebases(fetched.items, symbols, closes).map((rb) => ({
      sid: rb.sid, name: rb.name, old: rb.old, next: rb.next, day: rb.day, price: rb.price.toString(),
      change: rb.change?.toNumber() ?? null,
    }));
    if (p.unmapped.size) {
      for (const [sid, name] of p.unmapped) symbols[sid] ??= { name, symbol: null };
      await this.store.saveSymbols(env, symbols);
    }
    const names = accountNames(cfg);
    const adoptions = await this.adoptions(p, cfg, state, prev);
    const kept = await this.protect(p, cfg, state);
    return { env, plan: p, fetched, adoptions, todo: [...todoReport(p.reviews, names, closes.warnings()), ...kept.map((l) => (l.startsWith("  ") ? l : `\n${l}`))], state, cfg, tracked, backfill, rebases: proposals,
      securities: await this.securitiesOf(fetched.items, symbols) };
  }

  private async securitiesOf(items: FetchResult["items"], symbols: Record<string, SecurityOverride>): Promise<Security[]> {
    const list = seenSecurities(items, symbols);
    const known = await this.checkTickers(list.filter((s) => modeOf(s) === "auto" && tickersMatch(s)).map((s) => s.result));
    return list.map((s) => ({ ...s, review: needsReview(s, known) }));
  }

  private async adoptions(p: Plan, cfg: Record<string, AccountCfg>, state: MemoryLedger, prev: Adoption[]): Promise<Adoption[]> {
    const wfOf = (a: string) => cfg[a]?.wealthfolio_account_id ?? undefined;
    const synced = state.accountIds();
    const accounts = new Set(p.new.map((a) => wfOf(a.accountId)).filter((x): x is string => Boolean(x)));
    if (!accounts.size) return [];
    const lists = await Promise.all([...accounts].map((id) => this.api.activities.getAll(id)));
    const existing = lists.flat().filter((a) => a.status !== "VOID").map(existingRow);
    const taken = new Set([...state.rows.values()].map((r) => r.wf_activity_id).filter((x): x is string => Boolean(x)));
    const known = matchById(p.new, existing.filter((e) => !taken.has(e.id)), wfOf);
    if (known.size) {
      for (const a of p.new) {
        const hit = known.get(a.plaidId);
        if (hit) state.record(a, hit.id);
      }
      ({ new: p.new, categories: p.categories } = withoutRows(p, new Set(known.keys())));
    }
    const acts = p.new.filter((a) => !synced.has(a.accountId));
    const before = new Map(prev.map((a) => [a.key, a]));
    return findAdoptions(acts, existing, wfOf, taken).map((a) => {
      const was = before.get(a.key);
      return was && was.how === a.how ? { ...a, decision: was.decision } : a;
    });
  }

  private async protect(p: Plan, cfg: Record<string, AccountCfg>, state: MemoryLedger): Promise<string[]> {
    const touched = new Set<string>([...p.updates.map(([r]) => r.account_id), ...p.voids.map((r) => r.account_id),
      ...p.retype.map(([pid]) => state.get(pid)?.account_id ?? ""), ...p.pairs.flat().map((pid) => state.get(pid)?.account_id ?? "")]);
    const modified = new Set<string>();
    const wf = [...touched].map((aid) => cfg[aid]?.wealthfolio_account_id).filter((w): w is string => Boolean(w));
    for (const list of await Promise.all(wf.map((w) => this.api.activities.getAll(w)))) {
      for (const a of list) if (a.isUserModified) modified.add(a.id);
    }
    const mine = (pid: string) => {
      const r = state.get(pid);
      return Boolean(r && (r.adopted || (r.wf_activity_id && modified.has(r.wf_activity_id))));
    };
    const lines: string[] = [];
    const keep = <T,>(list: T[], row: (x: T) => { plaid_id: string; account_id: string; date: string; activity_type: string } | null, what: (x: T) => string) =>
      list.filter((x) => {
        const r = row(x);
        if (!r || !mine(r.plaid_id)) return true;
        lines.push(`  - ${accountLabel(cfg, r.account_id)}: ${r.date} ${r.activity_type} ${what(x)}`);
        return false;
      });
    p.updates = keep(p.updates, ([r]) => r, ([, , f]) => `changed at Plaid (${f.join(", ")})`);
    p.voids = keep(p.voids, (r) => r, () => "removed at Plaid");
    p.retype = keep(p.retype, ([pid]) => state.get(pid), ([, t]) => `would become ${t}`);
    p.pairs = p.pairs.filter(([o, i]) => !(mine(o) || mine(i)));
    return lines.length ? [`Kept as they are in Wealthfolio (${lines.length})`,
      "  These were in Wealthfolio before the importer, or you edited them. The importer does not change or delete them. Edit or delete them in Wealthfolio if Plaid is right.", ...lines] : [];
  }

  private applyAdoptions(d: DryRun): Plan {
    const skip = new Set<string>();
    const byId = new Map(d.plan.new.map((x) => [x.plaidId, x]));
    for (const a of d.adoptions) {
      const act = byId.get(a.plaidId);
      if (!act || a.decision !== "discard") continue;
      skip.add(a.plaidId);
      d.state.record(act, a.existing?.id ?? null, true);
      const row = d.state.rows.get(a.plaidId);
      if (row) row.adopted = 1;
    }
    return skip.size ? withoutRows(d.plan, skip) : d.plan;
  }

  async push(d: DryRun, log: (m: string) => void, progress: OnProgress = () => {}): Promise<PushStats> {
    const plan = this.applyAdoptions(d);
    const wfAccount = Object.fromEntries(Object.entries(d.cfg).map(([id, c]) => [id, c.wealthfolio_account_id ?? ""]));
    const byWfId = () => new Map([...d.state.rows.values()]
      .flatMap((r) => (r.wf_activity_id ? [[r.wf_activity_id, { accountId: wfAccount[r.account_id] ?? "", activityType: r.activity_type, date: r.date, currency: r.currency || "USD" }] as const] : [])));
    let index = byWfId();
    const writer = new SdkWriter(this.api, (id) => (index.get(id) ?? (index = byWfId()).get(id)) ?? null);
    try {
      const stats = await push(plan, writer, d.state, { accounts: d.cfg, log, progress });
      await this.store.saveLastSync(d.env, summary(d.plan, d.fetched, stats));
      if (d.backfill.size && !stats.failed) {
        const remap = await this.store.remap(d.env);
        await this.store.saveRemap(d.env, { ...remap, full: remap.full.filter((a) => !d.backfill.has(a)) });
      }
      return stats;
    } finally {
      await this.store.saveLedger(d.env, d.state);
      this.setView(EMPTY_VIEW);
    }
  }

  async pushAndCategorize(d: DryRun, log: (m: string) => void, progress: OnProgress = () => {}): Promise<PushStats & { categories?: string }> {
    const stats: PushStats & { categories?: string } = await this.push(d, log, progress);
    try {
      if (uncategorized(d.state, d.cfg).size || unlearned(d.state, d.cfg).length) {
        progress({ id: "push:fill", label: "Fill in missing categories", state: "running" });
        stats.categories = await this.categorize(log);
        progress({ id: "push:fill", label: "Fill in missing categories", state: "done", detail: stats.categories });
      }
    } catch (e) {
      log(`  categories not filled in: ${errText(e)}`);
    }
    return stats;
  }
}

export function nextRun(daily: Daily, rec: AutoRun, now = new Date()): Date | null {
  if (!daily.on) return null;
  const m = minutes(daily.time);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(m / 60), m % 60);
  if (rec.done === localDay(now)) at.setDate(at.getDate() + 1);
  else if (at < now) return new Date(Math.max(now.getTime(), rec.tried ? Date.parse(rec.tried) + RETRY_MS : 0));
  return at;
}

function unlearned(state: MemoryLedger, cfg: Record<string, AccountCfg>) {
  return [...state.rows.values()].filter((r) => r.category === undefined && !r.voided && r.wf_activity_id && !r.category_set
    && !r.pair_plaid_id && !cfg[r.account_id]?.skip && ["cash", "credit"].includes(cfg[r.account_id]?.kind ?? ""));
}

type SecuritySource = { inv?: Pick<InvestmentData, "securities"> | null | undefined;
  holdings?: (Pick<HoldingsData, "securities"> & NonNullable<HoldingsItem["holdings"]>) | null | undefined };

export function seenSecurities(items: SecuritySource[],
  symbols: Record<string, SecurityOverride>): Security[] {
  const out = new Map<string, Security>();
  for (const d of items) {
    for (const s of [...Object.values(d.inv?.securities ?? {}), ...(d.holdings?.securities ?? [])]) {
      if (out.has(s.security_id)) continue;
      const r = resolve(s, symbols, s.iso_currency_code || "USD");
      const rp = reportedPrice(items, s.security_id);
      out.set(s.security_id, { sid: s.security_id, name: s.name || s.security_id, ticker: s.ticker_symbol ?? null,
        type: s.type ?? null, result: securitySymbol(r) ?? r.kind, manual: r.manual,
        reported: rp ? [rp[0].toString(), rp[1]] : null, override: symbols[s.security_id] ?? null, review: false });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Proposal { sid: string; name: string; old: Track; next: Track | null; day: string; price: string; change: number | null }
export interface Security {
  sid: string; name: string; ticker: string | null; type: string | null; result: string; manual: boolean;
  reported: [string, string] | null; override: SecurityOverride | null;
  review: boolean;
  pending?: string;
}
export type SecurityMode = "auto" | "ticker" | "manual" | "cash" | "holding" | "exclude" | "track";

export function modeOf(s: Pick<Security, "override">): SecurityMode {
  const o = s.override ?? {};
  if (o.exclude) return "exclude";
  if (o.track) return "track";
  if (o.cash) return "cash";
  if (o.investment) return "holding";
  if (o.manual) return "manual";
  if (o.symbol) return "ticker";
  return "auto";
}

function tickersMatch(s: Pick<Security, "ticker" | "result" | "type">): boolean {
  if (s.ticker == null) return false;
  const [t, r] = [s.ticker.toUpperCase(), s.result.toUpperCase()];
  return t === r || (isCrypto({ type: s.type, ticker_symbol: s.ticker }) && r === cryptoSymbol(t, r.split("-")[1] || "USD"));
}

export function needsReview(s: Security, known: Record<string, boolean | null>): boolean {
  if (s.result === "unmapped") return true;
  if (modeOf(s) !== "auto") return false;
  return !((s.result === "cash" && isCurrency({ ticker_symbol: s.ticker })) || (tickersMatch(s) && known[s.result] === true));
}
export interface SecurityChoice { mode: SecurityMode; symbol?: string; track?: Track | undefined }
export interface DryRun {
  env: PlaidEnv; plan: Plan; fetched: FetchResult; todo: string[]; state: MemoryLedger; cfg: Record<string, AccountCfg>;
  tracked: Set<string>;
  backfill: Set<string>;
  rebases: Proposal[]; securities: Security[];
  adoptions: Adoption[];
}

export interface Task { label: string; running: boolean; progress: Progress[]; log: string[]; result?: unknown; error?: string }
export interface SyncView { dry?: DryRun | undefined; stale: boolean; result?: string | undefined; failed: string[]; refused: Record<string, string> }
const EMPTY_VIEW: SyncView = { stale: false, failed: [], refused: {} };

function addProgress(list: Progress[], p: Progress): Progress[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return [...list, p];
  const next = list.slice();
  next[i] = p;
  return next;
}

interface PlanInput {
  fetched: FetchResult;
  cfg: Record<string, AccountCfg>;
  state: MemoryLedger;
  tracked: Set<string>;
}

type WfActivity = Awaited<ReturnType<Api["activities"]["getAll"]>>[number];

const isoDay = (d: Date | string) => (d instanceof Date ? d.toISOString() : d).slice(0, 10);

function existingRow(a: WfActivity): Existing {
  return { id: a.id, accountId: a.accountId, type: a.activityType, symbol: a.assetSymbol || null,
    date: isoDay(a.date),
    quantity: a.quantity, amount: a.amount, comment: a.comment ?? null };
}

function dailyBlocker(d: DryRun): string | null {
  const open = d.adoptions.filter((a) => a.how !== "new").length;
  if (open) return `${open} rows may already be in Wealthfolio. Review them in Sync.`;
  const review = d.securities.filter((s) => s.review).length;
  if (review) return `${review} securities need review. Review them in Sync.`;
  if (d.plan.moved.size) return "Pushed activities now map to another ticker, to cash or to Leave out. Fix it in Sync.";
  return null;
}

function dailyNotes(d: DryRun, stats: PushStats, big: string[]): string[] {
  const notes: string[] = [];
  if (big.length) notes.push(`Ratio change to confirm in Sync: ${big.join(", ")}`);
  if (stats.failed) notes.push(`${stats.failed} rows were not saved: ${stats.failures[0]}. Fix it in Sync`);
  if (d.fetched.skipped.length) notes.push(`Reconnect in Connections: ${d.fetched.skipped.join(", ")}`);
  if (d.plan.reviews.length) notes.push("See the to-do list in Sync");
  return notes;
}

function pulledSecurity(items: FetchResult["items"], sid: string): { sec: PlaidSecurity | undefined; accts: Set<string> } {
  let sec: PlaidSecurity | undefined;
  const accts = new Set<string>();
  for (const d of items) {
    sec ??= d.inv?.securities[sid] ?? d.holdings?.securities.find((s) => s.security_id === sid);
    for (const h of d.holdings?.holdings ?? []) if (h.security_id === sid) accts.add(h.account_id);
    for (const t of d.inv?.investment_transactions ?? []) if (t.security_id === sid) accts.add(t.account_id);
  }
  return { sec, accts };
}

export interface Restored { kind: BackupKind; items: number; accounts: number; rows: number; ledger: "restored" | "none" | "other-wealthfolio"; removed: number }
export type LinkCheck = { state: "waiting" } | { state: "exited"; message: string } | { state: "done"; itemId: string; institution: string; accounts: number };

function exited(sessions: LinkSession[]): LinkCheck {
  for (const s of sessions) {
    const x = s.exit ?? s.on_exit;
    if (x || s.finished_at) {
      const e = x?.error;
      return { state: "exited", message: e ? String(e.display_message || e.error_message || e.error_code) : "You closed Plaid before finishing." };
    }
  }
  return { state: "waiting" };
}

function perAccount(p: Plan, cfg: Record<string, AccountCfg>): NonNullable<RunRecord["accounts"]> {
  const by = new Map<string, { name: string; new: number; updated: number; removed: number }>();
  const at = (aid: string) => {
    const row = by.get(aid) ?? { name: accountLabel(cfg, aid), new: 0, updated: 0, removed: 0 };
    by.set(aid, row);
    return row;
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
