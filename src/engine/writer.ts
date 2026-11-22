import type { HostAPI } from "@wealthfolio/addon-sdk";
import { chunks, errText, IMPORT_CHUNK, itemAt, type ImportRow, SMALL_CHUNK, type Update, WealthfolioError, type Writer } from "../importer";

export interface Base { accountId: string; activityType: string; date: string; currency: string }

const IDENTITY = ["assetId", "symbol", "symbolName", "instrumentType", "exchangeMic", "quoteCcy", "quoteMode", "providerId", "providerSymbol"] as const;

type Api = Pick<HostAPI, "activities" | "spending">;

type ImportResult = [string, string | null, string?];

const securityKey = (r: ImportRow) => [r.symbol, r.instrumentType, r.quoteMode, r.currency].join("|");
const SECURITY_FIELD = /symbol|asset|ticker|instrument|quote/i;

function securityRejection(c: Record<string, unknown> | undefined): string | null {
  if (!c || c.isValid !== false || c.duplicateOfId) return null;
  const errs = (c.errors ?? {}) as Record<string, string[]>;
  if (Object.keys(errs).length && !Object.keys(errs).some((f) => SECURITY_FIELD.test(f))) return null;
  return Object.entries(errs).map(([f, m]) => `${f}: ${m.join(", ")}`).join("; ") || "Wealthfolio rejected the row";
}

const ASSET_KEY: Partial<Record<string, string>> = { assetId: "id", symbolName: "name" };

function createFor(r: ImportRow, c: Record<string, unknown> | undefined): { failed: string } | { create: Record<string, unknown> } {
  const failed = securityRejection(c);
  if (failed !== null) return { failed };
  const line = Number(r.lineNumber);
  const asset = r.symbol ? Object.fromEntries(IDENTITY.filter((f) => c?.[f] != null || r[f] != null)
    .map((f) => [ASSET_KEY[f] ?? f, c?.[f] ?? r[f]])) : undefined;
  return { create: {
    id: `plaid-importer-${line}`, accountId: String(r.accountId), activityType: String(r.activityType),
    subtype: r.subtype ?? null, activityDate: String(r.date), asset,
    quantity: r.quantity ?? null, unitPrice: r.unitPrice ?? null, amount: r.amount ?? null, currency: String(r.currency || "USD"),
    fee: r.fee ?? null, tax: r.tax ?? null, comment: r.comment ?? null,
  } };
}

export class SdkWriter implements Writer {
  private kinds = new Map<string, "expense" | "income" | "saving">();

  constructor(private api: Api, private base: (activityId: string) => Base | null) {}

  async commitImport(rows: ImportRow[]): Promise<Map<number, ImportResult>> {
    const out = new Map<number, ImportResult>();
    for (const chunk of chunks(rows, IMPORT_CHUNK)) {
      const checked = await this.checkSecurities(chunk);
      const creates: Record<string, unknown>[] = [], lines: number[] = [];
      for (const r of chunk) {
        const line = Number(r.lineNumber);
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

  private async checkSecurities(chunk: ImportRow[]): Promise<Map<string, Record<string, unknown>>> {
    const firsts = new Map<string, ImportRow>();
    for (const r of chunk) if (r.symbol && !firsts.has(securityKey(r))) firsts.set(securityKey(r), r);
    const checked = firsts.size
      ? await this.api.activities.checkImport([...firsts.values()].map((r) => ({ ...r, isValid: true, isDraft: false, forceImport: true })) as never)
      : [];
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of checked as unknown as Record<string, unknown>[]) {
      const r = [...firsts.values()].find((x) => x.lineNumber === c.lineNumber);
      if (r) byKey.set(securityKey(r), c);
    }
    return byKey;
  }

  private async saveCreates(creates: Record<string, unknown>[], lines: number[], out: Map<number, ImportResult>): Promise<void> {
    const res = await this.api.activities.saveMany({ creates: creates as never });
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
      const reqs: Record<string, unknown>[] = [], idx: number[] = [];
      chunk.forEach((u, i) => {
        const id = String(u.activityId);
        const b = this.base(id);
        if (!b) return errors.push({ index: i, message: "activity not in the ledger" });
        const req: Record<string, unknown> = { id, accountId: b.accountId, activityType: u.activityType ?? b.activityType,
          activityDate: u.date ?? b.date, currency: b.currency };
        for (const f of ["quantity", "unitPrice", "amount", "fee", "currency"]) if (f in u && u[f] != null) req[f] = u[f];
        if ("symbol" in u) req.asset = { symbol: u.symbol };
        if (u.void) req.status = "VOID";
        reqs.push(req);
        idx.push(i);
      });
      if (reqs.length) {
        const res = await this.api.activities.saveMany({ updates: reqs as never });
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
