import { isNumber, isRecord, isString } from "../../src/importer/json";
import type { PlaidAccount, PlaidHolding, PlaidInvestmentTransaction, PlaidSecurity, PlaidTransaction } from "../../src/importer/plaidTypes";

type Body = Record<string, unknown>;
const text = (v: unknown) => (isString(v) ? v : "");

export const KEYS = { clientId: "fake-client-id", secret: "fake-sandbox-secret" };
const INSTITUTION = { institution_id: "ins_fake", name: "Platypus Bank" };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export class FakePlaid {
  calls: string[] = [];
  pollsUntilLinked = 1;
  private items = new Map<string, { token: string }>();
  private polls = new Map<string, number>();
  private n = 0;

  accounts: PlaidAccount[] = [
    { account_id: "acc_chk", name: "Everyday Checking", mask: "0001", type: "depository", subtype: "checking",
      balances: { current: 1250, available: 1250, iso_currency_code: "USD" } },
    { account_id: "acc_card", name: "Rewards Card", mask: "0002", type: "credit", subtype: "credit card",
      balances: { current: 80, iso_currency_code: "USD" } },
    { account_id: "acc_brk", name: "Brokerage", mask: "0003", type: "investment", subtype: "brokerage",
      balances: { current: 1500, iso_currency_code: "USD" } },
  ];
  securities: PlaidSecurity[] = [
    { security_id: "sec_vti", ticker_symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", market_identifier_code: "ARCX",
      close_price: 110, iso_currency_code: "USD" },
    { security_id: "sec_cash", ticker_symbol: "CUR:USD", name: "U S Dollar", type: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
  ];
  holdings: PlaidHolding[] = [
    { account_id: "acc_brk", security_id: "sec_vti", quantity: 12, cost_basis: 1240, institution_price: 110, institution_value: 1320, iso_currency_code: "USD" },
    { account_id: "acc_brk", security_id: "sec_cash", quantity: 180, institution_price: 1, institution_value: 180, iso_currency_code: "USD" },
  ];
  investments: PlaidInvestmentTransaction[] = [
    { investment_transaction_id: "inv_buy", account_id: "acc_brk", security_id: "sec_vti", type: "buy", subtype: "buy",
      amount: 1000, quantity: 10, price: 100, fees: 0, date: day(-20), name: "BUY VTI", iso_currency_code: "USD" },
    { investment_transaction_id: "inv_div", account_id: "acc_brk", security_id: "sec_vti", type: "cash", subtype: "dividend",
      amount: -12.5, quantity: 0, price: 0, fees: 0, date: day(-10), name: "DIVIDEND VTI", iso_currency_code: "USD" },
  ];
  transactions: PlaidTransaction[] = [
    bank("tx_pay", "acc_chk", -2500, { date: day(-25), name: "Payroll", primary: "INCOME", detailed: "INCOME_WAGES" }),
    bank("tx_coffee", "acc_card", 4.75, { date: day(-5), name: "Blue Bottle", primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }),
    bank("tx_grocery", "acc_card", 62.1, { date: day(-3), name: "Trader Joe's", primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" }),
  ];

  handle(endpoint: string, body: unknown): { status: number; body: Body } {
    const req = isRecord(body) ? body : {};
    this.calls.push(endpoint);
    if (req.client_id !== KEYS.clientId || req.secret !== KEYS.secret) return err("INVALID_API_KEYS", "invalid client_id or secret");
    if ("access_token" in req && endpoint !== "/link/token/create" && ![...this.items.values()].some((i) => i.token === req.access_token)) {
      return err("INVALID_ACCESS_TOKEN", "unknown access token");
    }
    const ok = (body: Body) => ({ status: 200, body: { request_id: `req_${++this.n}`, ...body } });
    switch (endpoint) {
      case "/institutions/get": return ok({ institutions: [INSTITUTION], total: 1 });
      case "/institutions/get_by_id": return ok({ institution: INSTITUTION });
      case "/link/token/create": {
        const link = `link-sandbox-${++this.n}`;
        return ok({ link_token: link, hosted_link_url: `https://hosted.plaid.com/link/${link}`, expiration: day(1) });
      }
      case "/link/token/get": {
        const linkToken = text(req.link_token);
        const polls = (this.polls.get(linkToken) ?? 0) + 1;
        this.polls.set(linkToken, polls);
        if (polls <= this.pollsUntilLinked) return ok({ link_token: linkToken, link_sessions: [] });
        return ok({ link_token: linkToken, link_sessions: [{ link_session_id: "ls_1", results: { item_add_results: [
          { public_token: `public-sandbox-${linkToken}`, institution: INSTITUTION, accounts: this.accounts,
            products: ["transactions", "investments"] }] } }] });
      }
      case "/sandbox/public_token/create": return ok({ public_token: `public-sandbox-${++this.n}` });
      case "/item/public_token/exchange": {
        const itemId = `item_${this.items.size + 1}`;
        const token = `access-sandbox-${itemId}`;
        this.items.set(itemId, { token });
        return ok({ access_token: token, item_id: itemId });
      }
      case "/item/get": {
        const itemId = [...this.items].find(([, i]) => i.token === req.access_token)?.[0];
        if (!itemId) return err("INVALID_ACCESS_TOKEN", "unknown access token");
        return ok({ item: { item_id: itemId, institution_id: INSTITUTION.institution_id, institution_name: INSTITUTION.name,
          products: ["transactions", "investments"], billed_products: ["transactions", "investments"], error: null } });
      }
      case "/accounts/get": return ok({ accounts: this.accounts });
      case "/identity/get": return ok({ accounts: this.accounts.map((a) => ({ ...a, owners: [{ names: ["Alex Platypus"] }] })) });
      case "/investments/holdings/get": return ok({ accounts: this.accounts, holdings: this.holdings, securities: this.securities });
      case "/investments/transactions/get": {
        const rows = this.investments.filter((t) => t.date >= text(req.start_date) && t.date <= text(req.end_date));
        const offset = isRecord(req.options) && isNumber(req.options.offset) ? req.options.offset : 0;
        return ok({ accounts: this.accounts, securities: this.securities, investment_transactions: rows.slice(offset, offset + 500),
          total_investment_transactions: rows.length });
      }
      case "/transactions/sync": {
        const from = Number(text(req.cursor) || 0);
        return ok({ added: this.transactions.slice(from), modified: [], removed: [], next_cursor: String(this.transactions.length), has_more: false });
      }
      default: return err("FAKE_UNKNOWN_ENDPOINT", `the fake Plaid has no ${endpoint}`);
    }
  }
}

interface BankRow { date: string; name: string; primary: string; detailed: string }

function bank(id: string, account: string, amount: number, { date, name, primary, detailed }: BankRow): PlaidTransaction & { authorized_date: string; payment_channel: string } {
  return { transaction_id: id, account_id: account, amount, date, authorized_date: date, pending: false, name, merchant_name: name,
    iso_currency_code: "USD", payment_channel: "in store", personal_finance_category: { primary, detailed } };
}

function err(code: string, message: string) {
  return { status: 400, body: { error_type: "INVALID_REQUEST", error_code: code, error_message: message } };
}
