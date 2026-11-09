// Browser tests against Wealthfolio in Docker: pnpm test:e2e. Without a running Docker they are skipped.
import { defineConfig } from "@playwright/test";
import { dockerRunning } from "./test/e2e/wealthfolio";

process.env.E2E_DOCKER ??= dockerRunning() ? "1" : "0";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  workers: 1, // one Wealthfolio container, reset for each test
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1400, height: 1000 } },
});
