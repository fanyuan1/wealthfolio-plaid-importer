import {
  type AccountCfg, arrayOf, type Guard, isBoolean, isNumber, isString, type LedgerRow, nullable, optional, orNull, recordOf,
  type SecurityOverride, shape, type Track,
} from '../importer';
import type { ItemMeta, Remap } from './store';

export type BackupKind = "connections" | "full";
export type BackupItem = ItemMeta & { access_token: string };
interface LedgerData { rows?: LedgerRow[]; cursors?: Record<string, string>; invSync?: Record<string, string>; invFull?: string[] }
export interface Backup {
  format: string; kind: BackupKind; env: string;
  items?: Record<string, BackupItem>; accounts?: Record<string, AccountCfg>; symbols?: Record<string, SecurityOverride>;
  ledger?: LedgerData; remap?: Partial<Remap>;
}

const optString = optional(isString);
const optBool = optional(isBoolean);
const strings = arrayOf(isString);
const isKind = (v: unknown): v is BackupKind => v === "connections" || v === "full";
const isNumeric = (v: unknown): v is string | number => isString(v) || isNumber(v);

const isItem = shape<BackupItem>({
  owner: isString, institution_name: isString, institution_id: nullable(isString), products: optional(strings), env: optString,
  checked: optString, reconnect: optBool, created: optString, access_token: isString,
});

const isAccount = shape<AccountCfg>({
  item_id: isString, kind: isString, skip: optBool, currency: optString, plaid_subtype: optString, plaid_type: optString, name: optString,
  wealthfolio_account_id: nullable(isString), match: optString, owner: optString, institution: optString,
  institution_id: nullable(isString), plaid_name: optString, mask: optString, joint: optBool, not_joint: optBool,
});

const isTrack = shape<Track>({ symbol: isString, date: isString, price: isNumber, close: isNumber, ratio: isNumber });

const isOverride = shape<SecurityOverride>({
  name: optString, symbol: nullable(isString), manual: optBool, cash: optBool, investment: optBool, exclude: optBool,
  instrument_type: optString, multiplier: optional(isNumeric), track: optional(isTrack),
});

const optText = orNull(isString);
const isLedgerRow = shape<LedgerRow>({
  plaid_id: isString, account_id: isString, wf_activity_id: optText, activity_type: isString, date: isString, symbol: optText,
  quantity: optText, unit_price: optText, amount: optText, fee: optText, currency: isString, transfer_hint: isNumber,
  pair_plaid_id: optText, category_set: isNumber, voided: isNumber, category: nullable(isString), adopted: optional(isNumber),
  fund: optString, ratio: optional(isNumber),
});

const isLedger = shape<LedgerData>({
  rows: optional(arrayOf(isLedgerRow)), cursors: optional(recordOf(isString)), invSync: optional(recordOf(isString)),
  invFull: optional(strings),
});

const isRemap = shape<Partial<Remap>>({ full: optional(strings), dropped: optional(recordOf(strings)) });

export const isBackup: Guard<Backup> = shape<Backup>({
  format: isString, kind: isKind, env: isString, items: optional(recordOf(isItem)), accounts: optional(recordOf(isAccount)),
  symbols: optional(recordOf(isOverride)), ledger: optional(isLedger), remap: optional(isRemap),
});
