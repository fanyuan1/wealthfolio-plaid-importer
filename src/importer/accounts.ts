// Plaid accounts -> the addon's account settings and Wealthfolio account names.
import ABBREV_DATA from "./abbreviations.json";
import type { Row } from "./models";
import type { AccountCfg } from "./plan";

export const MAX_LEN = 50; // Wealthfolio's account form limit
const INST_MIN = 12; // an unabbreviated institution name is trimmed to no less than this
const KIND_BY_PLAID_TYPE: Record<string, string> = { investment: "investment", depository: "cash", credit: "credit" };
export const WF_TYPE: Record<string, string> = { investment: "SECURITIES", cash: "CASH", credit: "CREDIT_CARD" };
const NON_EUR: Record<string, string> = { US: "USD", CA: "CAD", GB: "GBP", DK: "DKK", NO: "NOK", SE: "SEK", PL: "PLN" };

const currencyFor = (country?: string | null): string => NON_EUR[(country || "US").toUpperCase()] ?? "EUR";
// Lower-case institution name -> short name for account names.
const ABBREV: Record<string, string> = ABBREV_DATA;

/** Abbreviation from the dictionary, else Plaid's name unchanged. */
export function shortName(name: string): string {
  const n = (name || "").trim();
  const low = n.toLowerCase();
  let best = "";
  for (const key of Object.keys(ABBREV)) if ((low === key || low.startsWith(key + " ")) && key.length > best.length) best = key;
  return best ? ABBREV[best] : n || "Bank";
}

const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(n - 1, 1)).trimEnd() + "…");

/** Unique and at most 50 characters. */
export function accountName(owner: string, institution: string, plaidName: string | null | undefined, mask: string | null | undefined,
  taken: Set<string> = new Set()): string {
  const head = `${owner} · `;
  let inst = shortName(institution);
  const tail = mask ? ` ••${mask}` : "";
  // Sandbox (and some real) account names carry the word Plaid; it adds nothing.
  let body = (plaidName || "").replace(/\bplaid\b/gi, "").replace(/\s{2,}/g, " ").trim() || "Account";
  const room = MAX_LEN - head.length - tail.length - 1; // for "inst body"
  if (inst.length + body.length > room) {
    // Trim the institution first: the account name and mask tell accounts apart.
    inst = trim(inst, Math.max(INST_MIN, room - body.length));
    body = trim(body, room - inst.length);
  }
  const base = `${head}${inst} ${body}${tail}`;
  const low = new Set([...taken].map((t) => t.toLowerCase()));
  let name = base;
  for (let n = 2; low.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, MAX_LEN - suffix.length) + suffix;
  }
  return name;
}

/** Depository accounts that hold securities in Plaid holdings: brokerage cash-management accounts. */
export function holdsSecurities(accounts: Row[], holdings: Row | null): Set<string> {
  const cands = new Set(accounts.filter((a) => String(a.type) === "depository").map((a) => a.account_id));
  if (!cands.size || !holdings) return new Set();
  const secs: Record<string, Row> = Object.fromEntries((holdings.securities ?? []).map((s: Row) => [s.security_id, s]));
  return new Set((holdings.holdings ?? []).filter((x: Row) => {
    const s = secs[x.security_id] ?? {};
    return cands.has(x.account_id) && !s.is_cash_equivalent && !["cash", "other", undefined, null].includes(s.type);
  }).map((x: Row) => x.account_id));
}

// Plaid has no joint flag. Identity owners (when linked) or the account's own name say so.
const JOINT_NAME = /\b(joint|jt|jtwros|jtten)\b/i;

/** A joint account is linked under each owner with different Plaid ids: same institution, mask and subtype. */
export function jointByMask(cfg: Record<string, AccountCfg>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const [id, c] of Object.entries(cfg)) {
    const mask = String(c.mask ?? "");
    if (!mask || c.not_joint) continue;
    const k = [c.institution_id, mask, c.plaid_subtype].join("|");
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  return new Set([...groups.values()].filter((ids) => new Set(ids.map((i) => cfg[i].owner)).size > 1).flat());
}

/** The second and later copies of each joint account linked under several owners, in name order: the ones not to sync
 * when the first one is. */
export function jointCopies(cfg: Record<string, AccountCfg>): string[] {
  const joint = jointByMask(cfg);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [id, c] of Object.entries(cfg).filter(([x]) => joint.has(x)).sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name)))) {
    const k = [c.institution_id, c.mask, c.plaid_subtype].join("|");
    if (seen.has(k)) out.push(id);
    else seen.add(k);
  }
  return out;
}

/** Account ids with more than one owner, from /identity/get. */
export function jointOwners(identity: Row | null): Set<string> {
  return new Set((identity?.accounts ?? []).filter((a: Row) => (a.owners ?? []).length > 1).map((a: Row) => a.account_id));
}

/** New config entries for an Item's accounts. Existing ones only get their Plaid name refreshed. New ones
 * start with skip: true; the caller turns on the ones the user picks. */
export function discoverAccounts(cfg: Record<string, AccountCfg>, itemId: string, tok: Row, accounts: Row[],
  brokerage: Set<string> = new Set(), joint: Set<string> = new Set()): string[] {
  const added: string[] = [];
  for (const a of accounts) {
    const aid = a.account_id;
    const ptype = String(a.type), sub = String(a.subtype);
    let kind: string | undefined = KIND_BY_PLAID_TYPE[ptype];
    if (brokerage.has(aid)) kind = "investment"; // e.g. Merrill CMA-Edge: Plaid says depository/cash management
    if (kind === "investment" && !(tok.products ?? ["investments"]).includes("investments")) kind = undefined;
    const isJoint = joint.has(aid) || JOINT_NAME.test(`${a.name} ${a.official_name ?? ""}`);
    if (aid in cfg) {
      cfg[aid].plaid_name = a.name;
      if (isJoint) cfg[aid].joint = true;
      continue;
    }
    const mask = a.mask || "";
    cfg[aid] = {
      owner: tok.owner, item_id: itemId, institution: tok.institution_name, institution_id: tok.institution_id,
      plaid_name: a.name, mask, plaid_type: ptype, plaid_subtype: sub, kind: kind ?? "unsupported",
      name: accountName(tok.owner, tok.institution_name, a.name, mask, new Set(Object.values(cfg).map((c) => String(c.name)))),
      currency: a.balances?.iso_currency_code || currencyFor(tok.country), wealthfolio_account_id: null, skip: true,
      ...(isJoint ? { joint: true } : {}),
    };
    if (kind) added.push(aid);
  }
  return added;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 || /\d/.test(w)));

/** The existing Wealthfolio account whose name is closest to ours: a shared mask, else enough shared words. */
export function suggestMatch(name: string, mask: string | undefined, candidates: { id: string; name: string; accountNumber?: string }[]): string | null {
  const mine = words(name);
  let best: string | null = null, top = 0;
  for (const c of candidates) {
    const theirs = words(c.name);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    let score = shared / (mine.size + theirs.size - shared || 1);
    if (mask && (c.name.includes(mask) || c.accountNumber?.endsWith(mask))) score += 0.5;
    if (score > top) { top = score; best = c.id; }
  }
  return top >= 0.4 ? best : null;
}

type WfAccount = { id: string; name: string; accountType: string; accountNumber?: string };

/** The Wealthfolio account each selected, unlinked account will use; null: a new one. Picks the user made come
 * first, then the closest names. One Wealthfolio account goes to one account only. Rows in name order, so the
 * screen and Create agree. */
export function planLinks(cfg: Record<string, AccountCfg>, existing: WfAccount[]): Record<string, string | null> {
  const taken = new Set(Object.values(cfg).map((c) => c.wealthfolio_account_id).filter((x): x is string => Boolean(x)));
  const todo = Object.entries(cfg).filter(([, c]) => !c.skip && !c.wealthfolio_account_id && WF_TYPE[c.kind])
    .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name)));
  const fits = (c: AccountCfg, a: WfAccount) => a.accountType === WF_TYPE[c.kind] && !taken.has(a.id);
  const out: Record<string, string | null> = {};
  for (const [id, c] of todo) {
    if (!c.match || c.match === "new") continue;
    const ok = existing.some((a) => a.id === c.match && fits(c, a));
    out[id] = ok ? c.match : null;
    if (ok) taken.add(c.match);
  }
  for (const [id, c] of todo) {
    if (id in out) continue;
    const pick = c.match === "new" ? null : suggestMatch(String(c.name), c.mask as string | undefined, existing.filter((a) => fits(c, a)));
    out[id] = pick;
    if (pick) taken.add(pick);
  }
  return out;
}
