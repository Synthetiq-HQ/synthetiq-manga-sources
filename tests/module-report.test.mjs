import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outBase = path.join(root, "reports", "module-test-ci-sample");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("module-tester --fixtures --report writes valid JSON and HTML for one module", async () => {
  await rm(`${outBase}.json`, { force: true });
  await rm(`${outBase}.html`, { force: true });

  const result = await run([
    path.join(root, "scripts/module-tester.mjs"),
    "black-clover",
    "--fixtures",
    "--report",
    "--out",
    outBase,
  ]);

  assert.equal(result.code, 0, `tester failed: ${result.stderr || result.stdout}`);

  const jsonPath = `${outBase}.json`;
  const htmlPath = `${outBase}.html`;
  await access(jsonPath);
  await access(htmlPath);

  const summary = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.mode, "fixtures");
  assert.ok(Array.isArray(summary.reports));
  assert.equal(summary.total, 1);
  assert.equal(summary.reports[0].module, "black-clover");
  assert.equal(typeof summary.reports[0].passed, "boolean");
  assert.ok(summary.reports[0].stages?.load?.ok);
  assert.ok(summary.reports[0].timingsMs);
  assert.ok(typeof summary.generatedAt === "string");

  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /black-clover/i);
  assert.match(html, /Module Probe Report|Module Test Report/i);
});
