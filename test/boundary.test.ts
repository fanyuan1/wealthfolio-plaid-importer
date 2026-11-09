// src/importer must stay pure: no host SDK, no React. The engine and UI depend on it, never the reverse.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const dir = join(__dirname, "../src/importer");

test("src/importer imports neither @wealthfolio nor react", () => {
  const bad = readdirSync(dir).filter((f) => f.endsWith(".ts")).filter((f) =>
    /from\s+["'](@wealthfolio\/|react\b|react-dom\b|\.\.\/(engine|ui)\b)/.test(readFileSync(join(dir, f), "utf8")));
  expect(bad).toEqual([]);
});
