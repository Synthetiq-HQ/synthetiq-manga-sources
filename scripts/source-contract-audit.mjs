#!/usr/bin/env node
/**
 * Deterministic source-contract gate.
 *
 * This does not claim that a third-party source is live. It prevents a more
 * basic regression: publishing a module without an explicit chapter-ownership
 * classification, or weakening the ownership guard on a multi-series DOM parser.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJSON(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

const [index, policy] = await Promise.all([
  readJSON("index.json"),
  readJSON("tests/source-test-policy.json"),
]);

assert.equal(policy.schemaVersion, 1, "unsupported source-test policy schema");
const entries = Array.isArray(index.modules) ? index.modules : [];
const policyIDs = new Set(Object.keys(policy.modules || {}));
const indexIDs = new Set(entries.map((entry) => entry.id));

for (const id of indexIDs) assert.ok(policyIDs.has(id), `${id} is missing a source-test policy`);
for (const id of policyIDs) assert.ok(indexIDs.has(id), `${id} is not published in index.json`);

const lines = [];
for (const entry of entries) {
  const rule = policy.modules[entry.id];
  assert.ok(rule.chapterScope, `${entry.id} must declare chapterScope`);
  const manifestPath = String(entry.manifest?.path || "");
  const sourcePath = path.join(root, path.dirname(manifestPath), "index.js");
  const code = await readFile(sourcePath, "utf8");
  for (const fragment of rule.requiredCodeFragments || []) {
    assert.ok(code.includes(fragment), `${entry.id} lost its required chapter ownership guard: ${fragment}`);
  }
  lines.push(`${entry.id}: ${rule.chapterScope}`);
}

console.log(`Source contract policy passed for ${entries.length} published modules.`);
for (const line of lines) console.log(`- ${line}`);
