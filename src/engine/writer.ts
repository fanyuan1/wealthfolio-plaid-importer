// Writer for the addon: pushes a plan through the Wealthfolio addon SDK.
import type { HostAPI } from "@wealthfolio/addon-sdk";
import { chunks, IMPORT_CHUNK, type ImportRow, SMALL_CHUNK, type Update, WealthfolioError, type Writer } from "../importer";

/** What an update needs besides the changed fields: the SDK replaces the whole activity. */
export interface Base { accountId: string; activityType: string; date: string; currency: string }

// Asset fields checkImport resolves; creates reuse them instead of resolving the symbol again.
const IDENTITY = ["assetId", "symbol", "symbolName", "instrumentType", "exchangeMic", "quoteCcy", "quoteMode", "providerId", "providerSymbol"] as const;

type Api = Pick<HostAPI, "activities" | "spending">;

export class SdkWriter implements Writer {
  private kinds = new Map<string, "expense" | "income" | "saving">(); // categoryId -> kind

  /** base: the Wealthfolio activity's account, type and date, from the ledger. */
  constructor(private api: Api, private base: (activityId: string) => Base | null) {}

  async commitImport(rows: ImportRow[]): Promise<Map<number, [string, string | null, string?]>> {
    const out = new Map<number, [string, string | null, string?]>();
    for (const chunk of chunks(rows, IMPORT_CHUNK)) {
      // Resolve each distinct security once. Only security rows go to checkImport: it requires a symbol, and
      // cash rows need no asset.
      const key = (r: ImportRow) => [r.symbol, r.instrumentType, r.quoteMode, r.currency].join("|");
      const firsts = new Map<string, ImportRow>();
      for (const r of chunk) if (r.symbol && !firsts.has(key(r))) firsts.set(key(r), r);
      const checked = firsts.size
        ? await this.api.activities.checkImport([...firsts.values()].map((r) => ({ ...r, isValid: true, isDraft: false, forceImport: true })) as never)
        : [];
      const byKey = new Map<string, Record<string, unknown>>();
      for (const c of checked as unknown as Record<string, unknown>[]) {
        const r = [...firsts.values()].find((x) => x.lineNumber === c.lineNumber);
        if (r) byKey.set(key(r), c);
      }
      const creates: Record<string, unknown>[] = [], lines: number[] = [];
      for (const r of chunk) {
        const line = Number(r.lineNumber);
        const c = r.symbol ? byKey.get(key(r)) : undefined;
        // The check ran on one row per security. Its verdict on that row's own date, amount or "duplicate of an
        // existing activity" says nothing about the other rows, and the user already chose to add this one.
        // Only a problem with the security itself fails every row of it.
        const errs = (c?.errors ?? {}) as Record<string, string[]>;
        const badSecurity = c && c.isValid === false && !c.duplicateOfId
          && (!Object.keys(errs).length || Object.keys(errs).some((f) => /symbol|asset|ticker|instrument|quote/i.test(f)));
        if (badSecurity) {
          const why = Object.entries(errs).map(([f, m]) => `${f}: ${m.join(", ")}`).join("; ");
          out.set(line, ["failed", null, why || "Wealthfolio rejected the row"]);
          continue;
        }
        const asset = r.symbol ? Object.fromEntries(IDENTITY.filter((f) => c?.[f] != null || r[f] != null)
          .map((f) => [f === "assetId" ? "id" : f === "symbolName" ? "name" : f, c?.[f] ?? r[f]])) : undefined;
        lines.push(line);
        creates.push({
          id: `plaid-importer-${line}`, accountId: String(r.accountId), activityType: String(r.activityType),
          subtype: (r.subtype as string) ?? null, activityDate: String(r.date), asset,
          quantity: r.quantity ?? null, unitPrice: r.unitPrice ?? null, amount: r.amount ?? null, currency: String(r.currency || "USD"),
          fee: r.fee ?? null, tax: r.tax ?? null, comment: (r.comment as string) ?? null,
        });
      }
      if (!creates.length) continue;
      const res = await this.api.activities.saveMany({ creates: creates as never });
      const ids = new Map(res.createdMappings.map((m) => [m.tempId, m.activityId]));
      const rejected = new Map(res.errors.map((e) => [String(e.id), e.message]));
      lines.forEach((line) => {
        const id = ids.get(`plaid-importer-${line}`);
        out.set(line, id ? ["imported", id] : ["failed", null, rejected.get(`plaid-importer-${line}`) ?? "Wealthfolio did not save the row"]);
      });
      if (!res.createdMappings.length && res.errors.length) throw new WealthfolioError(`import rejected: ${res.errors[0].message}`);
    }
    return out;
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
        // Wealthfolio's save_activities needs the currency on every update, changed or not.
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
          errors.push({ index: i >= 0 ? idx[i] : 0, message: e.message });
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
      throw new WealthfolioError(String((e as Error).message ?? e));
    }
  }
}
