import { arrayOf, type Guard, isBoolean, isNumber, isRecord, isString, nullable, shape } from "./json";
import {
  type HoldingsData, type InvestmentData, isAccount, isHolding, isIdentityAccount, isInstitution, isInvestmentTransaction, isItem,
  isLinkSession, isRemoved, isSecurity, isTransaction, type LinkSession, type PlaidAccount, type PlaidIdentityAccount,
  type PlaidInstitution, type PlaidInvestmentTransaction, type PlaidItem, type PlaidRemoved, type PlaidSecurity, type PlaidTransaction,
  type TransactionsData,
} from "./plaidTypes";

export class PlaidError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export type Transport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
export type PlaidRequest = Record<string, unknown>;

const PLAID_HOSTS = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" } as const;
export type PlaidEnv = keyof typeof PLAID_HOSTS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

function parseBody(r: { status: number; body: string }): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(r.body);
  } catch {
    throw new PlaidError(`HTTP_${r.status}`, r.body.slice(0, 300));
  }
  if (!isRecord(body)) throw new PlaidError(`HTTP_${r.status}`, r.body.slice(0, 300));
  return body;
}

function expect<T>(endpoint: string, body: unknown, guard: Guard<T>): T {
  if (!guard(body)) throw new PlaidError("INVALID_RESPONSE", `${endpoint} sent a response in an unexpected shape`);
  return body;
}

const isLinkToken = shape<{ link_token: string; hosted_link_url?: string | null }>({ link_token: isString, hosted_link_url: nullable(isString) });
const isExchange = shape<{ access_token: string; item_id: string }>({ access_token: isString, item_id: isString });
const isPublicToken = shape<{ public_token: string }>({ public_token: isString });
const isAccounts = shape<{ accounts: PlaidAccount[] }>({ accounts: arrayOf(isAccount) });
const isIdentity = shape<{ accounts: PlaidIdentityAccount[] }>({ accounts: arrayOf(isIdentityAccount) });
const isItemResponse = shape<{ item: PlaidItem }>({ item: isItem });
const isInstitutionResponse = shape<{ institution: PlaidInstitution }>({ institution: isInstitution });
const isLinkTokenGet = shape<{ link_sessions?: LinkSession[] | null }>({ link_sessions: nullable(arrayOf(isLinkSession)) });
const isHoldings = shape<HoldingsData>({ accounts: arrayOf(isAccount), holdings: arrayOf(isHolding), securities: arrayOf(isSecurity) });
const isInvestmentPage = shape<{ investment_transactions: PlaidInvestmentTransaction[]; securities: PlaidSecurity[]; accounts: PlaidAccount[];
  total_investment_transactions: number }>({ investment_transactions: arrayOf(isInvestmentTransaction), securities: arrayOf(isSecurity),
  accounts: arrayOf(isAccount), total_investment_transactions: isNumber });
const isSyncPage = shape<{ added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: PlaidRemoved[]; next_cursor: string; has_more: boolean }>({
  added: arrayOf(isTransaction), modified: arrayOf(isTransaction), removed: arrayOf(isRemoved), next_cursor: isString, has_more: isBoolean });

export interface PlaidKeys {
  clientId: string;
  secret: string;
}

export interface LinkRequest {
  products?: string[];
  optional?: string[];
  country?: string;
  accessToken?: string | undefined;
}

export class Plaid {
  constructor(private keys: PlaidKeys, public env: PlaidEnv,
    private transport: Transport, private wait: (ms: number) => Promise<unknown> = sleep) {}

  async call(endpoint: string, req: PlaidRequest = {}): Promise<Record<string, unknown>> {
    const r = await this.transport(`${PLAID_HOSTS[this.env]}${endpoint}`,
      JSON.stringify({ client_id: this.keys.clientId, secret: this.keys.secret, ...req }),
      { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" });
    const body = parseBody(r);
    if (r.status >= 400) throw new PlaidError(text(body.error_code, "UNKNOWN"), text(body.error_message, ""));
    return body;
  }

  private async get<T>(endpoint: string, req: PlaidRequest, guard: Guard<T>): Promise<T> {
    return expect(endpoint, await this.call(endpoint, req), guard);
  }

  async institution(institutionId: string, country = "US"): Promise<PlaidInstitution> {
    return (await this.get("/institutions/get_by_id", { institution_id: institutionId, country_codes: [country] }, isInstitutionResponse)).institution;
  }

  linkToken(clientUserId: string, link: LinkRequest, extra: PlaidRequest = {}): Promise<{ link_token: string; hosted_link_url?: string | null }> {
    const { products = [], optional = [], country = "US", accessToken } = link;
    const req: PlaidRequest = { client_name: "Plaid Importer", language: "en", country_codes: [country], user: { client_user_id: clientUserId }, ...extra };
    if (accessToken) {
      req.access_token = accessToken;
      req.update = { account_selection_enabled: true };
    } else {
      req.products = products;
      if (optional.length) req.optional_products = optional;
      req.transactions = { days_requested: 730 };
    }
    return this.get("/link/token/create", req, isLinkToken);
  }

  async linkTokenGet(linkToken: string): Promise<LinkSession[]> {
    return (await this.get("/link/token/get", { link_token: linkToken }, isLinkTokenGet)).link_sessions ?? [];
  }

  exchange(publicToken: string): Promise<{ access_token: string; item_id: string }> {
    return this.get("/item/public_token/exchange", { public_token: publicToken }, isExchange);
  }

  async sandboxPublicToken(institutionId: string, products: string[]): Promise<string> {
    return (await this.get("/sandbox/public_token/create", { institution_id: institutionId, initial_products: products }, isPublicToken)).public_token;
  }

  async item(accessToken: string): Promise<PlaidItem> {
    return (await this.get("/item/get", { access_token: accessToken }, isItemResponse)).item;
  }

  async accounts(accessToken: string): Promise<PlaidAccount[]> {
    return (await this.get("/accounts/get", { access_token: accessToken }, isAccounts)).accounts;
  }

  async identity(accessToken: string): Promise<PlaidIdentityAccount[]> {
    return (await this.get("/identity/get", { access_token: accessToken }, isIdentity)).accounts;
  }

  holdings(accessToken: string): Promise<HoldingsData> {
    return this.get("/investments/holdings/get", { access_token: accessToken }, isHoldings);
  }

  private async investmentPage(accessToken: string, page: { start: string; end: string; offset: number }, retries: number) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.get("/investments/transactions/get", { access_token: accessToken, start_date: page.start, end_date: page.end,
          options: { count: 500, offset: page.offset } }, isInvestmentPage);
      } catch (e) {
        if (!(e instanceof PlaidError) || e.code !== "PRODUCT_NOT_READY" || attempt >= retries - 1) throw e;
        await this.wait(20_000);
      }
    }
  }

  async investmentTransactions(accessToken: string, start: string, end: string, retries = 6): Promise<InvestmentData> {
    const txns: PlaidInvestmentTransaction[] = [];
    const secs: Record<string, PlaidSecurity> = {};
    for (;;) {
      const r = await this.investmentPage(accessToken, { start, end, offset: txns.length }, retries);
      txns.push(...r.investment_transactions);
      for (const s of r.securities) secs[s.security_id] = s;
      if (txns.length >= r.total_investment_transactions || !r.investment_transactions.length) {
        return { investment_transactions: txns, securities: secs, accounts: r.accounts };
      }
    }
  }

  async transactionsSync(accessToken: string, cursor: string | null): Promise<TransactionsData> {
    for (;;) {
      const added: PlaidTransaction[] = [], modified: PlaidTransaction[] = [], removed: PlaidRemoved[] = [];
      let cur = cursor;
      try {
        for (;;) {
          const r = await this.get("/transactions/sync", { access_token: accessToken, count: 500, ...(cur ? { cursor: cur } : {}) }, isSyncPage);
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
