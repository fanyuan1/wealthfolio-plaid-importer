import { isString, itemAt } from "../../src/importer";
import { expect, test } from "vitest";
import { SdkWriter } from "../../src/engine/writer";

function fakeApi() {
  const calls: { saveMany: unknown[]; assign: unknown[]; link: unknown[]; checked: number[] } = { saveMany: [], assign: [], link: [], checked: [] };
  const api = {
    activities: {
      checkImport: (rows: Record<string, unknown>[]) => {
        if (rows.some((r) => !r.symbol)) return Promise.reject(new Error("invalid args `activities`: missing field `symbol`"));
        calls.checked.push(rows.length);
        return Promise.resolve(rows.map((r) => ({ ...r, isValid: r.symbol !== "BAD",
        assetId: isString(r.symbol) && r.symbol ? `asset-${r.symbol}` : undefined, exchangeMic: r.symbol ? "XNAS" : undefined })));
      },
      saveMany: (req: { creates?: { id: string }[]; updates?: { id: string }[] }) => {
        calls.saveMany.push(req);
        return Promise.resolve({ created: [], updated: [], deleted: [], errors: (req.updates ?? []).filter((u) => u.id === "wf-x").map((u) => ({ id: u.id, action: "update", message: "nope" })),
          createdMappings: (req.creates ?? []).map((c) => ({ tempId: c.id, activityId: `wf-${c.id}` })) });
      },
      getAll: (accountId: string) => Promise.resolve(accountId === "acct-wf-1" ? [{ id: "wf-1", comment: "Rent · plaid:p1" }] : []),
      linkTransfer: (a: string, b: string) => { calls.link.push([a, b]); return Promise.resolve(); },
    },
    spending: {
      getCategories: () => Promise.resolve([{ kind: "expense", taxonomyId: "spending_categories", categoryId: "c1", key: "food", name: "Food", path: "Food" }]),
      assignCategory: (...a: unknown[]) => { calls.assign.push(a); return Promise.resolve(); },
      rerunRules: () => Promise.resolve(3),
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
  expect(calls.checked).toEqual([2]);
  expect(Object.fromEntries(out)).toEqual({ 1: ["imported", "wf-plaid-importer-1"], 2: ["failed", null, expect.any(String)], 3: ["imported", "wf-plaid-importer-3"], 4: ["imported", "wf-plaid-importer-4"] });
  const creates = (itemAt(calls.saveMany, 0) as { creates: Record<string, unknown>[] }).creates;
  expect(itemAt(creates, 0).asset).toEqual({ id: "asset-VTI", symbol: "VTI", exchangeMic: "XNAS" });
  expect([itemAt(creates, 1).asset, itemAt(creates, 1).activityDate, itemAt(creates, 1).amount]).toEqual([undefined, "2026-01-03", 5]);
  expect(itemAt(creates, 2).asset).toEqual({ id: "asset-VTI", symbol: "VTI", exchangeMic: "XNAS" });
});

test("an external row is created with the flow mark", async () => {
  const { api, calls } = fakeApi();
  const row = { accountId: "A", date: "2026-01-02", activityType: "TRANSFER_IN", currency: "USD", symbol: "VTI", quantity: 1, unitPrice: 10 };
  await new SdkWriter(api, () => null).commitImport([{ ...row, lineNumber: 1, isExternal: true }, { ...row, lineNumber: 2 }]);
  const creates = (itemAt(calls.saveMany, 0) as { creates: Record<string, unknown>[] }).creates;
  expect(creates.map((c) => c.metadata)).toEqual([{ flow: { is_external: true } }, undefined]);
});

test("updates send the whole activity and map errors to indexes", async () => {
  const { api, calls } = fakeApi();
  const w = new SdkWriter(api, (id) => ({ accountId: `acct-${id}`, activityType: "WITHDRAWAL", date: "2026-02-01", currency: "USD" }));
  const out = await w.update([{ activityId: "wf-1", amount: 26 }, { activityId: "wf-x", void: true }, { activityId: "wf-2", activityType: "TRANSFER_OUT" }]);
  expect(out).toEqual([{ errors: [{ index: 1, message: "nope" }] }]);
  const ups = (itemAt(calls.saveMany, 0) as { updates: Record<string, unknown>[] }).updates;
  expect(itemAt(ups, 0)).toEqual({ id: "wf-1", accountId: "acct-wf-1", activityType: "WITHDRAWAL", activityDate: "2026-02-01", currency: "USD", amount: 26, comment: "Rent · plaid:p1" });
  expect(itemAt(ups, 1).status).toBe("VOID");
  expect(itemAt(ups, 2).activityType).toBe("TRANSFER_OUT");
  expect(ups.every((u) => u.currency === "USD")).toBe(true);
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
  expect([...out.values()].map((v) => itemAt(v, 0))).toEqual(["imported", "imported"]);
  expect(calls.saveMany.length).toBe(1);
});

test("a security error fails its rows, with the reason", async () => {
  const api = fakeApi().api as { activities: { checkImport: (r: Record<string, unknown>[]) => Promise<Record<string, unknown>[]> } };
  api.activities.checkImport = (rows) => Promise.resolve(rows.map((r) => ({ ...r, isValid: false, errors: { symbol: ["not found"] } })));
  const out = await new SdkWriter(api as never, () => null).commitImport([
    { lineNumber: 1, accountId: "A", date: "2026-01-02", activityType: "BUY", currency: "USD", symbol: "TTTXX", quantity: 1 }]);
  expect(out.get(1)).toEqual(["failed", null, "symbol: not found"]);
});
