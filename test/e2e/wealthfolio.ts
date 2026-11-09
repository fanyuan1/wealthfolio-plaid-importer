// A throwaway Wealthfolio in Docker for the browser tests: its own compose project, port and data volume.
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const PORT = Number(process.env.E2E_WF_PORT ?? 18088);
export const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const PROJECT = "plaid-importer-e2e";
const ZIP = `dist/plaid-importer-${JSON.parse(readFileSync("package.json", "utf8")).version}.zip`;
const HOSTS = JSON.parse(readFileSync("manifest.json", "utf8")).network.allowedHosts as string[];

export function dockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function compose(...args: string[]) {
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", "test/docker/compose.yml", ...args], {
    stdio: "pipe", timeout: 180_000,
    env: { ...process.env, WF_PORT: String(PORT), WF_SECRET_KEY: randomBytes(32).toString("base64") },
  });
}

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** A new, empty Wealthfolio with the addon installed and onboarding done. */
export async function freshWealthfolio() {
  compose("down", "-v", "--remove-orphans");
  compose("up", "-d", "--wait");
  await call("PUT", "/settings", { onboardingCompleted: true, baseCurrency: "USD", timezone: "America/Los_Angeles" });
  const zip = readFileSync(ZIP).toString("base64");
  await call("POST", "/addons/install-zip", { zipDataB64: zip, enableAfterInstall: true, approvedNetworkHosts: HOSTS });
}

export function stopWealthfolio() {
  if (!process.env.E2E_KEEP) compose("down", "-v", "--remove-orphans");
}

export const wf = {
  accounts: (): Promise<{ id: string; name: string; accountType: string; currency: string }[]> => call("GET", "/accounts"),
  activities: async (): Promise<{ id: string; accountId: string; activityType: string; amount: string | number | null; date: string; comment?: string }[]> => {
    const r = await call("POST", "/activities/search", { page: 0, pageSize: 1000 });
    return r.data;
  },
};
