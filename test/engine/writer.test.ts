import { expect, test } from "vitest";
import { SdkWriter } from "../../src/engine/writer";

function fakeApi() {
  const calls: { saveMany: unknown[]; assign: unknown[]; link: unknown[]; checked: number[] } = { saveMany: [], assign: [], link: [], checked: [] };
  const api = {
    activities: {
      checkImport: async (rows: Record<string, unknown>[]) => {
        if (rows.some((r) => !r.symbol)) throw new Error("invalid args `activities`: missing field `symbol`");
        calls.checked.push(rows.length);
        return rows.map((r) => ({ ...r, isValid: r.symbol !== "BAD",
        assetId: r.symbol ? `asset-${r.symbol}` : undefined, exchangeMic: r.symbol ? "XNAS" : undefined }));
      },
      saveMany: async (req: { creates?: { id: string }[]; updates?: { id: string }[] }) => {
        calls.saveMany.push(req);
        return { created: [], updated: [], deleted: [], errors: (req.updates ?? []).filter((u) => u.id === "wf-x").map((u) => ({ id: u.id, action: "update", message: "nope" })),
          createdMappings: (req.creates ?? []).map((c) => ({ tempId: c.id, activityId: `wf-${c.id}` })) };
      },
      linkTransfer: async (a: string, b: string) => { calls.link.push([a, b]); },
    },
    spending: {
      getCategories: async () => [{ kind: "expense", taxonomyId: "spending_categories", categoryId: "c1", key: "food", name: "Food", path: "Food" }],
      assignCategory: async (...a: unknown[]) => { calls.assign.push(a); },
      rerunRules: async () => 3,
    },
  };
  return { api: api as never, calls };
}

test("imports through checkImport and saveMany, mapping lines to new ids", async () => {
  const { api, calls } = fakeApi();
  const w = new SdkWriter(api, () => null);
  const out = await w.commitImport([
    { lineNumber: 1, accountId: "A", date: "2026-01-02", activityType: "BUY", currency: "USD", symbol: "VTI", quantity: 1, unitPrice: 10, comment: "x · plaid:t1" },
    { lineNumber: 2, accountId: "A", date: "2026-01-02", activityType: "BUY", currency: "USD", symbol: "BAD", quantity: 1 },
    { lineNumber: 3, accountId: "B", date: "2026-01-03", activityType: "DEPOSIT", currency: "USD", amount: 5 },
    { lineNumber: 4, accountId: "A", date: "2026-01-04", activityType: "SELL", currency: "USD", symbol: "VTI", quantity: 1, unitPrice: 11 },
  ]);
  expect(calls.checked).toEqual([2]); // VTI and BAD once each; the cash row is not checked
  expect(Object.fromEntries(out)).toEqual({ 1: ["imported", "wf-plaid-importer-1"], 2: ["failed", null, expect.any(String)], 3: ["imported", "wf-plaid-importer-3"], 4: ["imported", "wf-plaid-importer-4"] });
  const creates = (calls.saveMany[0] as { creates: Record<string, unknown>[] }).creates;
  expect(creates[0].asset).toEqual({ id: "asset-VTI", symbol: "VTI", exchangeMic: "XNAS" });
  expect([creates[1].asset, creates[1].activityDate, creates[1].amount]).toEqual([undefined, "2026-01-03", 5]);
  expect(creates[2].asset).toEqual({ id: "asset-VTI", symbol: "VTI", exchangeMic: "XNAS" }); // reuses line 1's lookup
});

test("updates send the whole activity and map errors to indexes", async () => {
  const { api, calls } = fakeApi();
  const w = new SdkWriter(api, (id) => ({ accountId: `acct-${id}`, activityType: "WITHDRAWAL", date: "2026-02-01", currency: "USD" }));
  const out = await w.update([{ activityId: "wf-1", amount: 26 }, { activityId: "wf-x", void: true }, { activityId: "wf-2", activityType: "TRANSFER_OUT" }]);
  expect(out).toEqual([{ errors: [{ index: 1, message: "nope" }] }]);
  const ups = (calls.saveMany[0] as { updates: Record<string, unknown>[] }).updates;
  expect(ups[0]).toEqual({ id: "wf-1", accountId: "acct-wf-1", activityType: "WITHDRAWAL", activityDate: "2026-02-01", currency: "USD", amount: 26 });
  expect(ups[1].status).toBe("VOID");
  expect(ups[2].activityType).toBe("TRANSFER_OUT");
  expect(ups.every((u) => u.currency === "USD")).toBe(true); // save_activities rejects an update without it
});

test("categories use the kind of the category", async () => {
  const { api, calls } = fakeApi();
  const w = new SdkWriter(api, () => null);
  expect(Object.fromEntries(await w.categoryIds())).toEqual({ "spending_categories|food": "c1" });
  await w.setCategories([{ activityId: "a1", taxonomyId: "spending_categories", categoryId: "c1" }]);
  expect(calls.assign).toEqual([["a1", "expense", "c1"]]);
  expect(await w.rerunRules()).toBe(3);
});

test("a duplicate flag on the checked row does not fail the security's rows", async () => {
  const { api: raw, calls } = fakeApi();
  const api = raw as { activities: { checkImport: (r: Record<string, unknown>[]) => Promise<Record<string, unknown>[]> } };
  const check = api.activities.checkImport;
  api.activities.checkImport = async (rows) => (await check(rows)).map((r) => ({ ...r, isValid: false, duplicateOfId: "old", errors: { date: ["duplicate"] } }));
  const out = await new SdkWriter(api as never, () => null).commitImport([
    { lineNumber: 1, accountId: "A", date: "2026-01-02", activityType: "BUY", currency: "USD", symbol: "VUSXX", quantity: 1, unitPrice: 1 },
    { lineNumber: 2, accountId: "A", date: "2026-01-03", activityType: "BUY", currency: "USD", symbol: "VUSXX", quantity: 2, unitPrice: 1 }]);
  expect([...out.values()].map((v) => v[0])).toEqual(["imported", "imported"]);
  expect(calls.saveMany.length).toBe(1);
});

test("a security error fails its rows, with the reason", async () => {
  const api = fakeApi().api as { activities: { checkImport: (r: Record<string, unknown>[]) => Promise<Record<string, unknown>[]> } };
  api.activities.checkImport = async (rows) => rows.map((r) => ({ ...r, isValid: false, errors: { symbol: ["not found"] } }));
  const out = await new SdkWriter(api as never, () => null).commitImport([
    { lineNumber: 1, accountId: "A", date: "2026-01-02", activityType: "BUY", currency: "USD", symbol: "TTTXX", quantity: 1 }]);
  expect(out.get(1)).toEqual(["failed", null, "symbol: not found"]);
});
