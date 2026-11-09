// Each test gets a fresh Wealthfolio, a fake Plaid wired into the page, and helpers to drive the addon.
import { test as base, expect, type FrameLocator, type Page } from "@playwright/test";
import { FakePlaid, KEYS } from "./fake-plaid";
import { BASE, freshWealthfolio } from "./wealthfolio";

const NETWORK = "**/api/v1/addons/plaid-importer/network/request";

/** Answer the addon's network calls: Plaid from the fake, Yahoo Finance with no data. */
export async function routePlaid(page: Page, plaid: FakePlaid) {
  await page.route(NETWORK, async (route) => {
    const { request } = route.request().postDataJSON() as { request: { url: string; body?: string } };
    const url = new URL(request.url);
    const r = url.hostname.endsWith("plaid.com") ? plaid.handle(url.pathname, JSON.parse(request.body ?? "{}"))
      : { status: 404, body: { chart: { result: null, error: { code: "Not Found" } } } };
    await route.fulfill({ json: { status: r.status, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) } });
  });
}

export const test = base.extend<{ plaid: FakePlaid; addon: Addon }>({
  plaid: async ({ page }, use) => {
    test.skip(process.env.E2E_DOCKER !== "1", "Docker is not running");
    await freshWealthfolio();
    const plaid = new FakePlaid();
    await routePlaid(page, plaid);
    await use(plaid);
  },
  addon: async ({ page, plaid }, use) => {
    void plaid; // the fake must be wired before the page loads
    await use(new Addon(page));
  },
});
export { expect };

/** The addon's page. Addons render inside a sandboxed iframe. */
export class Addon {
  constructor(readonly page: Page) {}

  get frame(): FrameLocator {
    return this.page.frameLocator("iframe[title], iframe").first();
  }

  async open() {
    await this.page.goto(`${BASE}/addons/plaid-importer`);
    await expect(this.frame.getByRole("button", { name: /Setup/ })).toBeVisible({ timeout: 30_000 });
  }

  async step(name: "Setup" | "Connections" | "Accounts" | "Sync" | "Daily sync" | "Backup") {
    await this.frame.getByRole("button", { name: new RegExp(`^\\S*\\s*${name}$`) }).click();
  }

  async saveKeys() {
    await this.step("Setup");
    await this.frame.getByLabel("Client ID").fill(KEYS.clientId);
    await this.frame.getByLabel(/secret/).fill(KEYS.secret);
    await this.frame.getByRole("button", { name: /Save keys/ }).click();
    await expect(this.frame.getByText("Keys work")).toBeVisible();
  }

  /** Connect through the hosted login. The fake reports it done on the second poll; the page polls by itself. */
  async connect(owner = "AP") {
    await this.step("Connections");
    await this.frame.locator("#owner").fill(owner);
    await this.frame.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(this.frame.getByText("Waiting for you to finish on Plaid")).toBeVisible();
    await expect(this.frame.getByText(/Platypus Bank/).first()).toBeVisible({ timeout: 30_000 });
  }

  async createAccounts(n = 3) {
    await this.step("Accounts");
    await this.frame.getByRole("button", { name: "Select all" }).click();
    await this.frame.getByRole("button", { name: new RegExp(`Create ${n} Wealthfolio accounts?`) }).click();
    await expect(this.frame.getByText(`${n} account${n === 1 ? "" : "s"} created in Wealthfolio.`)).toBeVisible();
  }

  async dryRun() {
    await this.step("Sync");
    const anyway = this.frame.getByRole("button", { name: "Continue anyway" }); // spending is off in a new Wealthfolio
    if (await anyway.isVisible({ timeout: 2000 }).catch(() => false)) await anyway.click();
    await this.frame.getByRole("button", { name: "Dry run" }).click();
    await expect(this.frame.getByText("Push would make:")).toBeVisible({ timeout: 60_000 });
  }

  /** Review one security under Needs attention, then update the preview. */
  async review(security: string, mode: string) {
    await this.frame.getByRole("row", { name: new RegExp(security) }).getByRole("button", { name: "Review" }).click();
    await this.frame.getByRole("button", { name: mode, exact: true }).click();
    await this.frame.getByRole("button", { name: "Save", exact: true }).click();
    await this.frame.getByRole("button", { name: "Update preview" }).click();
  }

  async push() {
    const button = this.frame.getByRole("button", { name: "Push to Wealthfolio" });
    await expect(button).toBeEnabled({ timeout: 60_000 });
    await button.click();
    await expect(this.frame.getByText("Pushed", { exact: true })).toBeVisible({ timeout: 60_000 });
  }

  /** Keys, one connection, its accounts, and a first push. */
  async firstPush() {
    await this.open();
    await this.saveKeys();
    await this.connect();
    await this.createAccounts();
    await this.dryRun();
    await this.push(); // Plaid's CUR:USD needs no review
  }
}
