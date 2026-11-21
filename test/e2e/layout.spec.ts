import { readdirSync, readFileSync } from "node:fs";
import type { Frame } from "@playwright/test";
import { expect, test } from "./fixtures";

function uiClasses(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync("src/ui").filter((n) => n.endsWith(".tsx"))) {
    const src = readFileSync(`src/ui/${f}`, "utf8");
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{([^}]*(?:\$\{[^}]*\}[^}]*)*)\})/g)) {
      const attr = m[1] !== undefined ? `"${m[1]}"` : m[2];
      const parts = [...attr.matchAll(/([!=]==\s*)?(?:'([^']*)'|"([^"]*)")/g)].filter((q) => !q[1]).map((q) => q[2] ?? q[3]);
      for (const b of attr.matchAll(/`([^`]*)`/g)) parts.push(b[1].replace(/\$\{[^}]*\}/g, " "));
      for (const t of parts.join(" ").split(/\s+/)) if (/^[a-z-][\w:/.[\]()%-]*$/.test(t)) out.add(t);
    }
  }
  return [...out];
}

const addonFrame = (page: import("@playwright/test").Page): Frame => page.frames().find((f) => f !== page.mainFrame())!;

test("every class the addon uses is in Wealthfolio's stylesheet", async ({ addon }) => {
  await addon.open();
  const missing = await addonFrame(addon.page).evaluate((classes) => {
    const selectors: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if ((r as CSSStyleRule).selectorText) selectors.push((r as CSSStyleRule).selectorText);
        if ((r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const s of Array.from(document.styleSheets)) walk(s.cssRules);
    const all = selectors.join("\n");
    return classes.filter((c) => !all.includes(`.${CSS.escape(c)}`));
  }, uiClasses());
  expect(missing, "use a class Wealthfolio's own code uses (e.g. ms-auto, not ml-auto)").toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  const strayScrolls = (frame: Frame) => frame.evaluate(() => [...document.querySelectorAll("*")].filter((el) => {
    if (el.tagName === "TEXTAREA" || /\boverflow-/.test(String(el.className))) return false;
    const cs = getComputedStyle(el);
    const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    return (x || y) && !(x && !y && el.querySelector(":scope > table"));
  }).map((el) => `${el.tagName}.${el.className}: ${(el.textContent ?? "").slice(0, 40)}`));

  const clippedButtons = (frame: Frame) => frame.evaluate(() => [...document.querySelectorAll("button")].filter((b) => {
    const r = b.getBoundingClientRect();
    if (!r.width || b.closest("table")) return false;
    let p = b.parentElement;
    while (p && getComputedStyle(p).overflowX === "visible") p = p.parentElement;
    const box = p?.getBoundingClientRect();
    return b.scrollWidth > b.clientWidth + 1 || (box && (r.right > box.right + 1 || r.left < box.left - 1));
  }).map((b) => (b.textContent ?? "").trim()));

  test("every step fits: no stray scrolling, no clipped buttons, nothing squeezed", async ({ addon }) => {
    await addon.firstPush();
    const frame = addonFrame(addon.page);
    const go = async (step: Parameters<typeof addon.step>[0]) => {
      await addon.step(step);
      const anyway = addon.frame.getByRole("button", { name: "Continue anyway" });
      if (await anyway.isVisible({ timeout: 1500 }).catch(() => false)) await anyway.click();
    };
    const fits = async (step: string) => {
      expect(await strayScrolls(frame), `${step}: stray scroll`).toEqual([]);
      expect(await clippedButtons(frame), `${step}: clipped buttons`).toEqual([]);
    };

    await go("Setup");
    await fits("Setup");

    await go("Connections");
    await fits("Connections");
    expect((await addon.frame.locator("#tok").boundingBox())!.width).toBeGreaterThan(250);

    await go("Accounts");
    await expect(addon.frame.getByRole("button", { name: "Clear all" })).toBeVisible();
    await fits("Accounts");

    await go("Sync");
    await addon.frame.getByRole("button", { name: "Dry run" }).click();
    await expect(addon.frame.getByText("Push would make:")).toBeVisible({ timeout: 60_000 });
    await fits("Sync");

    await go("Daily sync");
    await addon.frame.getByRole("switch").click();
    const last = addon.frame.getByText(/^Last run: /);
    for (let i = 0; i < 2; i++) {
      const before = await last.textContent();
      await addon.frame.getByRole("button", { name: "Run now" }).click();
      await expect(last).not.toHaveText(before!, { timeout: 60_000 });
    }
    await fits("Daily sync");
    const message = addon.frame.locator("div[data-slot=card]", { hasText: "Recent runs" }).locator("td").last();
    expect((await message.boundingBox())!.width).toBeGreaterThan(200);

    await go("Backup");
    await addon.frame.getByRole("button", { name: /Make full backup/ }).click();
    await expect(addon.frame.getByText("Full backup ready")).toBeVisible();
    await fits("Backup");
  });
});

test("progress rows keep their height and the list scrolls when it is full", async ({ addon }) => {
  await addon.open();
  await addon.saveKeys();
  await addon.connect();
  await addon.createAccounts();
  await addon.dryRun();
  const list = addon.frame.locator("ul.max-h-72");
  const overflows = await list.evaluate((ul) => {
    const rows = [...ul.querySelectorAll(":scope > li")];
    for (let i = 0; i < 4; i++) for (const li of rows) ul.append(li.cloneNode(true));
    return ul.scrollHeight > ul.clientHeight;
  });
  expect(overflows).toBe(true);
  const squeezed = await list.evaluate((ul) => [...ul.querySelectorAll(":scope > li")]
    .filter((li) => li.scrollHeight > li.clientHeight + 1).map((li) => (li.textContent ?? "").slice(0, 40)));
  expect(squeezed).toEqual([]);
  await list.screenshot({ path: "test-results/progress-list.png" });
});
