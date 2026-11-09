// Install (or replace) the built zip in the local test Wealthfolio, approving the manifest's network hosts.
import { readFileSync } from "node:fs";

const port = process.env.WF_PORT ?? 8090;
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const hosts = JSON.parse(readFileSync("manifest.json", "utf8")).network.allowedHosts;
const zipDataB64 = readFileSync(`dist/plaid-importer-${version}.zip`).toString("base64");
const r = await fetch(`http://127.0.0.1:${port}/api/v1/addons/install-zip`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ zipDataB64, enableAfterInstall: true, approvedNetworkHosts: hosts }),
});
if (!r.ok) throw new Error(`Install failed: ${r.status} ${await r.text()}`);
console.log(`Installed plaid-importer ${version} in http://127.0.0.1:${port}. Reload the page.`);
