import type { Page } from "@playwright/test";
import { type Addon, expect, test } from "./fixtures";
import { BASE } from "./wealthfolio";

const PROBLEM = "That did not work";

async function failReads(page: Page, path: string) {
  await page.route(`**/api/v1/addons/${path}`, (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 500, body: "storage is down" })
    : route.fallback());
}

async function seeProblemOn(addon: Addon, step: Parameters<Addon["step"]>[0]) {
  await addon.open();
  await addon.step(step);
  await expect(addon.frame.getByRole("tabpanel").getByText(PROBLEM)).toBeVisible();
}

test("shows why the addon could not start", async ({ page, addon }) => {
  await failReads(page, "storage/plaid-importer/last_sandbox");
  await page.goto(`${BASE}/addons/plaid-importer`);
  await expect(addon.frame.getByText(PROBLEM)).toBeVisible({ timeout: 30_000 });
});

test("Setup shows a failed key load", async ({ page, addon }) => {
  await failReads(page, "plaid-importer/secrets?key=plaid_client_id");
  await seeProblemOn(addon, "Setup");
});

test("Connections shows a failed load", async ({ page, addon }) => {
  await failReads(page, "storage/plaid-importer/items_sandbox");
  await seeProblemOn(addon, "Connections");
});

test("Accounts shows a failed load", async ({ page, addon }) => {
  await failReads(page, "storage/plaid-importer/accounts_sandbox");
  await seeProblemOn(addon, "Accounts");
});
