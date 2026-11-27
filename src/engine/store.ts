import type { HostAPI } from '@wealthfolio/addon-sdk';
import { type AccountCfg, arrayOf, type CloseCache, isString, itemAt, MemoryLedger, shape, type PlaidEnv, type SecurityOverride } from '../importer';

export type Api = HostAPI;
export interface Daily { on: boolean; time: string }
export interface Settings { env: PlaidEnv; daily?: { time: string } }
export interface RunRecord {
  time: string; status: "ok" | "stopped" | "failed"; message: string; goto?: "connections" | "sync" | undefined;
  accounts?: { name: string; new: number; updated: number; removed: number }[];
  totals?: { new: number; updated: number; removed: number; categorized: number; failed: number };
}
export interface AutoRun { done?: string; tried?: string; runs?: RunRecord[] }
export interface Remap { full: string[]; dropped: Record<string, string[]> }
export interface ItemMeta { owner: string; institution_name: string; institution_id?: string | null | undefined; products?: string[] | undefined;
  env?: string;
  checked?: string;
  reconnect?: boolean;
  missing?: string[] | undefined;
  created?: string }

const KEYS = { dailyOn: "daily_on", clientId: "plaid_client_id", secret: (env: PlaidEnv) => `plaid_secret_${env}`, token: (id: string) => `token_${id}` };

const PART = 50_000;
type Head = { parts: string[] };
const isHead = shape<Head>({ parts: arrayOf(isString) });

function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function split(s: string, size = PART): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = Math.min(i + size, s.length);
    if (j < s.length && s.charCodeAt(j - 1) >= 0xd800 && s.charCodeAt(j - 1) <= 0xdbff) j--;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export class Store {
  private dailyWrites: Promise<void> = Promise.resolve();

  constructor(private api: Api) {}

  private head(v: string | null): Head | null {
    if (!v?.startsWith('{"parts":')) return null;
    const h: unknown = JSON.parse(v);
    return isHead(h) && Object.keys(h).length === 1 ? h : null;
  }

  private async json<T>(key: string, fallback: T): Promise<T> {
    const v = await this.api.storage.get(key);
    if (!v) return fallback;
    const h = this.head(v);
    if (!h) return JSON.parse(v) as T;
    const parts: string[] = [];
    for (const id of h.parts) {
      const part = await this.api.storage.get(`${key}.${id}`);
      if (part === null) throw new Error(`Saved data "${key}" is incomplete. Try again after Wealthfolio finishes syncing.`);
      parts.push(part);
    }
    return JSON.parse(parts.join("")) as T;
  }

  private async put(key: string, value: unknown) {
    const s = JSON.stringify(value);
    const old = this.head(await this.api.storage.get(key))?.parts ?? [];
    let keep: string[] = [];
    if (s.length <= PART && !s.startsWith('{"parts":')) {
      await this.api.storage.set(key, s);
    } else {
      const parts = split(s), ids = parts.map(hash);
      for (const [i, part] of parts.entries()) {
        const id = itemAt(ids, i);
        if (!old.includes(id)) await this.api.storage.set(`${key}.${id}`, part);
      }
      await this.api.storage.set(key, JSON.stringify({ parts: ids }));
      keep = ids;
    }
    for (const id of new Set(old)) if (!keep.includes(id)) await this.api.storage.delete(`${key}.${id}`);
  }

  settings() { return this.json<Settings>("settings", { env: "sandbox" }); }
  saveSettings(s: Settings) { return this.put("settings", s); }
  async daily(settings?: Settings): Promise<Daily> {
    const [on, s] = await Promise.all([this.api.secrets.get(KEYS.dailyOn), settings ?? this.settings()]);
    return { on: on === "on", time: s.daily?.time ?? "07:00" };
  }
  saveDaily(d: Daily): Promise<void> {
    const write = this.dailyWrites.then(() => this.writeDaily(d));
    this.dailyWrites = write.catch(() => undefined);
    return write;
  }
  private async writeDaily(d: Daily) {
    await this.api.secrets.set(KEYS.dailyOn, d.on ? "on" : "off");
    await this.saveSettings({ ...(await this.settings()), daily: { time: d.time } });
  }
  items(env: PlaidEnv) { return this.json<Record<string, ItemMeta>>(`items_${env}`, {}); }
  saveItems(env: PlaidEnv, v: Record<string, ItemMeta>) { return this.put(`items_${env}`, v); }
  accounts(env: PlaidEnv) { return this.json<Record<string, AccountCfg>>(`accounts_${env}`, {}); }
  saveAccounts(env: PlaidEnv, v: Record<string, AccountCfg>) { return this.put(`accounts_${env}`, v); }
  symbols(env: PlaidEnv) { return this.json<Record<string, SecurityOverride>>(`symbols_${env}`, {}); }
  remap(env: PlaidEnv) { return this.json<Remap>(`remap_${env}`, { full: [], dropped: {} }); }
  saveRemap(env: PlaidEnv, v: Remap) { return this.put(`remap_${env}`, v); }
  saveSymbols(env: PlaidEnv, v: Record<string, SecurityOverride>) { return this.put(`symbols_${env}`, v); }
  async ledger(env: PlaidEnv) { return new MemoryLedger(await this.json(`ledger_${env}`, {})); }
  saveLedger(env: PlaidEnv, l: MemoryLedger) { return this.put(`ledger_${env}`, l.toJSON()); }
  prices() { return this.json<CloseCache>("prices", {}); }
  savePrices(c: CloseCache) { return this.put("prices", c); }
  lastSync(env: PlaidEnv) { return this.json<{ time: string; message: string } | null>(`last_${env}`, null); }
  saveLastSync(env: PlaidEnv, message: string) { return this.put(`last_${env}`, { time: new Date().toISOString(), message }); }
  autoRun(env: PlaidEnv) { return this.json<AutoRun>(`auto_${env}`, {}); }
  saveAutoRun(env: PlaidEnv, v: AutoRun) { return this.put(`auto_${env}`, v); }
  dailyLock(env: PlaidEnv) { return this.json<{ id: string; at: string } | null>(`daily_lock_${env}`, null); }
  saveDailyLock(env: PlaidEnv, v: { id: string; at: string } | null) { return this.put(`daily_lock_${env}`, v); }

  async keys(env: PlaidEnv) {
    return { clientId: await this.api.secrets.get(KEYS.clientId), secret: await this.api.secrets.get(KEYS.secret(env)) };
  }
  async saveKeys(env: PlaidEnv, clientId: string, secret: string) {
    await this.api.secrets.set(KEYS.clientId, clientId.trim());
    await this.api.secrets.set(KEYS.secret(env), secret.trim());
  }
  token(itemId: string) { return this.api.secrets.get(KEYS.token(itemId)); }
  saveToken(itemId: string, t: string) { return this.api.secrets.set(KEYS.token(itemId), t); }
  deleteToken(itemId: string) { return this.api.secrets.delete(KEYS.token(itemId)); }
}
