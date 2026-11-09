import { expect, test } from "vitest";
import { Activity, D, type Existing, findAdoptions, forgetEmptied, matchById, MemoryLedger } from "../../src/importer";

const act = (id: string, over: Record<string, unknown> = {}) =>
  new Activity({ accountId: "A", plaidId: id, date: "2026-01-02", activityType: "BUY", symbol: "VTI", quantity: D(2), amount: D(100), ...over } as never);
const ex = (id: string, over: Partial<Existing> = {}): Existing =>
  ({ id, accountId: "W", date: "2026-01-02", type: "BUY", symbol: "VTI", quantity: "2", amount: "100", comment: null, ...over });
const wf = (a: string) => (a === "A" ? "W" : undefined);

test("own comment is exact and discarded by default", () => {
  const r = findAdoptions([act("p1")], [ex("e1", { comment: "x · plaid:p1", quantity: "9" })], wf);
  expect([r[0].how, r[0].decision, r[0].existing?.id]).toEqual(["exact", "discard", "e1"]);
});

test("same day, ticker and quantity is exact; each existing row is used once; the rest are new and added", () => {
  const r = findAdoptions([act("p1"), act("p2")], [ex("e1")], wf);
  expect(r.map((x) => [x.plaidId, x.how, x.decision])).toEqual([["p1", "exact", "discard"], ["p2", "new", "add"]]);
});

test("different day or amount is new", () => {
  const r = findAdoptions([act("p1")], [ex("e1", { date: "2026-01-03" }), ex("e2", { quantity: "3" })], wf);
  expect(r.map((x) => x.how)).toEqual(["new"]);
});

test("deposit vs transfer-in is similar", () => {
  const a = act("p1", { activityType: "TRANSFER_IN", symbol: null, quantity: null, amount: D(50) });
  const r = findAdoptions([a], [ex("e1", { type: "DEPOSIT", symbol: "$CASH-USD", quantity: null, amount: "50" })], wf);
  expect(r[0].how).toBe("similar");
});

test("shares transferred in on a day match any activity of the same shares that day", () => {
  const a = act("p1", { activityType: "TRANSFER_IN", amount: null });
  expect(findAdoptions([a], [ex("e1", { type: "BUY" })], wf)[0]).toMatchObject({ how: "exact", decision: "discard" });
  expect(findAdoptions([act("p2")], [ex("e1", { type: "SELL" })], wf)[0].how).toBe("new"); // a buy is not a sell
});

test("ledger-known ids are never matched", () => {
  expect(findAdoptions([act("p1")], [ex("e1")], wf, new Set(["e1"]))[0].how).toBe("new");
});

test("opening that equals what the account already holds is exact; a different amount is similar", () => {
  const open = act("opening:A:VTI", { date: "2024-01-01", quantity: D(10), activityType: "TRANSFER_IN" });
  const old = [ex("e1", { date: "2023-06-01", quantity: "6" }), ex("e2", { date: "2023-07-01", quantity: "4" })];
  expect(findAdoptions([open], old, wf)[0]).toMatchObject({ how: "exact", decision: "discard", held: "10" });
  expect(findAdoptions([open], [old[0]], wf)[0]).toMatchObject({ how: "similar", held: "6" });
  expect(findAdoptions([open], [ex("e3", { date: "2024-03-01" })], wf)[0].how).toBe("new");
});

test("an account emptied in Wealthfolio is forgotten, with its Item's cursor; others are kept", () => {
  const led = new MemoryLedger({});
  led.record(act("p1"), "w1");
  led.record(act("p2", { accountId: "B" }), "w2");
  led.setCursor("item", "cur");
  const cfg = { A: { item_id: "item", wealthfolio_account_id: "WA" }, B: { item_id: "item", wealthfolio_account_id: "WB" } };
  expect(forgetEmptied(led, cfg, new Map([["WA", 0], ["WB", 5]]))).toEqual({ accounts: ["A"], rows: 1 });
  expect([led.get("p1"), led.get("p2") !== null, led.cursor("item")]).toEqual([null, true, null]);
  expect(forgetEmptied(led, cfg, new Map())).toEqual({ accounts: [], rows: 0 }); // unreadable: leave it
});

test("matchById links a row by the whole plaid id in the note, not a prefix", () => {
  const wfAcct = (a: string) => (a === "A" ? "W" : undefined);
  const hit = matchById([act("p1"), act("p12")], [ex("e1", { comment: "x · plaid:p12" }), ex("e2", { comment: "y · plaid:p1" })], wfAcct);
  expect([hit.get("p1")?.id, hit.get("p12")?.id]).toEqual(["e2", "e1"]);
  expect(matchById([act("p1")], [ex("e1", { comment: "plaid:p1x" })], wfAcct).size).toBe(0);
});
