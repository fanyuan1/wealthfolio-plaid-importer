import type { Dec } from "./dec";
import { arrayOf, type Guard, isBoolean, isNumber, isString, nullable, shape } from "./json";

export type Scaled = number | Dec;

export interface PlaidBalances { current?: number | null; available?: number | null; iso_currency_code?: string | null }

export interface PlaidAccount {
  account_id: string; name: string; type: string; balances: PlaidBalances;
  official_name?: string | null; mask?: string | null; subtype?: string | null;
}

export interface PlaidIdentityAccount extends PlaidAccount { owners: unknown[] }

interface PlaidOptionContract {
  contract_type?: string | null; expiration_date?: string | null; strike_price?: number | null; underlying_security_ticker?: string | null;
}

export interface PlaidSecurity {
  security_id: string; name?: string | null; ticker_symbol?: string | null; type?: string | null; is_cash_equivalent?: boolean | null;
  market_identifier_code?: string | null; iso_currency_code?: string | null; close_price?: Scaled | null;
  option_contract?: PlaidOptionContract | null;
}

export interface PlaidHolding {
  account_id: string; security_id: string; quantity: Scaled; institution_price: Scaled; institution_value: number;
  institution_price_as_of?: string | null; cost_basis?: number | null; iso_currency_code?: string | null;
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string; account_id: string; date: string; type: string; subtype: string;
  quantity: Scaled; amount: number; price: Scaled; security_id?: string | null; name?: string | null; fees?: number | null;
  iso_currency_code?: string | null; unofficial_currency_code?: string | null; cancel_transaction_id?: string | null;
}

interface PlaidCategory { primary: string; detailed: string }

export interface PlaidTransaction {
  transaction_id: string; account_id: string; amount: number; date: string; pending: boolean;
  name?: string | null; merchant_name?: string | null; iso_currency_code?: string | null; unofficial_currency_code?: string | null;
  personal_finance_category?: PlaidCategory | null;
}

export interface PlaidRemoved { transaction_id: string }

export interface PlaidItem { item_id: string; institution_id?: string | null; products?: string[] | null; error?: { error_code: string } | null }

export interface PlaidInstitution { institution_id?: string | null; name?: string | null }

interface LinkAdd { public_token?: string | null; products?: string[] | null; institution?: PlaidInstitution | null }

interface LinkExit { error?: { error_code?: string | null; error_message?: string | null; display_message?: string | null } | null }

export interface LinkSession {
  results?: { item_add_results?: LinkAdd[] | null } | null; on_success?: LinkAdd | null;
  exit?: LinkExit | null; on_exit?: LinkExit | null; finished_at?: string | null;
}

export interface HoldingsData { accounts: PlaidAccount[]; holdings: PlaidHolding[]; securities: PlaidSecurity[] }

export interface InvestmentData {
  investment_transactions: PlaidInvestmentTransaction[]; securities: Record<string, PlaidSecurity>; accounts: PlaidAccount[];
}

export interface TransactionsData { added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: PlaidRemoved[]; next_cursor: string }

const optString = nullable(isString);
const optNumber = nullable(isNumber);
const strings = arrayOf(isString);
const isUnknown = (v: unknown): v is unknown => v !== undefined;

const balances = shape<PlaidBalances>({ current: optNumber, available: optNumber, iso_currency_code: optString });
const accountFields = {
  account_id: isString, name: isString, type: isString, balances, official_name: optString, mask: optString, subtype: optString,
};
export const isAccount: Guard<PlaidAccount> = shape<PlaidAccount>(accountFields);
export const isIdentityAccount: Guard<PlaidIdentityAccount> = shape<PlaidIdentityAccount>({ ...accountFields, owners: arrayOf(isUnknown) });

const optionContract = shape<PlaidOptionContract>({
  contract_type: optString, expiration_date: optString, strike_price: optNumber, underlying_security_ticker: optString,
});
export const isSecurity: Guard<PlaidSecurity> = shape<PlaidSecurity>({
  security_id: isString, name: optString, ticker_symbol: optString, type: optString, is_cash_equivalent: nullable(isBoolean),
  market_identifier_code: optString, iso_currency_code: optString, close_price: optNumber, option_contract: nullable(optionContract),
});

export const isHolding: Guard<PlaidHolding> = shape<PlaidHolding>({
  account_id: isString, security_id: isString, quantity: isNumber, institution_price: isNumber, institution_value: isNumber,
  institution_price_as_of: optString, cost_basis: optNumber, iso_currency_code: optString,
});

export const isInvestmentTransaction: Guard<PlaidInvestmentTransaction> = shape<PlaidInvestmentTransaction>({
  investment_transaction_id: isString, account_id: isString, date: isString, type: isString, subtype: isString,
  quantity: isNumber, amount: isNumber, price: isNumber, security_id: optString, name: optString, fees: optNumber,
  iso_currency_code: optString, unofficial_currency_code: optString, cancel_transaction_id: optString,
});

export const isTransaction: Guard<PlaidTransaction> = shape<PlaidTransaction>({
  transaction_id: isString, account_id: isString, amount: isNumber, date: isString, pending: isBoolean,
  name: optString, merchant_name: optString, iso_currency_code: optString, unofficial_currency_code: optString,
  personal_finance_category: nullable(shape<PlaidCategory>({ primary: isString, detailed: isString })),
});

export const isRemoved: Guard<PlaidRemoved> = shape<PlaidRemoved>({ transaction_id: isString });

export const isItem: Guard<PlaidItem> = shape<PlaidItem>({
  item_id: isString, institution_id: optString, products: nullable(strings), error: nullable(shape<{ error_code: string }>({ error_code: isString })),
});

export const isInstitution: Guard<PlaidInstitution> = shape<PlaidInstitution>({ institution_id: optString, name: optString });

const linkAdd = shape<LinkAdd>({ public_token: optString, products: nullable(strings), institution: nullable(isInstitution) });
const linkExit = shape<LinkExit>({
  error: nullable(shape<NonNullable<LinkExit["error"]>>({ error_code: optString, error_message: optString, display_message: optString })),
});
export const isLinkSession: Guard<LinkSession> = shape<LinkSession>({
  results: nullable(shape<NonNullable<LinkSession["results"]>>({ item_add_results: nullable(arrayOf(linkAdd)) })), on_success: nullable(linkAdd),
  exit: nullable(linkExit), on_exit: nullable(linkExit), finished_at: optString,
});
