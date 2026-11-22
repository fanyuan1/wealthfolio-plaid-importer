import { D } from "./dec";
import { Activity } from "./models";
import type { PlaidTransaction } from "./plaidTypes";
import { daysBetween } from "./transfers";

const TRANSFER_PRIMARIES = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const BILT_HOUSING_CREDIT = "PAYMENT - BILT HOUSING";
const BILT_HOUSING_CHARGE = "BILT";
const BILT_MATCH_DAYS = 3;
const CARD_PAYMENT_NAMES = ["BILT CARD PMT"];

const day = (t: PlaidTransaction) => t.date;

export function biltPassthrough(txns: PlaidTransaction[]): Set<string> {
  const credits = txns.filter((t) => (t.name ?? "").toUpperCase().startsWith(BILT_HOUSING_CREDIT)
    && t.amount < 0);
  const charges = txns.filter((t) => (t.merchant_name || t.name || "").toUpperCase().includes(BILT_HOUSING_CHARGE)
    && t.amount > 0 && !t.pending);
  const drop = new Set<string>();
  const byDay = [...credits].sort((a, b) => (day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : 0));
  for (const c of byDay) {
    const near = [...charges].sort((x, y) => daysBetween(day(x), day(c)) - daysBetween(day(y), day(c)));
    const match = near.find((x) => !drop.has(x.transaction_id) && x.account_id === c.account_id
      && D(x.amount).eq(D(c.amount).neg()) && daysBetween(day(x), day(c)) <= BILT_MATCH_DAYS);
    if (match) drop.add(c.transaction_id).add(match.transaction_id);
  }
  return drop;
}

function statementCredit(t: PlaidTransaction): boolean {
  const n = (t.name ?? "").toUpperCase();
  return n.includes("CREDIT") && !["PAYMENT", "PMT"].some((w) => n.includes(w));
}

function pfc(t: PlaidTransaction): [string, string] {
  const p = t.personal_finance_category;
  return [(p?.primary ?? "").toUpperCase(), (p?.detailed ?? "").toUpperCase()];
}

export function mapBankTransaction(t: PlaidTransaction, accountKind: string, defaultCurrency = "USD"): Activity | null {
  if (t.pending) return null;
  const amount = D(t.amount);
  if (amount.eq(0)) return null;
  const [primary, detailed] = pfc(t);
  const name = (t.name ?? "").toUpperCase();
  let hint = TRANSFER_PRIMARIES.has(primary) || detailed === CARD_PAYMENT || CARD_PAYMENT_NAMES.some((n) => name.includes(n));
  const outflow = amount.gt(0);
  if (accountKind === "credit" && !outflow && statementCredit(t)) hint = false;
  const desc = t.merchant_name || t.name || "";
  let subtype: string | null = null;
  let atype: string;
  if (accountKind === "credit") {
    if (outflow) {
      atype = primary === "BANK_FEES" ? "FEE" : "WITHDRAWAL";
      if (detailed === "BANK_FEES_INTEREST_CHARGE") subtype = "INTEREST_CHARGE";
    } else if (hint) {
      atype = "TRANSFER_IN";
    } else {
      atype = "CREDIT";
      subtype = "REFUND";
    }
  } else if (outflow) {
    atype = primary === "BANK_FEES" ? "FEE" : "WITHDRAWAL";
  } else {
    atype = detailed === "INCOME_INTEREST_EARNED" ? "INTEREST" : "DEPOSIT";
  }
  return new Activity({
    accountId: t.account_id, plaidId: t.transaction_id, date: t.date, activityType: atype,
    currency: t.iso_currency_code || t.unofficial_currency_code || defaultCurrency,
    amount: amount.abs(), subtype, description: desc,
    category: hint ? null : detailed || primary || null, transferHint: hint,
  });
}

