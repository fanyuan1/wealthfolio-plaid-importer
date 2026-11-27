import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { arrayOf, type Guard, isBoolean, isNumber, isRecord, isString, nullable, optional, shape } from "../../src/importer/json";

function read<T>(what: string, v: unknown, guard: Guard<T>): T {
  if (!guard(v)) throw new Error(`unexpected ${what}`);
  return v;
}
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const PORT = Number(process.env.E2E_WF_PORT ?? 18088);
export const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const PROJECT = "plaid-importer-e2e";
export const E2E_BUILD = "node_modules/.cache/plaid-importer-e2e";
const ZIP = `${E2E_BUILD}/plaid-importer-${read("package.json", readJson("package.json"), shape<{ version: string }>({ version: isString })).version}.zip`;
const HOSTS = read("manifest.json", readJson("manifest.json"),
  shape<{ network: { allowedHosts: string[] } }>({ network: shape<{ allowedHosts: string[] }>({ allowedHosts: arrayOf(isString) }) })).network.allowedHosts;

type WfAccount = { id: string; name: string; accountType: string; currency: string };
type WfActivity = { id: string; accountId: string; activityType: string; amount: string | number | null; date: string; comment?: string | null; quantity?: string | number | null; isUserModified?: boolean; unitPrice?: string | number | null; metadata?: Record<string, unknown> | null | undefined };
const isWfAccount = shape<WfAccount>({ id: isString, name: isString, accountType: isString, currency: isString });
const isWfActivity = shape<WfActivity>({ id: isString, accountId: isString, activityType: isString,
  amount: (v): v is string | number | null => v === null || isString(v) || isNumber(v), date: isString, comment: nullable(isString),
  quantity: optional((v): v is string | number | null => v === null || isString(v) || isNumber(v)), isUserModified: optional(isBoolean),
  unitPrice: optional((v): v is string | number | null => v === null || isString(v) || isNumber(v)), metadata: nullable(isRecord) });
const isActivityPage = shape<{ data: WfActivity[] }>({ data: arrayOf(isWfActivity) });

export type WealthfolioOptions = { wealthfolioVersion: string };

export function dockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function compose(version: string | undefined, ...args: string[]) {
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", "test/docker/compose.yml", ...args], {
    stdio: "pipe", timeout: 180_000,
    env: { ...process.env, WF_PORT: String(PORT), WF_SECRET_KEY: randomBytes(32).toString("base64"), ...(version ? { WF_VERSION: version } : {}) },
  });
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  return parsed;
}

export async function freshWealthfolio(version: string) {
  compose(version, "down", "-v", "--remove-orphans");
  compose(version, "up", "-d", "--wait");
  await call("PUT", "/settings", { onboardingCompleted: true, autoUpdateCheckEnabled: false, baseCurrency: "USD", timezone: "America/Los_Angeles" });
  const zip = readFileSync(ZIP).toString("base64");
  await call("POST", "/addons/install-zip", { zipDataB64: zip, enableAfterInstall: true, approvedNetworkHosts: HOSTS });
}

export function stopWealthfolio() {
  if (!process.env.E2E_KEEP) compose(undefined, "down", "-v", "--remove-orphans");
}

export const wf = {
  accounts: async (): Promise<WfAccount[]> => read("accounts", await call("GET", "/accounts"), arrayOf(isWfAccount)),
  activities: async (): Promise<WfActivity[]> =>
    read("activities", await call("POST", "/activities/search", { page: 0, pageSize: 1000 }), isActivityPage).data,
};
