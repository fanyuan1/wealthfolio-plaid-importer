import { entryAt, isRecord, itemAt, required, valueAt } from "../../src/importer";
import { describe, expect, it } from "vitest";
import { Activity, D, MemoryLedger, type PlaidEnv } from "../../src/importer";
import type { DryRun } from "../../src/engine/engine";
import type { Plan } from "../../src/importer";
import { Engine, needsReview, seenSecurities } from "../../src/engine/engine";
import { split, Store } from "../../src/engine/store";

const LIMIT = 244 * 1024;
function fakeApi(wfAccounts: string[] = []) {
  const kv = new Map<string, string>();
  const writes: string[] = [];
  const storage = {
    get: (k: string) => Promise.resolve(kv.get(k) ?? null),
    set: (k: string, v: string) => {
      if (new TextEncoder().encode(v).length > LIMIT) return Promise.reject(new Error("Invalid storage value: too large"));
      writes.push(k);
      kv.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => { kv.delete(k); return Promise.resolve(); },
  };
  const secrets = new Map<string, string>();
  const deletedRef: string[][] = [];
  return {
    kv, writes,
    deleted: deletedRef,
    api: {
      accounts: {
        getAll: () => Promise.resolve(wfAccounts.map((id) => ({ id, name: id, accountType: "CASH" }))),
        create: (a: { name: string }) => { wfAccounts.push(`new-${a.name}`); return Promise.resolve({ id: `new-${a.name}` }); },
      },
      activities: { getAll: () => Promise.resolve([]), saveMany: (r: { deleteIds?: string[] }) => { deletedRef.push(r.deleteIds ?? []); return Promise.resolve({}); } },
      storage,
      secrets: { get: (k: string) => Promise.resolve(secrets.get(k) ?? null), set: (k: string, v: string) => { secrets.set(k, v); return Promise.resolve(); }, delete: (k: string) => { secrets.delete(k); return Promise.resolve(); } },
    } as never,
  };
}

function bigLedger(n: number) {
  const l = new MemoryLedger({});
  for (let i = 0; i < n; i++) {
    l.rows.set(`p${i}`, { plaid_id: `p${i}`, account_id: "acc", wf_activity_id: `wf-${i}`, activity_type: "WITHDRAWAL",
      date: "2026-01-01", symbol: null, quantity: null, unit_price: null, amount: "12.34", fee: null, currency: "USD",
      transfer_hint: 0, pair_plaid_id: null, category_set: 1, voided: 0, note: "Café ☕ 𝄞" } as never);
  }
  return l;
}

describe("Store parts", () => {
  it("splits a ledger over the size limit and reads it back", async () => {
    const f = fakeApi(), s = new Store(f.api);
    await s.saveLedger("sandbox", bigLedger(5000));
    expect(f.kv.size).toBeGreaterThan(2);
    const back = await s.ledger("sandbox");
    expect(back.rows.size).toBe(5000);
    expect(back.rows.get("p4999")?.wf_activity_id).toBe("wf-4999");
  });

  it("writes only changed parts and deletes unused ones", async () => {
    const f = fakeApi(), s = new Store(f.api);
    const l = bigLedger(5000);
    await s.saveLedger("sandbox", l);
    const before = f.writes.length;
    l.rows.set("new", { ...entryAt(l.rows, "p0"), plaid_id: "new" });
    await s.saveLedger("sandbox", l);
    expect(f.writes.length - before).toBeLessThanOrEqual(3);
    await s.saveLedger("sandbox", new MemoryLedger({}));
    expect([...f.kv.keys()]).toEqual(["ledger_sandbox"]);
    expect((await s.ledger("sandbox")).rows.size).toBe(0);
  });

  it("keeps surrogate pairs whole", () => {
    const parts = split("a𝄞b𝄞", 2);
    expect(parts.join("")).toBe("a𝄞b𝄞");
    for (const p of parts) expect(p).toBe(String.fromCodePoint(...Array.from(p, (c) => c.codePointAt(0) ?? 0)));
  });
});

describe("addToken", () => {
  it("rejects tokens from another environment before calling Plaid", async () => {
    const e = new Engine(fakeApi().api);
    await expect(e.addToken("AB", "access-production-11111111-2222-3333-4444-555555555555")).rejects.toThrow(/production token/);
    await expect(e.addToken("AB", "not-a-token")).rejects.toThrow(/access token looks like/);
  });
});

describe("seenSecurities", () => {
  it("reads investment securities keyed by id and holdings securities as a list", () => {
    const items = [{
      inv: { securities: { s1: { security_id: "s1", name: "Fund One", ticker_symbol: "AAA", type: "etf" } } },
      holdings: { securities: [{ security_id: "s2", name: "No Ticker Fund", ticker_symbol: null, type: "mutual fund" }], holdings: [] },
    }];
    const out = seenSecurities(items, {});
    expect(out.map((s) => [s.sid, s.result])).toEqual([["s1", "AAA"], ["s2", "unmapped"]]);
  });

  it("needs review unless the user chose, or Automatic is proven", () => {
    const sec = (result: string, ticker: string | null, override: object | null = null) =>
      ({ sid: "s", name: "S", ticker, type: "etf", result, manual: false, reported: null, override, review: false });
    expect(needsReview(sec("unmapped", null), {})).toBe(true);
    expect(needsReview(sec("VTI", "VTI"), { VTI: true })).toBe(false);
    expect(needsReview(sec("VTI", "VTI"), { VTI: null })).toBe(true);
    expect(needsReview(sec("cash", "CUR:EUR"), {})).toBe(false);
    expect(needsReview(sec("cash", "SPAXX"), {})).toBe(true);
    expect(needsReview(sec("cash", "SPAXX", { cash: true }), {})).toBe(false);
  });
});

describe("backup", () => {
  async function source() {
    const a = new Engine(fakeApi().api);
    await a.store.saveToken("item1", "access-sandbox-x");
    await a.store.saveItems("sandbox", { item1: { owner: "AB", institution_name: "Test Bank" } });
    await a.store.saveAccounts("sandbox", { acc: { kind: "cash", item_id: "item1", wealthfolio_account_id: "wf1" } });
    await a.store.saveLedger("sandbox", bigLedger(3));
    return a;
  }

  it("a connections backup holds only connections and their tokens", async () => {
    const a = await source();
    await a.store.saveItems("sandbox", { item1: { owner: "AB", institution_name: "Test Bank", checked: "2026-11-08T00:00:00Z" } });
    const text = await a.backup("connections");
    const backup: unknown = JSON.parse(text);
    expect(isRecord(backup) ? Object.keys(backup).sort() : backup).toEqual(["env", "format", "items", "kind"]);
    const b = new Engine(fakeApi(["wf1"]).api);
    expect(await b.restore(text)).toEqual({ kind: "connections", items: 1, accounts: 0, rows: 0, ledger: "none", removed: 0 });
    expect(await b.store.accounts("sandbox")).toEqual({});
    expect(await b.store.token("item1")).toBe("access-sandbox-x");
    expect(await b.store.items("sandbox")).toEqual({ item1: { owner: "AB", institution_name: "Test Bank", env: "sandbox" } });
    expect((await b.store.ledger("sandbox")).rows.size).toBe(0);
  });

  it("a full backup restores the ledger into the same Wealthfolio, without duplicates", async () => {
    const a = await source();
    await a.store.saveRemap("sandbox", { full: ["acc"], dropped: { VTI: ["acc"] } });
    const text = await a.backup("full");
    const b = new Engine(fakeApi(["wf1"]).api);
    expect((await b.restore(text)).rows).toBe(3);
    expect((await b.store.ledger("sandbox")).rows.size).toBe(3);
    expect((await b.restore(text)).rows).toBe(0);
    expect(await b.store.remap("sandbox")).toEqual({ full: ["acc"], dropped: { VTI: ["acc"] } });
  });

  it("a full backup into another Wealthfolio leaves the ledger out", async () => {
    const text = await (await source()).backup("full");
    const b = new Engine(fakeApi(["other"]).api);
    expect((await b.restore(text)).ledger).toBe("other-wealthfolio");
    expect((await b.store.ledger("sandbox")).rows.size).toBe(0);
    expect(await b.store.token("item1")).toBe("access-sandbox-x");
  });

  it("merge restores the token of a connection that lost it", async () => {
    const text = await (await source()).backup("connections");
    const b = new Engine(fakeApi(["wf1"]).api);
    await b.store.saveItems("sandbox", { item1: { owner: "XY", institution_name: "Test Bank" } });
    await b.restore(text);
    expect(await b.store.token("item1")).toBe("access-sandbox-x");
    expect(valueAt(await b.store.items("sandbox"), "item1").owner).toBe("XY");
  });

  it("merge keeps what is here; overwrite replaces it and removes connections the backup lacks", async () => {
    const text = await (await source()).backup("full");
    const b = new Engine(fakeApi(["wf1"]).api);
    await b.store.saveToken("item1", "access-sandbox-new");
    await b.store.saveToken("item2", "access-sandbox-other");
    await b.store.saveItems("sandbox", { item1: { owner: "XY", institution_name: "Test Bank" }, item2: { owner: "CD", institution_name: "Other" } });
    await b.store.saveAccounts("sandbox", { acc2: { kind: "cash", item_id: "item2", wealthfolio_account_id: "wf1" } });
    await b.restore(text);
    expect(valueAt(await b.store.items("sandbox"), "item1").owner).toBe("XY");
    expect(await b.store.token("item1")).toBe("access-sandbox-new");
    expect(await b.overwriteLoss(text)).toEqual(["CD · Other"]);
    const r = await b.restore(text, "overwrite");
    expect(r.removed).toBe(1);
    expect(Object.keys(await b.store.items("sandbox"))).toEqual(["item1"]);
    expect(await b.store.token("item2")).toBeNull();
    expect(valueAt(await b.store.items("sandbox"), "item1").owner).toBe("AB");
    expect(await b.store.token("item1")).toBe("access-sandbox-x");
    expect(Object.keys(await b.store.accounts("sandbox"))).toEqual(["acc"]);
    expect((await b.store.ledger("sandbox")).rows.size).toBe(3);
  });

  it("rejects a backup for the other environment, and other JSON", async () => {
    const e = new Engine(fakeApi().api);
    await expect(e.restore(JSON.stringify({ format: "plaid-importer-backup", kind: "full", env: "production" }))).rejects.toThrow(/for production/);
    await expect(e.restore("{}")).rejects.toThrow(/not a Plaid Importer backup/);
    await expect(e.restore("nope")).rejects.toThrow(/not a Plaid Importer backup/);
  });
});

describe("previous account", () => {
  it("links the picked Wealthfolio account, creates one for New, and keeps the pick off other rows", async () => {
    const e = new Engine(fakeApi(["wfA", "wfB"]).api);
    await e.store.saveAccounts("sandbox", {
      a: { item_id: "i", kind: "cash", name: "AB · Chase Checking", wealthfolio_account_id: null, skip: false },
      b: { item_id: "i", kind: "cash", name: "AB · Chase Savings", wealthfolio_account_id: null, skip: false },
    });
    await e.setMatch("a", "wfB");
    await e.setMatch("b", "new");
    expect(await e.createAccounts()).toBe(1);
    const cfg = await e.store.accounts("sandbox");
    expect(valueAt(cfg, "a").wealthfolio_account_id).toBe("wfB");
    expect(valueAt(cfg, "b").wealthfolio_account_id).toBe("new-AB · Chase Savings");
    expect(await e.accountsReady()).toBe(true);
  });
});

describe("tasks", () => {
  it("keep progress and result after the run, notify screens, and refuse a second run at once", async () => {
    const e = new Engine(fakeApi().api);
    let seen = 0;
    e.subscribe(() => seen++);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = e.task("k", "work", async (io) => {
      io.progress({ id: "a", label: "A", state: "running" });
      await gate;
      io.progress({ id: "a", label: "A", state: "done" });
      return 42;
    });
    expect(e.tasks.k?.running).toBe(true);
    await expect(e.task("k", "work", () => Promise.resolve(1))).rejects.toThrow(/still running/);
    release();
    expect(await run).toBe(42);
    expect(e.tasks.k).toMatchObject({ running: false, result: 42, progress: [{ id: "a", state: "done" }] });
    expect(seen).toBeGreaterThan(2);
  });
});

describe("link plan", () => {
  it("gives a Wealthfolio account to one row only, and user picks win over name suggestions", async () => {
    const { planLinks } = await import("../../src/importer");
    const wf = [{ id: "w1", name: "AB · Chase Checking", accountType: "CASH" }, { id: "w2", name: "Other", accountType: "CASH" }];
    const cfg = {
      a: { item_id: "i", kind: "cash", name: "AB · Chase Checking", wealthfolio_account_id: null, skip: false },
      b: { item_id: "i", kind: "cash", name: "AB · Chase Checking 2", wealthfolio_account_id: null, skip: false, match: "w1" },
      c: { item_id: "i", kind: "cash", name: "AB · Savings", wealthfolio_account_id: null, skip: false, match: "w1" },
    } as never;
    expect(planLinks(cfg, wf)).toEqual({ a: null, b: "w1", c: null });
  });

  it("lets a link change only before the first push", async () => {
    const e = new Engine(fakeApi(["w1"]).api);
    await e.store.saveAccounts("sandbox", { a: { item_id: "i", kind: "cash", name: "A", wealthfolio_account_id: "w1", match: "w1" } });
    await e.unlinkAccount("a");
    expect(valueAt(await e.store.accounts("sandbox"), "a").wealthfolio_account_id).toBeNull();
    await e.store.saveAccounts("sandbox", { a: { item_id: "i", kind: "cash", name: "A", wealthfolio_account_id: "w1" } });
    const l = new MemoryLedger({});
    l.rows.set("p", row("p", "a"));
    await e.store.saveLedger("sandbox", l);
    await expect(e.unlinkAccount("a")).rejects.toThrow(/already pushed/);
  });
});

describe("reconnect flag", () => {
  it("is cleared by a finished reconnect", async () => {
    const e = new Engine(fakeApi().api);
    await e.store.saveItems("sandbox", { i: { owner: "AB", institution_name: "Chase", reconnect: true } });
    e.plaid = () => Promise.resolve(({ linkTokenGet: () => Promise.resolve([{ on_success: {} }]) }) as never);
    e.refreshAccounts = () => Promise.resolve([]);
    expect((await e.checkReconnect("i", "t")).state).toBe("done");
    expect(valueAt(await e.store.items("sandbox"), "i").reconnect).toBe(false);
  });
});

describe("joint accounts", () => {
  it("Select all turns on one copy of a joint account linked under two owners", async () => {
    const e = new Engine(fakeApi().api);
    const acct = (owner: string, name: string) => ({ item_id: owner, owner, kind: "cash", name, institution_id: "ins", mask: "1111", plaid_subtype: "checking", skip: true });
    await e.store.saveAccounts("sandbox", { a: acct("AB", "AB · Chase ••1111"), b: acct("CD", "CD · Chase ••1111"),
      c: { ...acct("AB", "AB · Chase ••2222"), mask: "2222" } });
    await e.setSyncAll(true);
    const cfg = await e.store.accounts("sandbox");
    expect([valueAt(cfg, "a").skip, valueAt(cfg, "b").skip, valueAt(cfg, "c").skip]).toEqual([false, true, false]);
  });
});

describe("dry run", () => {
  async function setup() {
    const e = new Engine(fakeApi(["W"]).api);
    await e.store.saveToken("i", "access-sandbox-x");
    await e.store.saveItems("sandbox", { i: { owner: "AB", institution_name: "Bank" } });
    await e.store.saveAccounts("sandbox", { A: { item_id: "i", kind: "cash", name: "AB · Bank", wealthfolio_account_id: "W", skip: false } });
    let pulls = 0;
    e.plaid = () => Promise.resolve(({
      item: () => Promise.resolve(({})),
      transactionsSync: () => { pulls++; return Promise.resolve({ added: [], modified: [], removed: [], next_cursor: "c" }); },
      accounts: () => Promise.resolve([]),
    }) as never);
    return { e, pulls: () => pulls };
  }
  it("after a push, plans what is left from the same pull, without what was pushed", async () => {
    const { e, pulls } = await setup();
    const tx = { transaction_id: "t1", account_id: "A", amount: 10, date: "2026-11-01", name: "Coffee", iso_currency_code: "USD", pending: false };
    e.plaid = () => Promise.resolve(({ item: () => Promise.resolve(({})), accounts: () => Promise.resolve([]),
      transactionsSync: () => Promise.resolve(({ added: [tx, { ...tx, transaction_id: "t2", name: "Tea" }], modified: [], removed: [], next_cursor: "c" })) }) as never);
    const d = await e.dryRun(() => {});
    const ids = d.plan.new.map((x) => x.plaidId);
    expect(ids).toEqual(expect.arrayContaining(["t1", "t2"]));
    const state = await e.store.ledger("sandbox");
    state.record(required(d.plan.new.find((x) => x.plaidId === "t1"), "t1"), "wf1");
    await e.store.saveLedger("sandbox", state);
    const left = await e.afterPush(d);
    expect(left.plan.new.map((x) => x.plaidId)).toContain("t2");
    expect(left.plan.new.map((x) => x.plaidId)).not.toContain("t1");
    expect(pulls()).toBe(0);
  });

  it("reuses a recent Plaid pull, and pulls again when asked or when the accounts change", async () => {
    const { e, pulls } = await setup();
    await e.dryRun(() => {});
    await e.dryRun(() => {});
    expect(pulls()).toBe(1);
    await e.dryRun(() => {}, () => {}, true);
    expect(pulls()).toBe(2);
    await e.store.saveAccounts("sandbox", { A: { item_id: "i", kind: "cash", name: "AB · Bank", wealthfolio_account_id: "W", skip: false },
      B: { item_id: "i", kind: "cash", name: "AB · Bank 2", wealthfolio_account_id: "W", skip: false } });
    await e.dryRun(() => {});
    expect(pulls()).toBe(3);
  });
});

describe("securities changes after a push", () => {
  async function setup() {
    const e = new Engine(fakeApi(["W"]).api);
    await e.store.saveToken("i", "access-sandbox-x");
    await e.store.saveItems("sandbox", { i: { owner: "AB", institution_name: "Broker" } });
    await e.store.saveAccounts("sandbox", { B: { item_id: "i", kind: "investment", name: "AB · Broker", wealthfolio_account_id: "W", skip: false } });
    const secs = { v: { security_id: "v", ticker_symbol: "VTI", type: "etf", iso_currency_code: "USD" },
      f: { security_id: "f", ticker_symbol: null, name: "Plan Fund", type: "mutual fund", iso_currency_code: "USD" } };
    const txns = [
      { investment_transaction_id: "t1", account_id: "B", security_id: "v", type: "buy", subtype: "buy", date: "2025-06-02", amount: 1000, quantity: 10, price: 100, iso_currency_code: "USD", name: "Buy VTI" },
      { investment_transaction_id: "f1", account_id: "B", security_id: "f", type: "buy", subtype: "buy", date: "2025-06-03", amount: 50, quantity: 5, price: 10, iso_currency_code: "USD", name: "Buy fund" },
    ];
    const starts: string[] = [];
    e.plaid = () => Promise.resolve(({
      item: () => Promise.resolve(({})),
      holdings: () => Promise.resolve(({ accounts: [], securities: Object.values(secs),
        holdings: [{ account_id: "B", security_id: "v", quantity: 10, cost_basis: 1000 }, { account_id: "B", security_id: "f", quantity: 5, cost_basis: 50 }] })),
      investmentTransactions: (_t: string, start: string) => {
        starts.push(start);
        return Promise.resolve({ securities: secs, investment_transactions: txns.filter((t) => t.date >= start) });
      },
    }) as never);
    const pushAll = async (d: Awaited<ReturnType<Engine["dryRun"]>>) => {
      for (const a of d.plan.new) d.state.record(a, `wf-${a.plaidId}`);
      for (const [aid, day] of Object.entries(d.plan.invLastEnd)) d.state.setInvLastEnd(aid, day);
      for (const aid of d.plan.fullHistory) d.state.setFullHistory(aid);
      await e.store.saveLedger("sandbox", d.state);
    };
    const first = await e.dryRun(() => {}, () => {}, true);
    await e.setSecurity("f", "Plan Fund", { mode: "exclude" });
    await pushAll(await e.replan(first));
    (e as unknown as { api: { activities: { getAll: () => Promise<unknown[]> } } }).api.activities.getAll = () => Promise.resolve([{ id: "wf-t1" }]);
    return { e, starts };
  }

  it("a security that starts to be imported gets its older rows and opening position", async () => {
    const { e, starts } = await setup();
    const quick = await e.dryRun(() => {}, () => {}, true);
    expect(required(starts.at(-1), "start") > "2025-06-03").toBe(true);
    await e.setSecurity("f", "Plan Fund", { mode: "manual", symbol: "PLANFUND" });
    expect((await e.store.remap("sandbox")).full).toEqual(["B"]);
    const d = await e.replan(quick);
    expect(required(starts.at(-1), "start") <= "2025-06-03").toBe(true);
    expect(d.backfill).toEqual(new Set(["B"]));
    expect(d.plan.new.map((a) => a.plaidId)).toContain("f1");
  });

  it("rows pushed under a symbol now set to Leave out or cash are offered for delete, then rebuilt", async () => {
    const { e } = await setup();
    await e.dryRun(() => {}, () => {}, true);
    await e.setSecurity("v", "VTI", { mode: "exclude" });
    expect((await e.store.remap("sandbox")).dropped).toEqual({ VTI: ["B"] });
    const moved = await e.dryRun(() => {});
    expect(moved.plan.moved.get("VTI")).toEqual(new Set(["B"]));
    await e.retrack("VTI", new Set(["B"]));
    expect(await e.store.remap("sandbox")).toEqual({ full: ["B"], dropped: {} });
    const d = await e.dryRun(() => {});
    expect(d.plan.moved.size).toBe(0);
    expect(d.backfill).toEqual(new Set(["B"]));
    await e.push(d, () => {});
    expect((await e.store.remap("sandbox")).full).toEqual([]);
  });

  it("setting a symbol back clears its pending delete", async () => {
    const { e } = await setup();
    await e.dryRun(() => {}, () => {}, true);
    await e.setSecurity("v", "VTI", { mode: "cash" });
    await e.setSecurity("v", "VTI", { mode: "auto" });
    expect((await e.store.remap("sandbox")).dropped).toEqual({});
  });
});

describe("setOwner", () => {
  it("renames only accounts not yet in Wealthfolio", async () => {
    const e = new Engine(fakeApi().api);
    await e.store.saveItems("sandbox", { i: { owner: "AV", institution_name: "Chase" } });
    await e.store.saveAccounts("sandbox", {
      a: { item_id: "i", owner: "AV", kind: "cash", institution: "Chase", plaid_name: "Checking", mask: "1111", name: "AV · Chase Checking ••1111", wealthfolio_account_id: null },
      b: { item_id: "i", owner: "AV", kind: "cash", institution: "Chase", plaid_name: "Savings", mask: "2222", name: "AV · Chase Savings ••2222", wealthfolio_account_id: "wf" },
    });
    await e.setOwner("i", "ab");
    const cfg = await e.store.accounts("sandbox");
    expect(valueAt(cfg, "a").name).toBe("AB · Chase Checking ••1111");
    expect(valueAt(cfg, "b").name).toBe("AV · Chase Savings ••2222");
    expect([valueAt(cfg, "a").owner, valueAt(cfg, "b").owner]).toEqual(["AB", "AB"]);
    expect(valueAt(await e.store.items("sandbox"), "i").owner).toBe("AB");
    await expect(e.setOwner("i", "A1")).rejects.toThrow(/1 to 4 letters/);
  });
});

describe("hosted link", () => {
  const withSessions = (sessions: unknown[]) => {
    const e = new Engine(fakeApi().api);
    e.plaid = () => Promise.resolve(({ linkTokenGet: () => Promise.resolve(sessions) }) as never);
    return e;
  };
  it("waits while the login page is open, and reports a closed one", async () => {
    expect(await withSessions([]).checkHostedLink("AB", "t")).toEqual({ state: "waiting" });
    expect(await withSessions([{ started_at: "x" }]).checkHostedLink("AB", "t")).toEqual({ state: "waiting" });
    expect((await withSessions([{ finished_at: "x", exit: {} }]).checkHostedLink("AB", "t")).state).toBe("exited");
    expect(await withSessions([{ on_exit: { error: { display_message: "Bank is down" } } }]).checkReconnect("i", "t"))
      .toEqual({ state: "exited", message: "Bank is down" });
  });
});

describe("refreshStale", () => {
  it("skips connections checked in the last day and never calls Identity", async () => {
    const e = new Engine(fakeApi().api);
    const now = Date.parse("2026-11-08T12:00:00Z");
    await e.store.saveItems("sandbox", {
      fresh: { owner: "AB", institution_name: "A", checked: new Date(now - 3600_000).toISOString() },
      old: { owner: "AB", institution_name: "B", products: ["identity"], checked: new Date(now - 2 * 86400_000).toISOString() },
    });
    const calls: [string, boolean][] = [];
    e.refreshAccounts = (id, identity = true) => { calls.push([id, identity]); return Promise.resolve(["x"]); };
    expect(await e.refreshStale(() => {}, now)).toEqual({ added: 1, failed: [] });
    expect(calls).toEqual([["old", false]]);
  });
});

describe("replan", () => {
  const dry = (tracked: string[]): DryRun => ({ env: "sandbox" as PlaidEnv, fetched: { items: [], skipped: [], blocked: [] },
    cfg: {}, state: new MemoryLedger({}), tracked: new Set(tracked), adoptions: [] } as never);

  it("plans again from the last pull with the saved securities", async () => {
    const e = new Engine(fakeApi().api);
    await e.setSecurity("s1", "Fund", { mode: "ticker", symbol: "vfiax" });
    const d = await e.replan(dry([]));
    expect(d.plan.new).toEqual([]);
    expect(valueAt(await e.store.symbols("sandbox"), "s1").symbol).toBe("VFIAX");
  });

  it("replans without a dry run when a fund newly follows a ticker (pulls only that history)", async () => {
    const e = new Engine(fakeApi().api);
    await e.setSecurity("s1", "Trust", { mode: "track", track: { symbol: "VOO", date: "2026-01-02", price: 50, close: 500, ratio: 0.1 } });
    await expect(e.replan(dry([]))).resolves.toBeTruthy();
    await expect(e.replan(dry(["s1"]))).resolves.toBeTruthy();
  });
});

const row = (pid: string, acct: string, pair: string | null = null) => ({ plaid_id: pid, account_id: acct, wf_activity_id: `wf-${pid}`,
  activity_type: "TRANSFER_OUT", date: "2026-01-01", symbol: null, quantity: null, unit_price: null, amount: "1", fee: null,
  currency: "USD", transfer_hint: 1, pair_plaid_id: pair, category_set: 0, voided: 0 });

describe("autoSync", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 7, h, m);
  const engine = () => Object.assign(new Engine(fakeApi().api), { lockSettleMs: 0 });
  const fakeDry = (moved = false, securities: object[] = []) => ({ env: "sandbox", rebases: [], adoptions: [], securities, tracked: new Set(), fetched: { items: [], skipped: [], blocked: [] },
    plan: { new: [], updates: [], voids: [], pairs: [], reviews: [], categories: new Map(), moved: new Map(moved ? [["OLD", new Set(["A"])]] : []) } }) as never;

  it("runs in one window when several share the storage", async () => {
    const { api } = fakeApi();
    let pushes = 0;
    const tab = () => {
      const e = new Engine(api);
      e.lockSettleMs = 20;
      e.dryRun = () => Promise.resolve(fakeDry());
      e.push = () => { pushes++; return Promise.resolve({ imported: 0, updated: 0, linked: 0 } as never); };
      return e;
    };
    const tabs = [tab(), tab(), tab()];
    await itemAt(tabs, 0).store.saveDaily({ on: true, time: "08:30" });
    const runs = await Promise.all(tabs.map((e) => e.autoSync(at(9))));
    expect(runs.filter(Boolean).length).toBe(1);
    expect(pushes).toBe(1);
    expect(await itemAt(tabs, 0).store.dailyLock("sandbox")).toBeNull();

    const e = tab();
    await e.store.saveDailyLock("sandbox", { id: "other", at: at(10).toISOString() });
    expect(await e.runDaily(at(10, 5))).toBeNull();
    expect((await e.runDaily(at(11)))?.status).toBe("ok");
  });

  it("runs once a day after the set time, and not while another task runs", async () => {
    const e = engine();
    let pushes = 0;
    e.dryRun = () => Promise.resolve(fakeDry());
    e.push = () => { pushes++; return Promise.resolve({ imported: 0, updated: 0, linked: 0 } as never); };
    expect(await e.autoSync(at(9))).toBeNull();
    await e.store.saveDaily({ on: true, time: "08:30" });
    expect(await e.autoSync(at(8, 29))).toBeNull();
    e.tasks.sync = { label: "Dry run", running: true, progress: [], log: [] };
    expect(await e.autoSync(at(9))).toBeNull();
    e.tasks.sync = undefined;
    e.tasks.daily = { label: "run", running: true, progress: [], log: [] };
    await expect(e.task("dry", "dry", () => Promise.resolve(1))).rejects.toThrow(/daily sync is running/);
    e.tasks.daily = undefined;
    expect((await e.autoSync(at(8, 30)))?.status).toBe("ok");
    expect(await e.autoSync(at(12))).toBeNull();
    let reads = 0;
    const settings = e.store.settings.bind(e.store);
    e.store.settings = async () => { reads++; return settings(); };
    expect(await e.autoSync(at(13))).toBeNull();
    expect(reads).toBe(0);
    expect(pushes).toBe(1);
    const runs = required((await e.store.autoRun("sandbox")).runs, "runs");
    expect(runs.length).toBe(1);
    expect(itemAt(runs, 0).totals).toBeTruthy();
    expect((await e.nextDaily(at(12)))?.getDate()).toBe(8);
  });

  it("refuses the user's changes while it runs, and waits while one is saved", async () => {
    const e = engine();
    await e.store.saveAccounts("sandbox", { a: { item_id: "i", kind: "cash", name: "A" } });
    e.tasks.daily = { label: "run", running: true, progress: [], log: [] };
    await expect(e.setSync("a", false)).rejects.toThrow(/daily sync is running/);
    await expect(e.setSecurity("s", "S", { mode: "cash" })).rejects.toThrow(/daily sync is running/);
    expect(await e.checkHostedLink("AB", "link")).toEqual({ state: "waiting" });
    e.tasks.daily = undefined;
    await e.store.saveDaily({ on: true, time: "00:00" });
    let release!: () => void;
    const saving = (e as unknown as { write: (f: () => Promise<void>) => Promise<void> }).write(() => new Promise<void>((r) => { release = r; }));
    expect(await e.autoSync(at(9))).toBeNull();
    release();
    await saving;
    expect(e.busy).toBe(false);
  });

  it("keeps the daily switch on this device and the time in synced storage", async () => {
    const e = new Engine(fakeApi().api);
    await e.store.saveDaily({ on: true, time: "06:15" });
    expect(await e.store.daily()).toEqual({ on: true, time: "06:15" });
    expect((await e.store.settings()).daily).toEqual({ time: "06:15" });
  });

  it("does not stop on to-do items, and shows them in Sync", async () => {
    const e = engine();
    const d = fakeDry() as unknown as { plan: { reviews: unknown[] } };
    d.plan.reviews = [{}, {}, {}];
    e.dryRun = () => Promise.resolve(d as never);
    e.push = () => Promise.resolve(({ imported: 0, updated: 0, linked: 0 }) as never);
    e.afterPush = () => Promise.resolve(({ ...(fakeDry() as object), securities: [] }) as never);
    const r = await e.runDaily(at(9));
    expect(r?.status).toBe("ok");
    expect(r?.goto).toBe("sync");
    expect(r?.message).toMatch(/3 to do.*to-do list in Sync/);
    expect(e.view.dry).toBeTruthy();
  });

  it("keeps the last 7 runs, newest first", async () => {
    const e = engine();
    e.dryRun = () => Promise.reject(new Error("offline"));
    for (let i = 0; i < 9; i++) await e.runDaily(at(9, i));
    const runs = required((await e.store.autoRun("sandbox")).runs, "runs");
    expect(runs.length).toBe(7);
    expect(itemAt(runs, 0).status).toBe("failed");
    expect(itemAt(runs, 0).time).toBe(at(9, 8).toISOString());
  });

  it("does not push while a security needs review", async () => {
    const e = engine();
    await e.store.saveDaily({ on: true, time: "00:00" });
    e.dryRun = () => Promise.resolve(fakeDry(false, [{ sid: "s", name: "Fund", result: "unmapped", review: true }]));
    e.push = () => Promise.reject(new Error("must not push"));
    const r = await e.autoSync(at(9));
    expect(r?.status).toBe("stopped");
    expect(r?.message).toMatch(/1 securities need review/);
  });

  it("does not push when pushed activities moved to another symbol", async () => {
    const e = engine();
    await e.store.saveDaily({ on: true, time: "00:00" });
    e.dryRun = () => Promise.resolve(fakeDry(true));
    e.push = () => Promise.reject(new Error("must not push"));
    const r = await e.autoSync(at(9));
    expect(r?.status).toBe("stopped");
    expect(r?.goto).toBe("sync");
    expect(r?.message).toMatch(/map to another ticker/);
  });
});

describe("adoptions", () => {
  it("links a discarded row to the existing activity and does not add it", async () => {
    const f = fakeApi(), e = new Engine(f.api);
    const act = new Activity({ accountId: "A", plaidId: "p1", date: "2026-01-02", activityType: "BUY", symbol: "VTI", quantity: D(2), amount: D(100) });
    const emptyPlan = { new: [act], categories: new Map(), updates: [], voids: [], retype: [], pairs: [], reviews: [], cursors: {}, invLastEnd: {} };
    const d = { env: "sandbox", plan: emptyPlan, state: new MemoryLedger({}), cfg: { A: { kind: "investment", item_id: "i", wealthfolio_account_id: "W" } },
      fetched: { items: [], skipped: [], blocked: [] }, adoptions: [{ key: "p1", plaidId: "p1", accountId: "A", how: "exact", decision: "add",
        row: {}, existing: { id: "e1" } }] } as never as DryRun;
    itemAt(d.adoptions, 0).decision = "discard";
    await e.push(d, () => {}).catch(() => {});
    expect(d.state.get("p1")?.wf_activity_id).toBe("e1");
  });
});

describe("rows the importer pushed before", () => {
  it("are linked back as its own on a first push, not offered for review", async () => {
    const f = fakeApi(), e = new Engine(f.api);
    (f.api as { activities: { getAll: () => Promise<unknown[]> } }).activities.getAll = () => Promise.resolve([
      { id: "wf1", accountId: "W", activityType: "BUY", assetSymbol: "VTI", date: "2026-01-02", quantity: "2", amount: "100", comment: "plaid:p1" }]);
    const act = (pid: string) => new Activity({ accountId: "A", plaidId: pid, date: "2026-01-02", activityType: "BUY", symbol: "VTI", quantity: D(2), amount: D(100) });
    const p = { new: [act("p1"), act("p2")], categories: new Map() } as never as Plan;
    const state = new MemoryLedger({});
    const cfg = { A: { kind: "investment", item_id: "i", wealthfolio_account_id: "W" } };
    const out = await (e as never as { adoptions(p: Plan, c: unknown, s: MemoryLedger, prev: unknown[]): Promise<{ plaidId: string }[]> }).adoptions(p, cfg, state, []);
    expect(state.get("p1")?.wf_activity_id).toBe("wf1");
    expect(state.get("p1")?.adopted).toBeFalsy();
    expect(p.new.map((a) => a.plaidId)).toEqual(["p2"]);
    expect(out.map((a) => a.plaidId)).toEqual(["p2"]);
  });
});

describe("old data is kept", () => {
  it("drops Plaid changes and removals for adopted rows, and keeps them for the importer's own", async () => {
    const e = new Engine(fakeApi().api);
    const l = new MemoryLedger({});
    l.rows.set("old", { ...row("old", "A"), adopted: 1 });
    l.rows.set("mine", row("mine", "A"));
    const cfg = { A: { kind: "cash", item_id: "i", name: "Acct", wealthfolio_account_id: "W" } };
    const p = { updates: [[l.rows.get("old"), {}, ["amount"]], [l.rows.get("mine"), {}, ["amount"]]], voids: [l.rows.get("old")],
      retype: [], pairs: [] } as never as Plan;
    const lines = await (e as never as { protect(p: Plan, c: unknown, s: MemoryLedger): Promise<string[]> }).protect(p, cfg, l);
    expect(p.updates.length).toBe(1);
    expect(p.voids.length).toBe(0);
    expect(itemAt(lines, 0)).toMatch(/Kept as they are in Wealthfolio \(2\)/);
  });
});

describe("categorize", () => {
  const card = (pid: string, kw: Record<string, unknown> = {}) => ({ plaid_id: pid, account_id: "card", wf_activity_id: `wf-${pid}`,
    activity_type: "WITHDRAWAL", date: "2026-10-02", symbol: null, quantity: null, unit_price: null, amount: "5", fee: null,
    currency: "USD", transfer_hint: 0, pair_plaid_id: null, category_set: 0, voided: 0, category: "FOOD_AND_DRINK_COFFEE", ...kw });
  async function setup(rows: object[]) {
    const { api } = fakeApi();
    const assigned: unknown[][] = [];
    Object.assign(api, { spending: {
      getCategories: () => Promise.resolve([{ kind: "expense", taxonomyId: "spending_categories", categoryId: "c1", key: "food", name: "Food", path: "Food" }]),
      assignCategory: (...a: unknown[]) => { assigned.push(a); return Promise.resolve(); },
    } });
    const e = new Engine(api);
    await e.store.saveAccounts("sandbox", { card: { item_id: "i", kind: "credit", name: "AB · Card", wealthfolio_account_id: "W" },
      brk: { item_id: "i", kind: "investment", name: "AB · Broker", wealthfolio_account_id: "W2" } });
    await e.store.saveLedger("sandbox", new MemoryLedger({ rows: rows as never }));
    return { e, assigned };
  }

  it("uses the Plaid category kept with each row, with no Plaid call", async () => {
    const { e, assigned } = await setup([card("a"), card("set", { category_set: 1 }), card("leg", { pair_plaid_id: "x" }),
      card("refund", { activity_type: "DEPOSIT" }), card("inv", { account_id: "brk" }), card("gone", { voided: 1 })]);
    e.plaid = () => Promise.reject(new Error("must not call Plaid"));
    expect(await e.categorize()).toBe("Categorized 1 of 1 rows.");
    expect(assigned).toEqual([["wf-a", "expense", "c1"]]);
    expect((await e.store.ledger("sandbox")).get("a")?.category_set).toBe(1);
  });

  it("pulls once for rows pushed before the category was kept", async () => {
    const { e, assigned } = await setup([card("old", { category: undefined }), card("gone", { category: undefined })]);
    await e.store.saveItems("sandbox", { i: { owner: "AB", institution_name: "Bank", products: ["transactions"], env: "sandbox" } });
    await e.store.saveToken("i", "tok");
    let pulls = 0;
    const { Plaid } = await import("../../src/importer");
    e.plaid = () => Promise.resolve(new Plaid({ clientId: "id", secret: "secret" }, "sandbox", (url) => {
      const ep = url.replace(/^https:\/\/[^/]+/, "");
      if (ep === "/transactions/sync") {
        pulls++;
        return Promise.resolve({ status: 200, body: JSON.stringify({ added: [{ transaction_id: "old", account_id: "card", amount: 5, date: "2026-10-02", pending: false,
          name: "Coffee", iso_currency_code: "USD", personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" } }],
          modified: [], removed: [], next_cursor: "c", has_more: false }) });
      }
      return Promise.resolve({ status: 200, body: JSON.stringify(ep === "/item/get" ? { item: {} } : { accounts: [] }) });
    }));
    expect(await e.categorize()).toBe("Categorized 1 of 1 rows.");
    expect(assigned.map((a) => itemAt(a, 0))).toEqual(["wf-old"]);
    const state = await e.store.ledger("sandbox");
    expect(state.get("gone")?.category).toBeNull();
    expect(await e.categorize()).toMatch(/already has one/);
    expect(pulls).toBe(1);
  });
});
