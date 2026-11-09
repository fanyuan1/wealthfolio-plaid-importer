// Build the zip the tests install, and pull the Wealthfolio image once.
import { execSync } from "node:child_process";
import { stopWealthfolio } from "./wealthfolio";

export default function setup() {
  if (process.env.E2E_DOCKER !== "1") {
    console.log("Docker is not running: the browser tests are skipped.");
    return;
  }
  execSync("pnpm -s bundle", { stdio: "inherit" });
  execSync("docker compose -f test/docker/compose.yml pull -q", { stdio: "inherit", env: { ...process.env, WF_SECRET_KEY: "x" } });
  return () => stopWealthfolio();
}
