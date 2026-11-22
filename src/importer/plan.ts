import { valueAt } from "./at";
import { mapCategory } from "./categories";
import { type Dec, dec, ZERO } from "./dec";
import { type Ledger, type LedgerRow, differs } from "./ledger";
import { mapInvestmentTransactions } from "./mapInvestments";
import { biltPassthrough, mapBankTransaction } from "./mapTransactions";
import { Activity, type Review, review } from "./models";
import type { HoldingsData, InvestmentData, PlaidBalances, PlaidSecurity, TransactionsData } from "./plaidTypes";
import { fixSplitPrices, type HoldingMap, holdingsBySymbol, openingActivities, positions, reconcile, resolveSplits } from "./positions";
import { type SecurityOverride, yahooSymbol } from "./securities";
import { convert } from "./tracking";
import { MAX_DAYS, matchTransfers } from "./transfers";

export const HISTORY_DAYS = 729;
const ANCHOR_DAYS = 31;
export const OVERLAP_DAYS = 14;
export const BLOCKING_ITEM_ERRORS = new Set(["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS", "USER_SETUP_REQUIRED", "MFA_NOT_SUPPORTED", "NO_ACCOUNTS"]);
const BROKERAGE_WINDOW = /self[- ]?directed|brokerage ?(link|window|account)|sdba|schwab/i;

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function openingDay(state: Ledger, windowStart: string): string {
  const anchor = state.historyStart();
  if (anchor && anchor < windowStart && dayDiff(windowStart, anchor) <= ANCHOR_DAYS) return anchor;
  return windowStart;
}

export interface AccountCfg {
  item_id: string; kind: string; skip?: boolean; currency?: string; plaid_subtype?: string; plaid_type?: string; name?: string;
  wealthfolio_account_id?: string | null; match?: string; owner?: string; institution?: string; institution_id?: string | null | undefined;
  plaid_name?: string; mask?: string; joint?: boolean; not_joint?: boolean;
}

export const accountLabel = (cfg: Record<string, AccountCfg>, aid: string) => cfg[aid]?.name ?? aid;
export const accountNames = (cfg: Record<string, AccountCfg>) => Object.fromEntries(Object.keys(cfg).map((aid) => [aid, accountLabel(cfg, aid)]));

export function activeAccounts(cfg: Record<string, AccountCfg>, itemId: string): Record<string, AccountCfg> {
  return Object.fromEntries(Object.entries(cfg).filter(([, a]) => a.item_id === itemId && !a.skip));
}

export interface ItemData {
  itemId: string;
  owner: string;
  institution: string;
  inv?: InvestmentData | null;
  holdings?: HoldingsData | null;
  invStart: Record<string, string>;
  tx?: TransactionsData | null;
  firstTxSync?: boolean;
  balances?: Record<string, PlaidBalances>;
}

export interface Plan {
  new: Activity[];
  updates: [LedgerRow, Activity, string[]][];
  voids: LedgerRow[];
  retype: [string, string, string][];
  pairs: [string, string][];
  categories: Map<string, [string, string]>;
  reviews: Review[];
  cursors: Record<string, string>;
  invLastEnd: Record<string, string>;
  fullHistory: string[];
  unmapped: Map<string, string>;
  moved: Map<string, Set<string>>;
}

export type ClosesFn = (symbol: string | null, day: string) => Dec | null;

function earliest(acts: Activity[], aid: string, today: string): string {
  const ds = acts.filter((a) => a.accountId === aid).map((a) => a.date);
  return ds.length ? ds.reduce((m, d) => (d < m ? d : m)) : today;
}

export interface PlanConfig {
  accounts: Record<string, AccountCfg>;
  symbols: Record<string, SecurityOverride>;
}

export interface PlanRun {
  today: string;
  backfill?: Set<string>;
  closes?: ClosesFn | undefined;
}

export function plan(items: ItemData[], config: PlanConfig, state: Ledger, run: PlanRun): Plan {
  const planner = new Planner(config, state, run);
  for (const d of items) planner.addItem(d);
  return planner.finish();
}

type PriceOn = (sid: string, day: string) => Dec | null;
type MappedInvestments = ReturnType<typeof mapInvestmentTransactions>;

interface InvestmentItem {
  d: ItemData;
  inv: InvestmentData;
  accts: Record<string, AccountCfg>;
  ids: Set<string>;
}

class Planner {
  readonly p: Plan = {
    new: [], updates: [], voids: [], retype: [], pairs: [], categories: new Map(), reviews: [],
    cursors: {}, invLastEnd: {}, fullHistory: [], unmapped: new Map(), moved: new Map(),
  };
  private readonly batch: Activity[] = [];
  private readonly cancelled = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly holdingsAll: HoldingMap = new Map();
  private readonly invAccounts = new Set<string>();
  private readonly balanceOnly = new Set<string>();
  private readonly backfill: Set<string>;

  constructor(private readonly config: PlanConfig, private readonly state: Ledger, private readonly run: PlanRun) {
    this.backfill = run.backfill ?? new Set();
  }

  addItem(d: ItemData): void {
    const accts = activeAccounts(this.config.accounts, d.itemId);
    if (d.inv != null) {
      const ids = new Set(Object.keys(accts).filter((a) => valueAt(accts, a).kind === "investment"));
      this.addInvestments({ d, inv: d.inv, accts, ids });
    }
    if (d.tx != null) this.addTransactions(d, d.tx, accts);
  }

  private addInvestments(item: InvestmentItem): void {
    const { d, inv, accts, ids } = item;
    for (const a of ids) this.invAccounts.add(a);
    let secs: Record<string, PlaidSecurity> = { ...inv.securities };
    for (const s of d.holdings?.securities ?? []) secs[s.security_id] = s;
    let rows = inv.investment_transactions.filter((t) => ids.has(t.account_id)
      && t.date >= valueAt(d.invStart, t.account_id));
    let allHoldings = d.holdings?.holdings ?? [];
    [rows, allHoldings, secs] = convert(rows, allHoldings, secs, this.config.symbols);
    const plans = new Set([...ids].filter((a) => valueAt(accts, a).plaid_subtype === "stock plan"));
    const r = mapInvestmentTransactions(rows, secs, this.config.symbols, { currency: "USD", stockPlan: plans });
    const priceOn = this.priceLookup(secs);

    this.priceVests(r, priceOn);
    for (const c of r.cancelledIds) this.cancelled.add(c);
    this.p.reviews.push(...r.reviews);
    for (const [k, v] of r.unmappedSecurities) this.p.unmapped.set(k, v);

    const holdings = allHoldings.filter((h) => ids.has(h.account_id));
    const seen = new Set([...holdings.map((h) => h.account_id), ...inv.investment_transactions.map((t) => t.account_id)]);
    this.noteBalanceOnly(d, ids, seen);

    const [hs, cash, unmappedH] = holdingsBySymbol(holdings, secs, this.config.symbols);
    for (const [k, v] of hs) this.holdingsAll.set(k, v);
    this.noteUnmappedHoldings(unmappedH, secs);

    for (const aid of ids) {
      const acts = this.withOpenings(item, aid, r.activities.filter((a) => a.accountId === aid), { hs, cash: cash.get(aid) ?? null, priceOn });
      this.batch.push(...acts);
      this.p.invLastEnd[aid] = this.run.today;
      if (valueAt(d.invStart, aid) <= addDays(this.run.today, -HISTORY_DAYS)) this.p.fullHistory.push(aid);
    }
  }

  private priceLookup(secs: Record<string, PlaidSecurity>): PriceOn {
    const { closes } = this.run;
    const { symbols } = this.config;
    return (sid, day) => {
      if (!closes) return null;
      const o = symbols[sid] ?? {};
      return closes(yahooSymbol(secs[sid]) || (o.manual ? null : o.symbol ?? null), day);
    };
  }

  private priceVests(r: MappedInvestments, priceOn: PriceOn): void {
    for (const a of r.activities) {
      if (!a.marketPrice || a.securityId === null) continue;
      const px = priceOn(a.securityId, a.date);
      a.unitPrice = px && !px.eq(0) ? px : ZERO;
      if (a.unitPrice.eq(0)) {
        this.p.reviews.push(review({ accountId: a.accountId, plaidId: a.plaidId, date: a.date }, "vest price unknown", `${a.symbol}: no market close found; set the price in Wealthfolio`));
      }
    }
  }

  private noteBalanceOnly(d: ItemData, ids: Set<string>, seen: Set<string>): void {
    for (const a of d.holdings?.accounts ?? []) {
      const bal = dec(a.balances.current) ?? ZERO;
      if (!ids.has(a.account_id) || seen.has(a.account_id) || !bal.gt(1)) continue;
      this.balanceOnly.add(a.account_id);
      if (!this.state.hasAny(a.account_id)) {
        this.p.reviews.push(review({ accountId: a.account_id, plaidId: a.account_id, date: "" }, "no holdings from Plaid", `balance ${String(bal)}, but Plaid sends no holdings or activity`));
      }
    }
  }

  private noteUnmappedHoldings(unmapped: { account_id: string; security_id: string }[], secs: Record<string, PlaidSecurity>): void {
    for (const h of unmapped) {
      const secName = secs[h.security_id]?.name || "";
      if (!this.p.unmapped.has(h.security_id)) this.p.unmapped.set(h.security_id, secName);
      if (BROKERAGE_WINDOW.test(secName)) {
        this.p.reviews.push(review({ accountId: h.account_id, plaidId: h.security_id, date: "" }, "possible brokerage window", `${secName}: if this mirrors another linked account, choose Leave out in Securities`));
      }
    }
  }

  private withOpenings(item: InvestmentItem, aid: string, acts: Activity[],
    held: { hs: HoldingMap; cash: Dec | null; priceOn: PriceOn }): Activity[] {
    const { state } = this;
    const cur = valueAt(item.accts, aid).currency || "USD";
    const windowStart = openingDay(state, valueAt(item.d.invStart, aid));
    if (!state.hasAny(aid)) {
      const [op, rv] = openingActivities({ accountId: aid, date: windowStart, cash: held.cash, currency: cur }, held.hs, acts, held.priceOn);
      this.p.reviews.push(...rv);
      return [...op, ...acts];
    }
    if (!this.backfill.has(aid) && !hasLateRows(state, aid, acts) && state.hasFullHistory(aid)) return acts;
    const known = new Map<string, Activity>();
    for (const a of state.activities(new Set([aid]))) if (!a.plaidId.startsWith("opening:")) known.set(a.plaidId, a);
    for (const a of acts) known.set(a.plaidId, a);
    const [op, rv] = openingActivities({ accountId: aid, date: state.openingDate(aid) || windowStart, cash: held.cash, currency: cur },
      held.hs, [...known.values()], held.priceOn);
    this.p.reviews.push(...rv);
    return [...op, ...acts];
  }

  private addTransactions(d: ItemData, tx: TransactionsData, accts: Record<string, AccountCfg>): void {
    const kinds: Record<string, string> = {};
    for (const [a, c] of Object.entries(accts)) if (c.kind === "cash" || c.kind === "credit") kinds[a] = c.kind;
    const rows = [...tx.added, ...tx.modified];
    const drop = biltPassthrough(rows);
    let acts: Activity[] = [];
    for (const t of rows) {
      if (!(t.account_id in kinds) || drop.has(t.transaction_id)) continue;
      const x = mapBankTransaction(t, valueAt(kinds, t.account_id));
      if (x) acts.push(x);
    }
    for (const t of tx.removed) this.removed.add(t.transaction_id);
    if (d.firstTxSync) acts = this.withCashOpenings(d, kinds, acts, accts);
    this.batch.push(...acts);
    this.p.cursors[d.itemId] = tx.next_cursor;
  }

  private withCashOpenings(d: ItemData, kinds: Record<string, string>, acts: Activity[], accts: Record<string, AccountCfg>): Activity[] {
    for (const [aid, kind] of Object.entries(kinds)) {
      if (this.state.hasOpening(aid)) continue;
      let current = dec((d.balances ?? {})[aid]?.current);
      if (current === null) continue;
      if (kind === "credit") current = current.neg();
      const at = { accountId: aid, date: earliest(acts, aid, this.run.today), cash: current, currency: valueAt(accts, aid).currency || "USD" };
      const [op, rv] = openingActivities(at, new Map(), acts.filter((a) => a.accountId === aid));
      acts = [...op, ...acts];
      this.p.reviews.push(...rv);
    }
    return acts;
  }

  finish(): Plan {
    const { p, batch, state } = this;
    const batchIds = new Set(batch.map((a) => a.plaidId));
    const ledgerActs = state.activities(new Set(batch.map((a) => a.accountId)));
    const everything = [...ledgerActs.filter((a) => !batchIds.has(a.plaidId)), ...batch];
    p.reviews.push(...resolveSplits(everything));
    if (this.run.closes) p.reviews.push(...fixSplitPrices(batch, everything, this.run.closes));

    for (const a of batch) this.classify(a);
    for (const pid of new Set([...this.cancelled, ...this.removed])) {
      const row = state.get(pid);
      if (row !== null && !row.voided) p.voids.push(row);
    }
    if (p.new.length) this.pairTransfers(batchIds);
    for (const a of p.new) {
      const c = categoryOf(this.config.accounts[a.accountId]?.kind, a.category, a.pairId, a.activityType);
      if (c) p.categories.set(a.plaidId, c);
    }
    if (this.holdingsAll.size) this.reconcileHoldings();
    p.reviews = p.reviews.filter((r) => !(this.balanceOnly.has(r.accountId) && r.reason === "negative opening position"));
    return p;
  }

  private classify(a: Activity): void {
    const row = this.state.get(a.plaidId);
    if (row === null) {
      this.p.new.push(a);
      return;
    }
    if (row.voided) return;
    a.pairId = row.pair_plaid_id;
    if (row.pair_plaid_id) a.activityType = row.activity_type;
    const fields = differs(row, a);
    if (fields.includes("symbol") && row.symbol) {
      const moved = this.p.moved.get(row.symbol) ?? new Set<string>();
      this.p.moved.set(row.symbol, moved.add(a.accountId));
    } else if (fields.length) {
      this.p.updates.push([row, a, fields]);
    }
  }

  private pairTransfers(batchIds: Set<string>): void {
    const { p } = this;
    const since = addDays(p.new.map((a) => a.date).reduce((m, d) => (d < m ? d : m)), -MAX_DAYS);
    const voidedIds = new Set(p.voids.map((r) => r.plaid_id));
    const existing = this.state.activities(null, since).filter((a) => !batchIds.has(a.plaidId) && !voidedIds.has(a.plaidId));
    const newIds = new Set(p.new.map((a) => a.plaidId));
    for (const [o, i] of matchTransfers([...p.new, ...existing])) {
      p.pairs.push([o.plaidId, i.plaidId]);
      for (const leg of [o, i]) if (!newIds.has(leg.plaidId) && leg.pairId !== null) p.retype.push([leg.plaidId, leg.activityType, leg.pairId]);
    }
  }

  private reconcileHoldings(): void {
    const { p } = this;
    const voidIds = new Set(p.voids.map((r) => r.plaid_id));
    const updated = new Map(p.updates.map(([, a]) => [a.plaidId, a]));
    const pushed = this.state.activities(this.invAccounts).filter((a) => !voidIds.has(a.plaidId)).map((a) => updated.get(a.plaidId) ?? a);
    const pushedIds = new Set(pushed.map((a) => a.plaidId));
    const pending = new Set([...this.invAccounts].filter((a) => !this.balanceOnly.has(a)));
    const fresh = p.new.filter((a) => !pushedIds.has(a.plaidId));
    p.reviews.push(...reconcile(pending, positions([...pushed, ...fresh]), this.holdingsAll, fresh));
  }
}

function hasLateRows(state: Ledger, aid: string, acts: Activity[]): boolean {
  const last = state.invLastEnd(aid);
  return last !== null && acts.some((a) => a.date < last && state.get(a.plaidId) === null && !a.positionDelta().eq(0));
}

function categoryOf(kind: string | undefined, pfc: string | null | undefined, pairId: string | null, activityType: string): [string, string] | null {
  if (!pfc || pairId || (kind !== "cash" && kind !== "credit")) return null;
  return mapCategory(pfc, ["DEPOSIT", "CREDIT", "INTEREST"].includes(activityType));
}

export function uncategorized(state: { rows: Map<string, LedgerRow> }, cfg: Record<string, AccountCfg>): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const r of state.rows.values()) {
    if (r.voided || !r.wf_activity_id || r.category_set) continue;
    const c = categoryOf(cfg[r.account_id]?.kind, r.category, r.pair_plaid_id, r.activity_type);
    if (c) out.set(r.plaid_id, c);
  }
  return out;
}
