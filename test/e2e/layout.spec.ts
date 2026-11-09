// Layout on every surface: the addon only gets the Tailwind classes Wealthfolio itself uses, and it must fit a phone.
import { readdirSync, readFileSync } from "node:fs";
import type { Frame } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Every class written in a className attribute under src/ui. */
function uiClasses(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync("src/ui").filter((n) => n.endsWith(".tsx"))) {
    const src = readFileSync(`src/ui/${f}`, "utf8");
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{([^}]*(?:\$\{[^}]*\}[^}]*)*)\})/g)) {
      const attr = m[1] !== undefined ? `"${m[1]}"` : m[2];
      // Quoted strings anywhere (also inside ${...}), and the literal parts of template strings.
      // Skip compared values, e.g. kind === 'full'.
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

  /** Elements that scroll although they are not meant to: not text boxes, not elements with an overflow class, not the
   * tables' sideways scroll. */
  const strayScrolls = (frame: Frame) => frame.evaluate(() => [...document.querySelectorAll("*")].filter((el) => {
    if (el.tagName === "TEXTAREA" || /\boverflow-/.test(String(el.className))) return false;
    const cs = getComputedStyle(el);
    const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    return (x || y) && !(x && !y && el.querySelector(":scope > table"));
  }).map((el) => `${el.tagName}.${el.className}: ${(el.textContent ?? "").slice(0, 40)}`));

  /** Buttons cut off by their own width or by a clipping parent. Buttons in a table scroll with it. */
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
      const anyway = addon.frame.getByRole("button", { name: "Continue anyway" }); // spending is off in a new Wealthfolio
      if (await anyway.isVisible({ timeout: 1500 }).catch(() => false)) await anyway.click();
    };
    const fits = async (step: string) => {
      expect(await strayScrolls(frame), `${step}: stray scroll`).toEqual([]);
      expect(await clippedButtons(frame), `${step}: clipped buttons`).toEqual([]);
    };

    await go("Setup");
    await fits("Setup"); // the switch's touch area used to scroll its row

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
    // Recent runs scroll sideways instead of wrapping the message one word per line.
    const message = addon.frame.locator("div[data-slot=card]", { hasText: "Recent runs" }).locator("td").last();
    expect((await message.boundingBox())!.width).toBeGreaterThan(200);

    await go("Backup");
    await addon.frame.getByRole("button", { name: /Make full backup/ }).click();
    await expect(addon.frame.getByText("Full backup ready")).toBeVisible();
    await fits("Backup");
  });
});
