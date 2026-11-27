import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import { E2E_BUILD, stopWealthfolio, type WealthfolioOptions } from "./wealthfolio";

const BUNDLE = fileURLToPath(new URL("../../scripts/bundle.sh", import.meta.url));

export default function setup(config: FullConfig<WealthfolioOptions>) {
  if (process.env.E2E_DOCKER !== "1") {
    console.log("Docker is not running: the browser tests are skipped.");
    return;
  }
  execFileSync(BUNDLE, [E2E_BUILD], { stdio: "inherit" });
  for (const { use } of config.projects) {
    execSync("docker compose -f test/docker/compose.yml pull -q", { stdio: "inherit", env: { ...process.env, WF_SECRET_KEY: "x", WF_VERSION: use.wealthfolioVersion } });
  }
  return () => stopWealthfolio();
}
