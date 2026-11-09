// Plaid REST client over a pluggable transport: the addon SDK's network broker, or fetch() in tests.
// Plain JSON in and out, no Plaid SDK.
import type { Row } from "./models";

export class PlaidError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** POST a JSON body; return the status and the response body. */
export type Transport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export const fetchTransport: Transport = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", body, headers });
  return { status: r.status, body: await r.text() };
};

export const PLAID_HOSTS = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" } as const;
export type PlaidEnv = keyof typeof PLAID_HOSTS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Plaid {
  constructor(private clientId: string, private secret: string, public env: PlaidEnv = "sandbox",
    private transport: Transport = fetchTransport, private wait: (ms: number) => Promise<unknown> = sleep) {}

  async call(endpoint: string, req: Row = {}): Promise<Row> {
    const r = await this.transport(`${PLAID_HOSTS[this.env]}${endpoint}`,
      JSON.stringify({ client_id: this.clientId, secret: this.secret, ...req }),
      { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" });
    let body: Row;
    try {
      body = JSON.parse(r.body);
    } catch {
      throw new PlaidError(`HTTP_${r.status}`, r.body.slice(0, 300));
    }
    if (r.status >= 400) throw new PlaidError(body.error_code || "UNKNOWN", body.error_message || "");
    return body;
  }

  // institutions
  async institution(institutionId: string, country = "US"): Promise<Row> {
    return (await this.call("/institutions/get_by_id", { institution_id: institutionId, country_codes: [country] })).institution;
  }

  // link
  async linkToken(clientUserId: string, products: string[] = [], optional: string[] = [], country = "US",
    accessToken?: string, extra: Row = {}): Promise<Row> {
    const req: Row = { client_name: "Plaid Importer", language: "en", country_codes: [country], user: { client_user_id: clientUserId }, ...extra };
    if (accessToken) {
      // Update mode: re-auth and add accounts on the same Item, no new Item slot.
      req.access_token = accessToken;
      req.update = { account_selection_enabled: true };
    } else {
      req.products = products;
      if (optional.length) req.optional_products = optional;
      req.transactions = { days_requested: 730 }; // only honored at link time
    }
    return this.call("/link/token/create", req);
  }

  linkTokenGet(linkToken: string): Promise<Row> {
    return this.call("/link/token/get", { link_token: linkToken });
  }

  exchange(publicToken: string): Promise<Row> {
    return this.call("/item/public_token/exchange", { public_token: publicToken });
  }

  async sandboxPublicToken(institutionId: string, products: string[]): Promise<string> {
    return (await this.call("/sandbox/public_token/create", { institution_id: institutionId, initial_products: products })).public_token;
  }

  // items / accounts
  item(accessToken: string): Promise<Row> {
    return this.call("/item/get", { access_token: accessToken });
  }

  async accounts(accessToken: string): Promise<Row[]> {
    return (await this.call("/accounts/get", { access_token: accessToken })).accounts;
  }

  identity(accessToken: string): Promise<Row> {
    return this.call("/identity/get", { access_token: accessToken });
  }

  // investments
  holdings(accessToken: string): Promise<Row> {
    return this.call("/investments/holdings/get", { access_token: accessToken });
  }

  /** All pages. Retries PRODUCT_NOT_READY, which happens right after linking. */
  async investmentTransactions(accessToken: string, start: string, end: string, retries = 6): Promise<Row> {
    const txns: Row[] = [];
    const secs: Record<string, Row> = {};
    let accounts: Row[] = [];
    for (;;) {
      let r: Row | undefined;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          r = await this.call("/investments/transactions/get", { access_token: accessToken, start_date: start, end_date: end,
            options: { count: 500, offset: txns.length } });
          break;
        } catch (e) {
          if (!(e instanceof PlaidError) || e.code !== "PRODUCT_NOT_READY" || attempt === retries - 1) throw e;
          await this.wait(20_000);
        }
      }
      txns.push(...r!.investment_transactions);
      for (const s of r!.securities) secs[s.security_id] = s;
      accounts = r!.accounts;
      if (txns.length >= r!.total_investment_transactions || !r!.investment_transactions.length) {
        return { investment_transactions: txns, securities: secs, accounts };
      }
    }
  }

  /** Drain /transactions/sync from cursor. Restarts on mutation during pagination. */
  async transactionsSync(accessToken: string, cursor: string | null): Promise<Row> {
    for (;;) {
      const added: Row[] = [], modified: Row[] = [], removed: Row[] = [];
      let cur = cursor;
      try {
        for (;;) {
          const r = await this.call("/transactions/sync", { access_token: accessToken, count: 500, ...(cur ? { cursor: cur } : {}) });
          added.push(...r.added);
          modified.push(...r.modified);
          removed.push(...r.removed);
          cur = r.next_cursor;
          if (!r.has_more) return { added, modified, removed, next_cursor: cur };
        }
      } catch (e) {
        if (!(e instanceof PlaidError) || e.code !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") throw e;
      }
    }
  }
}
