import type { ActivityCreate, ActivityImport, ActivityType, ActivityUpdate, AssetResolutionInput, HostAPI, QuoteMode } from "@wealthfolio/addon-sdk";
import { chunks, errText, IMPORT_CHUNK, itemAt, type ImportRow, SMALL_CHUNK, type Update, WealthfolioError, type Writer } from "../importer";

export interface Base { accountId: string; activityType: string; date: string; currency: string }

type Api = Pick<HostAPI, "activities" | "spending">;

type ImportResult = [string, string | null, string?];

const ACTIVITY_TYPES = {
  BUY: true, SELL: true, SPLIT: true, DIVIDEND: true, INTEREST: true, DEPOSIT: true, WITHDRAWAL: true,
  TRANSFER_IN: true, TRANSFER_OUT: true, FEE: true, TAX: true, CREDIT: true, ADJUSTMENT: true, UNKNOWN: true,
} satisfies Record<ActivityType, true>;
const QUOTE_MODES = { MARKET: true, MANUAL: true } satisfies Record<QuoteMode, true>;

const isActivityType = (s: string): s is ActivityType => Object.hasOwn(ACTIVITY_TYPES, s);
const isQuoteMode = (s: string): s is QuoteMode => Object.hasOwn(QUOTE_MODES, s);

const securityKey = (r: ImportRow) => [r.symbol, r.instrumentType, r.quoteMode, r.currency].join("|");
const SECURITY_FIELD = /symbol|asset|ticker|instrument|quote/i;

function securityRejection(c: ActivityImport | undefined): string | null {
  if (!c || c.isValid || c.duplicateOfId) return null;
  const errs = c.errors ?? {};
  if (Object.keys(errs).length && !Object.keys(errs).some((f) => SECURITY_FIELD.test(f))) return null;
  return Object.entries(errs).map(([f, m]) => `${f}: ${m.join(", ")}`).join("; ") || "Wealthfolio rejected the row";
}

type TextAssetField = Exclude<keyof AssetResolutionInput, "quoteMode">;

function assetFor(r: ImportRow, c: ActivityImport | undefined): AssetResolutionInput {
  const asset: AssetResolutionInput = {};
  const text: [TextAssetField, string | undefined][] = [
    ["id", c?.assetId], ["symbol", c?.symbol ?? r.symbol], ["name", c?.symbolName ?? r.symbolName],
    ["instrumentType", c?.instrumentType ?? r.instrumentType], ["exchangeMic", c?.exchangeMic], ["quoteCcy", c?.quoteCcy],
    ["providerId", c?.providerId], ["providerSymbol", c?.providerSymbol],
  ];
  for (const [k, v] of text) if (v != null) asset[k] = v;
  const quoteMode = c?.quoteMode ?? r.quoteMode;
  if (quoteMode != null && isQuoteMode(quoteMode)) asset.quoteMode = quoteMode;
  return asset;
}

function createFor(r: ImportRow, c: ActivityImport | undefined): { failed: string } | { create: ActivityCreate } {
  const failed = securityRejection(c);
  if (failed !== null) return { failed };
  return { create: {
    id: `plaid-importer-${r.lineNumber}`, accountId: r.accountId, activityType: r.activityType,
    subtype: r.subtype ?? null, activityDate: r.date, ...(r.symbol && { asset: assetFor(r, c) }),
    quantity: r.quantity ?? null, unitPrice: r.unitPrice ?? null, amount: r.amount ?? null, currency: r.currency || "USD",
    fee: r.fee ?? null, tax: r.tax ?? null, comment: r.comment ?? null,
  } };
}

function toCheck(r: ImportRow): ActivityImport | null {
  const { activityType } = r;
  if (!isActivityType(activityType)) return null;
  return { ...r, activityType, isValid: true, isDraft: false, forceImport: true };
}

function updateRequest(u: Update, b: Base): ActivityUpdate {
  const req: ActivityUpdate = { id: String(u.activityId), accountId: b.accountId, activityType: u.activityType ?? b.activityType,
    activityDate: u.date ?? b.date, currency: u.currency ?? b.currency };
  for (const f of ["quantity", "unitPrice", "amount", "fee"] as const) {
    const v = u[f];
    if (v != null) req[f] = v;
  }
  if (u.symbol !== undefined) req.asset = u.symbol === null ? {} : { symbol: u.symbol };
  if (u.void) req.status = "VOID";
  return req;
}

export class SdkWriter implements Writer {
  private kinds = new Map<string, "expense" | "income" | "saving">();

  constructor(private api: Api, private base: (activityId: string) => Base | null) {}

  async commitImport(rows: ImportRow[]): Promise<Map<number, ImportResult>> {
    const out = new Map<number, ImportResult>();
    for (const chunk of chunks(rows, IMPORT_CHUNK)) {
      const checked = await this.checkSecurities(chunk);
      const creates: ActivityCreate[] = [], lines: number[] = [];
      for (const r of chunk) {
        const line = r.lineNumber;
        const made = createFor(r, r.symbol ? checked.get(securityKey(r)) : undefined);
        if ("failed" in made) {
          out.set(line, ["failed", null, made.failed]);
          continue;
        }
        lines.push(line);
        creates.push(made.create);
      }
      if (creates.length) await this.saveCreates(creates, lines, out);
    }
    return out;
  }

  private async checkSecurities(chunk: ImportRow[]): Promise<Map<string, ActivityImport>> {
    const firsts = new Map<string, ImportRow>();
    for (const r of chunk) if (r.symbol && !firsts.has(securityKey(r))) firsts.set(securityKey(r), r);
    const toSend = [...firsts.values()].map(toCheck).filter((r) => r !== null);
    const checked = toSend.length ? await this.api.activities.checkImport(toSend) : [];
    const byKey = new Map<string, ActivityImport>();
    for (const c of checked) {
      const r = [...firsts.values()].find((x) => x.lineNumber === c.lineNumber);
      if (r) byKey.set(securityKey(r), c);
    }
    return byKey;
  }

  private async saveCreates(creates: ActivityCreate[], lines: number[], out: Map<number, ImportResult>): Promise<void> {
    const res = await this.api.activities.saveMany({ creates });
    const ids = new Map(res.createdMappings.map((m) => [m.tempId, m.activityId]));
    const rejected = new Map(res.errors.map((e) => [String(e.id), e.message]));
    lines.forEach((line) => {
      const id = ids.get(`plaid-importer-${line}`);
      out.set(line, id ? ["imported", id] : ["failed", null, rejected.get(`plaid-importer-${line}`) ?? "Wealthfolio did not save the row"]);
    });
    if (!res.createdMappings.length && res.errors.length) throw new WealthfolioError(`import rejected: ${itemAt(res.errors, 0).message}`);
  }

  async update(updates: Update[]): Promise<{ errors?: { index: number; message: string }[] }[]> {
    const out = [];
    for (const chunk of chunks(updates, SMALL_CHUNK)) {
      const errors: { index: number; message: string }[] = [];
      const reqs: ActivityUpdate[] = [], idx: number[] = [];
      chunk.forEach((u, i) => {
        const b = this.base(String(u.activityId));
        if (!b) return errors.push({ index: i, message: "activity not in the ledger" });
        reqs.push(updateRequest(u, b));
        idx.push(i);
      });
      if (reqs.length) {
        const res = await this.api.activities.saveMany({ updates: reqs });
        for (const e of res.errors) {
          const i = reqs.findIndex((r) => r.id === e.id);
          errors.push({ index: i >= 0 ? itemAt(idx, i) : 0, message: e.message });
        }
      }
      out.push({ errors });
    }
    return out;
  }

  async delete(ids: string[]): Promise<void> {
    for (const chunk of chunks(ids, SMALL_CHUNK)) await this.api.activities.saveMany({ deleteIds: chunk });
  }

  async linkTransfers(pairs: [string, string][]): Promise<void> {
    for (const [a, b] of pairs) await this.api.activities.linkTransfer(a, b);
  }

  async categoryIds(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const c of await this.api.spending.getCategories()) {
      out.set(`${c.taxonomyId}|${c.key}`, c.categoryId);
      this.kinds.set(c.categoryId, c.kind);
    }
    return out;
  }

  async setCategories(assignments: { activityId: string; taxonomyId: string; categoryId: string }[]): Promise<void> {
    for (const a of assignments) {
      await this.api.spending.assignCategory(a.activityId, this.kinds.get(a.categoryId) ?? "expense", a.categoryId);
    }
  }

  async rerunRules(): Promise<number> {
    try {
      return await this.api.spending.rerunRules(true);
    } catch (e) {
      throw new WealthfolioError(errText(e));
    }
  }
}
