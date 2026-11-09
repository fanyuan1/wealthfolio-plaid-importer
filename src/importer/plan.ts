// Plan a sync against the ledger: what is new, changed, voided, paired and categorized. Pure apart from
// ledger reads; fetching and pushing live in the paths that use it.
import { mapCategory } from "./categories";
import { type Dec, dec, ZERO } from "./dec";
import { type Ledger, type LedgerRow, differs } from "./ledger";
import { mapInvestmentTransactions } from "./mapInvestments";
import { biltPassthrough, mapBankTransaction } from "./mapTransactions";
import { Activity, type Review, review, type Row } from "./models";
import { fixSplitPrices, type HoldingMap, holdingsBySymbol, openingActivities, positions, reconcile, resolveSplits } from "./positions";
import { yahooSymbol } from "./securities";
import { convert } from "./tracking";
import { MAX_DAYS, matchTransfers } from "./transfers";

export const HISTORY_DAYS = 729; // Plaid investments allow 24 months
const ANCHOR_DAYS = 31; // an account rebuilt within this many days of the first pull reuses its history start
export const OVERLAP_DAYS = 14;
export const BLOCKING_ITEM_ERRORS = new Set(["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS", "USER_SETUP_REQUIRED", "MFA_NOT_SUPPORTED", "NO_ACCOUNTS"]);
const BROKERAGE_WINDOW = /self[- ]?directed|brokerage ?(link|window|account)|sdba|schwab/i;

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Date for a new opening row. Plaid's window starts 729 days before the run, so an account reimported or
 * re-priced a day later would open a day later than the rest. Reuse the other accounts' history start when it
 * is close; an account linked much later opens at its own window start. */
export function openingDay(state: Ledger, windowStart: string): string {
  const anchor = state.historyStart();
  if (anchor && anchor < windowStart && dayDiff(windowStart, anchor) <= ANCHOR_DAYS) return anchor;
  return windowStart;
}

export interface AccountCfg {
  item_id: string; kind: string; skip?: boolean; currency?: string; plaid_subtype?: string; name?: string;
  wealthfolio_account_id?: string | null; match?: string; [k: string]: unknown;
}

/** An account's name as the addon shows it; the Plaid account id when it has none. */
export const accountLabel = (cfg: Record<string, AccountCfg>, aid: string) => String(cfg[aid]?.name ?? aid);
export const accountNames = (cfg: Record<string, AccountCfg>) => Object.fromEntries(Object.keys(cfg).map((aid) => [aid, accountLabel(cfg, aid)]));

export function activeAccounts(cfg: Record<string, AccountCfg>, itemId: string): Record<string, AccountCfg> {
  return Object.fromEntries(Object.entries(cfg).filter(([, a]) => a.item_id === itemId && !a.skip));
}

export interface ItemData {
  itemId: string;
  owner: string;
  institution: string;
  inv?: Row | null; // investment_transactions result
  holdings?: Row | null;
  invStart: Record<string, string>; // account_id -> window start
  tx?: Row | null; // transactions_sync result
  firstTxSync?: boolean;
  balances?: Record<string, Row>; // account_id -> balances
}

export interface Plan {
  new: Activity[];
  updates: [LedgerRow, Activity, string[]][];
  voids: LedgerRow[];
  retype: [string, string, string][]; // (plaid_id, type, pair plaid_id)
  pairs: [string, string][]; // (out plaid_id, in plaid_id)
  categories: Map<string, [string, string]>; // plaid_id -> (taxonomy, key)
  reviews: Review[];
  cursors: Record<string, string>;
  invLastEnd: Record<string, string>;
  unmapped: Map<string, string>;
  // old symbol -> accounts: pushed rows whose security now maps to another symbol. Wealthfolio cannot move
  // them to a new asset, so they are deleted and imported again before any push.
  moved: Map<string, Set<string>>;
}

export type ClosesFn = (symbol: string | null, day: string) => Dec | null;

function earliest(acts: Activity[], aid: string, today: string): string {
  const ds = acts.filter((a) => a.accountId === aid).map((a) => a.date);
  return ds.length ? ds.reduce((m, d) => (d < m ? d : m)) : today;
}

/** backfill: accounts whose opening rows are rebuilt from the ledger plus a full re-pull, so a security mapped
 * after the first push (from unmapped, cash or Leave out) gets its history and opening position. */
export function plan(items: ItemData[], accountsCfg: Record<string, AccountCfg>, symbols: Record<string, Row>,
  state: Ledger, today: string, backfill: Set<string> = new Set(), closes?: ClosesFn): Plan {
  const p: Plan = {
    new: [], updates: [], voids: [], retype: [], pairs: [], categories: new Map(), reviews: [],
    cursors: {}, invLastEnd: {}, unmapped: new Map(), moved: new Map(),
  };
  let batch: Activity[] = [];
  const cancelled = new Set<string>();
  const removed = new Set<string>();
  const holdingsAll: HoldingMap = new Map();
  const invAccounts = new Set<string>();
  const balanceOnly = new Set<string>();

  for (const d of items) {
    const accts = activeAccounts(accountsCfg, d.itemId);
    if (d.inv != null) {
      const ids = new Set(Object.keys(accts).filter((a) => accts[a].kind === "investment"));
      for (const a of ids) invAccounts.add(a);
      let secs: Record<string, Row> = { ...d.inv.securities };
      for (const s of d.holdings?.securities ?? []) secs[s.security_id] = s;
      let rows: Row[] = (d.inv.investment_transactions as Row[]).filter((t) => ids.has(t.account_id)
        && String(t.date) >= d.invStart[t.account_id]);
      let allHoldings: Row[] = d.holdings?.holdings ?? [];
      [rows, allHoldings, secs] = convert(rows, allHoldings, secs, symbols);
      const plans = new Set([...ids].filter((a) => accts[a].plaid_subtype === "stock plan"));
      const r = mapInvestmentTransactions(rows, secs, symbols, "USD", plans);

      const s = secs;
      const priceOn = (sid: string, day: string): Dec | null => {
        if (!closes) return null;
        const o = symbols[sid] ?? {}; // Plaid has no ticker: the one the user typed in Securities
        return closes(yahooSymbol(s[sid]) || (!o.manual ? o.symbol ?? null : null), day);
      };
      for (const a of r.activities) {
        if (a.marketPrice) {
          const px = priceOn(a.securityId!, a.date);
          a.unitPrice = px && !px.eq(0) ? px : ZERO;
          if (a.unitPrice.eq(0)) {
            p.reviews.push(review(a.accountId, a.plaidId, a.date, "vest price unknown",
              `${a.symbol}: no market close found; set the price in Wealthfolio`));
          }
        }
      }
      for (const c of r.cancelledIds) cancelled.add(c);
      p.reviews.push(...r.reviews);
      for (const [k, v] of r.unmappedSecurities) p.unmapped.set(k, v);
      const holdings = allHoldings.filter((h) => ids.has(h.account_id));
      const seen = new Set([...holdings.map((h) => h.account_id),
        ...(d.inv.investment_transactions as Row[]).map((t) => t.account_id)]);
      for (const a of d.holdings?.accounts ?? []) {
        const bal = dec(a.balances?.current) ?? ZERO;
        if (ids.has(a.account_id) && !seen.has(a.account_id) && bal.gt(1)) {
          balanceOnly.add(a.account_id); // positions entered by hand; nothing to check them against
          if (!state.hasAny(a.account_id)) {
            // e.g. a brokerage window: Plaid sends the balance only
            p.reviews.push(review(a.account_id, a.account_id, "", "no holdings from Plaid",
              `balance ${bal}, but Plaid sends no holdings or activity`));
          }
        }
      }
      const [hs, cash, unmappedH] = holdingsBySymbol(holdings, secs, symbols);
      for (const [k, v] of hs) holdingsAll.set(k, v);
      for (const h of unmappedH) {
        const sec = secs[h.security_id] ?? {};
        if (!p.unmapped.has(h.security_id)) p.unmapped.set(h.security_id, sec.name || "");
        if (BROKERAGE_WINDOW.test(sec.name || "")) {
          p.reviews.push(review(h.account_id, h.security_id, "", "possible brokerage window",
            `${sec.name}: if this mirrors another linked account, choose Leave out in Securities`));
        }
      }
      for (const aid of ids) {
        let acts = r.activities.filter((a) => a.accountId === aid);
        const cur = accts[aid].currency || "USD";
        if (state.invLastEnd(aid) === null && !state.hasOpening(aid)) {
          const [op, rv] = openingActivities(aid, openingDay(state, d.invStart[aid]), hs, cash.get(aid) ?? null, acts, cur, priceOn);
          acts = [...op, ...acts];
          p.reviews.push(...rv);
        } else if (backfill.has(aid)) {
          // Every change since the original opening date: pushed rows plus anything new.
          const known = new Map<string, Activity>();
          for (const a of state.activities(new Set([aid]))) if (!a.plaidId.startsWith("opening:")) known.set(a.plaidId, a);
          for (const a of acts) known.set(a.plaidId, a);
          const [op, rv] = openingActivities(aid, state.openingDate(aid) || openingDay(state, d.invStart[aid]), hs,
            cash.get(aid) ?? null, [...known.values()], cur, priceOn);
          acts = [...op, ...acts]; // new opening rows are added; changed ones become updates
          p.reviews.push(...rv);
        }
        batch.push(...acts);
        p.invLastEnd[aid] = today;
      }
    }
    if (d.tx != null) {
      const kinds: Record<string, string> = {};
      for (const [a, c] of Object.entries(accts)) if (c.kind === "cash" || c.kind === "credit") kinds[a] = c.kind;
      const rows: Row[] = [...d.tx.added, ...d.tx.modified];
      const drop = biltPassthrough(rows);
      let acts: Activity[] = [];
      for (const t of rows) {
        if (!(t.account_id in kinds) || drop.has(t.transaction_id)) continue;
        const x = mapBankTransaction(t, kinds[t.account_id]);
        if (x) acts.push(x);
      }
      for (const t of d.tx.removed as Row[]) removed.add(t.transaction_id);
      if (d.firstTxSync) {
        for (const [aid, kind] of Object.entries(kinds)) {
          if (state.hasOpening(aid)) continue;
          let current = dec((d.balances ?? {})[aid]?.current);
          if (current === null) continue;
          if (kind === "credit") current = current.neg(); // Plaid reports card debt as a positive balance
          const [op, rv] = openingActivities(aid, earliest(acts, aid, today), new Map(), current,
            acts.filter((a) => a.accountId === aid), accts[aid].currency || "USD");
          acts = [...op, ...acts];
          p.reviews.push(...rv);
        }
      }
      batch.push(...acts);
      p.cursors[d.itemId] = d.tx.next_cursor;
    }
  }

  // Ledger rows for the accounts we touched, to compute split ratios and positions.
  const touched = new Set(batch.map((a) => a.accountId));
  const ledgerActs = state.activities(touched);
  const batchIds = new Set(batch.map((a) => a.plaidId));
  const everything = [...ledgerActs.filter((a) => !batchIds.has(a.plaidId)), ...batch];
  p.reviews.push(...resolveSplits(everything));
  if (closes) p.reviews.push(...fixSplitPrices(batch, everything, closes));

  for (const a of batch) {
    const row = state.get(a.plaidId);
    if (row === null) {
      p.new.push(a);
    } else if (!row.voided) {
      a.pairId = row.pair_plaid_id;
      if (row.pair_plaid_id) a.activityType = row.activity_type;
      const fields = differs(row, a);
      if (fields.includes("symbol") && row.symbol) {
        if (!p.moved.has(row.symbol)) p.moved.set(row.symbol, new Set());
        p.moved.get(row.symbol)!.add(a.accountId);
      } else if (fields.length) {
        p.updates.push([row, a, fields]);
      }
    }
  }
  for (const pid of new Set([...cancelled, ...removed])) {
    const row = state.get(pid);
    if (row !== null && !row.voided) p.voids.push(row);
  }

  // Transfers: new legs plus unpaired ledger legs near them.
  if (p.new.length) {
    const since = addDays(p.new.map((a) => a.date).reduce((m, d) => (d < m ? d : m)), -MAX_DAYS);
    const voidedIds = new Set(p.voids.map((r) => r.plaid_id));
    const existing = state.activities(null, since).filter((a) => !batchIds.has(a.plaidId) && !voidedIds.has(a.plaidId));
    const newIds = new Set(p.new.map((a) => a.plaidId));
    for (const [o, i] of matchTransfers([...p.new, ...existing])) {
      p.pairs.push([o.plaidId, i.plaidId]);
      for (const leg of [o, i]) if (!newIds.has(leg.plaidId)) p.retype.push([leg.plaidId, leg.activityType, leg.pairId!]);
    }
  }

  for (const a of p.new) {
    const c = categoryOf(accountsCfg[a.accountId]?.kind, a.category, a.pairId, a.activityType);
    if (c) p.categories.set(a.plaidId, c);
  }

  if (holdingsAll.size) {
    const voidIds = new Set(p.voids.map((r) => r.plaid_id));
    const pushed = state.activities(invAccounts).filter((a) => !voidIds.has(a.plaidId));
    const pushedIds = new Set(pushed.map((a) => a.plaidId));
    const pending = new Set([...invAccounts].filter((a) => !balanceOnly.has(a)));
    p.reviews.push(...reconcile(pending, positions([...pushed, ...p.new.filter((a) => !pushedIds.has(a.plaidId))]), holdingsAll));
  }
  // balance-only accounts hold hand-entered positions, so "holdings 0" says nothing about them
  p.reviews = p.reviews.filter((r) => !(balanceOnly.has(r.accountId) && r.reason === "negative opening position"));
  return p;
}

/** The Spending category of a bank or card row: Plaid's category mapped, or null. A transfer leg gets none. */
function categoryOf(kind: string | undefined, pfc: string | null | undefined, pairId: string | null, activityType: string): [string, string] | null {
  if (!pfc || pairId || (kind !== "cash" && kind !== "credit")) return null;
  return mapCategory(pfc, ["DEPOSIT", "CREDIT", "INTEREST"].includes(activityType));
}

/** Pushed bank and card rows whose Spending category is not set yet, from the Plaid category kept with each row.
 * Mapping now means a changed mapping also reaches older rows. */
export function uncategorized(state: { rows: Map<string, LedgerRow> }, cfg: Record<string, AccountCfg>): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const r of state.rows.values()) {
    if (r.voided || !r.wf_activity_id || r.category_set) continue;
    const c = categoryOf(cfg[r.account_id]?.kind, r.category, r.pair_plaid_id, r.activity_type);
    if (c) out.set(r.plaid_id, c);
  }
  return out;
}
