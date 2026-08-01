import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requiredFiles = [
  "scripts/module-tester.mjs",
  "scripts/source-certifier.mjs",
  "scripts/module-certifier-mcp.mjs",
  "scripts/validate.mjs",
  "scripts/finalize-hashes.mjs",
];

test("testing guide references only available commands and tools", async () => {
  const [guide, packageText] = await Promise.all([
    readFile(new URL("../docs/TESTING.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const scripts = JSON.parse(packageText).scripts;

  for (const file of requiredFiles) {
    await assert.doesNotReject(() => readFile(new URL(`../${file}`, import.meta.url)));
  }

  for (const script of [
    "test:module",
    "test:module:fixtures",
    "test:module:report:fixtures",
    "certify:flagships:fixtures",
    "certify:flagships:live",
    "certify:flagships:ios",
    "certify:flagships",
  ]) {
    assert.equal(typeof scripts[script], "string", `missing npm script: ${script}`);
    assert.match(guide, new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const evidence of [
    "CONTRACT_PASS",
    "FIXTURE_PASS",
    "LIVE_NODE_PASS",
    "IOS_RUNTIME_PASS",
    "PARTIAL",
    "FAIL",
  ]) {
    assert.match(guide, new RegExp(`\\b${evidence}\\b`));
  }
});
