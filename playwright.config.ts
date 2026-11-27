import { defineConfig } from "@playwright/test";
import { dockerRunning, type WealthfolioOptions } from "./test/e2e/wealthfolio";

const MINIMUM_WEALTHFOLIO = "3.12.0";
const NEWEST_WEALTHFOLIO = "3.13.1";

process.env.E2E_DOCKER ??= dockerRunning() ? "1" : "0";

export default defineConfig<WealthfolioOptions>({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1400, height: 1000 } },
  projects: [MINIMUM_WEALTHFOLIO, NEWEST_WEALTHFOLIO].map((version) => ({
    name: `wealthfolio-${version}`,
    use: { wealthfolioVersion: version },
  })),
});
