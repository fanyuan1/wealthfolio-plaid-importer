// A fake Plaid for the browser tests. Wealthfolio's server only calls public HTTPS hosts, so the fake does not sit
// behind a URL: the tests answer the addon's network calls (POST /api/v1/addons/<id>/network/request) with it.
// One test bank: checking, credit card and brokerage. Unknown endpoints fail loudly.
type Row = Record<string, any>;

export const KEYS = { clientId: "fake-client-id", secret: "fake-sandbox-secret" };
const INSTITUTION = { institution_id: "ins_fake", name: "Platypus Bank" };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export class FakePlaid {
  calls: string[] = [];
  /** Hosted Link: polls of /link/token/get before the login counts as done. */
  pollsUntilLinked = 1;
  private items = new Map<string, { token: string }>();
  private polls = new Map<string, number>();
  private n = 0;

  accounts: Row[] = [
    { account_id: "acc_chk", name: "Everyday Checking", mask: "0001", type: "depository", subtype: "checking",
      balances: { current: 1250, available: 1250, iso_currency_code: "USD" } },
    { account_id: "acc_card", name: "Rewards Card", mask: "0002", type: "credit", subtype: "credit card",
      balances: { current: 80, iso_currency_code: "USD" } },
    { account_id: "acc_brk", name: "Brokerage", mask: "0003", type: "investment", subtype: "brokerage",
      balances: { current: 1500, iso_currency_code: "USD" } },
  ];
  securities: Row[] = [
    { security_id: "sec_vti", ticker_symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", market_identifier_code: "ARCX",
      close_price: 110, iso_currency_code: "USD" },
    { security_id: "sec_cash", ticker_symbol: "CUR:USD", name: "U S Dollar", type: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
  ];
  holdings: Row[] = [
    { account_id: "acc_brk", security_id: "sec_vti", quantity: 12, cost_basis: 1240, institution_price: 110, institution_value: 1320, iso_currency_code: "USD" },
    { account_id: "acc_brk", security_id: "sec_cash", quantity: 180, institution_price: 1, institution_value: 180, iso_currency_code: "USD" },
  ];
  investments: Row[] = [
    { investment_transaction_id: "inv_buy", account_id: "acc_brk", security_id: "sec_vti", type: "buy", subtype: "buy",
      amount: 1000, quantity: 10, price: 100, fees: 0, date: day(-20), name: "BUY VTI", iso_currency_code: "USD" },
    { investment_transaction_id: "inv_div", account_id: "acc_brk", security_id: "sec_vti", type: "cash", subtype: "dividend",
      amount: -12.5, quantity: 0, price: 0, fees: 0, date: day(-10), name: "DIVIDEND VTI", iso_currency_code: "USD" },
  ];
  /** Bank and card transactions, in the order /transactions/sync hands them out. */
  transactions: Row[] = [
    bank("tx_pay", "acc_chk", -2500, day(-25), "Payroll", "INCOME", "INCOME_WAGES"),
    bank("tx_coffee", "acc_card", 4.75, day(-5), "Blue Bottle", "FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"),
    bank("tx_grocery", "acc_card", 62.1, day(-3), "Trader Joe's", "FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"),
  ];

  handle(endpoint: string, req: Row): { status: number; body: Row } {
    this.calls.push(endpoint);
    if (req.client_id !== KEYS.clientId || req.secret !== KEYS.secret) return err("INVALID_API_KEYS", "invalid client_id or secret");
    if ("access_token" in req && endpoint !== "/link/token/create" && ![...this.items.values()].some((i) => i.token === req.access_token)) {
      return err("INVALID_ACCESS_TOKEN", "unknown access token");
    }
    const ok = (body: Row) => ({ status: 200, body: { request_id: `req_${++this.n}`, ...body } });
    switch (endpoint) {
      case "/institutions/get": return ok({ institutions: [INSTITUTION], total: 1 });
      case "/institutions/get_by_id": return ok({ institution: INSTITUTION });
      case "/link/token/create": {
        const link = `link-sandbox-${++this.n}`;
        return ok({ link_token: link, hosted_link_url: `https://hosted.plaid.com/link/${link}`, expiration: day(1) });
      }
      case "/link/token/get": {
        const polls = (this.polls.get(req.link_token) ?? 0) + 1;
        this.polls.set(req.link_token, polls);
        if (polls <= this.pollsUntilLinked) return ok({ link_token: req.link_token, link_sessions: [] });
        return ok({ link_token: req.link_token, link_sessions: [{ link_session_id: "ls_1", results: { item_add_results: [
          { public_token: `public-sandbox-${req.link_token}`, institution: INSTITUTION, accounts: this.accounts,
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
        const itemId = [...this.items].find(([, i]) => i.token === req.access_token)![0];
        return ok({ item: { item_id: itemId, institution_id: INSTITUTION.institution_id, institution_name: INSTITUTION.name,
          products: ["transactions", "investments"], billed_products: ["transactions", "investments"], error: null } });
      }
      case "/accounts/get": return ok({ accounts: this.accounts });
      case "/identity/get": return ok({ accounts: this.accounts.map((a) => ({ ...a, owners: [{ names: ["Alex Platypus"] }] })) });
      case "/investments/holdings/get": return ok({ accounts: this.accounts, holdings: this.holdings, securities: this.securities });
      case "/investments/transactions/get": {
        const rows = this.investments.filter((t) => t.date >= req.start_date && t.date <= req.end_date);
        const offset = req.options?.offset ?? 0;
        return ok({ accounts: this.accounts, securities: this.securities, investment_transactions: rows.slice(offset, offset + 500),
          total_investment_transactions: rows.length });
      }
      case "/transactions/sync": {
        // The cursor is the count already handed out, so rows added later come on the next sync.
        const from = Number(req.cursor ?? 0);
        return ok({ added: this.transactions.slice(from), modified: [], removed: [], next_cursor: String(this.transactions.length), has_more: false });
      }
      default: return err("FAKE_UNKNOWN_ENDPOINT", `the fake Plaid has no ${endpoint}`);
    }
  }
}

function bank(id: string, account: string, amount: number, date: string, name: string, primary: string, detailed: string): Row {
  return { transaction_id: id, account_id: account, amount, date, authorized_date: date, pending: false, name, merchant_name: name,
    iso_currency_code: "USD", payment_channel: "in store", personal_finance_category: { primary, detailed, confidence_level: "HIGH" } };
}

function err(code: string, message: string) {
  return { status: 400, body: { error_type: "INVALID_REQUEST", error_code: code, error_message: message } };
}
