#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.resolve(root, "../Synthetiq Manga App");
const matrix = JSON.parse(await readFile(path.join(root, "certification/flagship-matrix.json"), "utf8"));
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || fallback) : fallback;
}

const requestedModule = option("--module", "all");
const mode = option("--mode", "all");
const outputPath = path.resolve(root, option("--output", "reports/certification-latest.json"));
const allowedModes = new Set(["fixtures", "live", "ios", "all"]);
if (!allowedModes.has(mode)) throw new Error(`Unsupported mode: ${mode}`);

const selected = matrix.modules.filter((entry) => requestedModule === "all" || entry.id === requestedModule || entry.slug === requestedModule);
if (!selected.length) throw new Error(`Unknown flagship module: ${requestedModule}`);

async function run(command, commandArgs, options = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 180_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-20_000),
        stderr: stderr.slice(-20_000),
      });
    });
  });
}

async function runModuleTester(entry, scenario, commandArgs) {
  const safeName = `${entry.slug}-${scenario}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const base = path.join(root, "reports/.certifier", safeName);
  await mkdir(path.dirname(base), { recursive: true });
  const result = await run(process.execPath, [
    "scripts/module-tester.mjs",
    entry.slug,
    ...commandArgs,
    "--report",
    "--out",
    path.relative(root, base),
  ]);
  let evidence = null;
  try { evidence = JSON.parse(await readFile(`${base}.json`, "utf8")); } catch { /* command output carries the failure */ }
  await rm(`${base}.html`, { force: true });
  await rm(`${base}.json`, { force: true });
  return { scenario, ...result, evidence };
}

async function certifyFixtures(entry) {
  return runModuleTester(entry, "fixtures", ["--fixtures"]);
}

async function certifyNodeLive(entry) {
  if (!entry.nodeLive) {
    return [{
      scenario: "node-live",
      ok: null,
      skipped: true,
      requiresIOS: true,
      reason: entry.requiresIOSReason,
    }];
  }
  const results = [];
  const popular = await runModuleTester(entry, "popular-pagination", [
    "--query", "__feed:popular",
    "--pages", String(entry.paginationPages || 3),
    "--limit", "8",
  ]);
  results.push(popular);
  if (!popular.ok && /HTTP (?:429|5\d\d)/i.test(`${popular.stderr}\n${popular.stdout}`)) {
    results.push({
      scenario: "remaining-live-scenarios",
      ok: null,
      skipped: true,
      reason: "Stopped after a systemic upstream failure to avoid a request storm.",
    });
    return results;
  }
  for (const query of entry.queries || []) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    results.push(await runModuleTester(entry, `title-${query}`, [
      "--skip-discovery",
      "--query", query,
      "--expect-title", query,
      "--limit", "12",
    ]));
  }
  if (entry.niche) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const nicheArgs = ["--skip-discovery", "--query", "*", "--limit", "12"];
    if (entry.niche.includeTags?.length) nicheArgs.push("--include-tags", entry.niche.includeTags.join(","));
    if (entry.niche.excludeTags?.length) nicheArgs.push("--exclude-tags", entry.niche.excludeTags.join(","));
    if (entry.niche.status) nicheArgs.push("--status", entry.niche.status);
    results.push(await runModuleTester(entry, "niche", nicheArgs));
  }
  return results;
}

async function certifyIOS(entries) {
  const ids = entries.map((entry) => entry.id).join(",");
  return run("xcodebuild", [
    "test",
    "-project", "SynthetiqManga.xcodeproj",
    "-scheme", "SynthetiqManga",
    "-destination", "platform=iOS Simulator,name=iPhone 17",
    "CODE_SIGNING_ALLOWED=NO",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) USE_LOCAL_SOURCE_REPO",
    "-only-testing:SynthetiqMangaEngineTests/LiveModuleRuntimeTests/testPublicModulesReadEndToEnd",
  ], {
    cwd: appRoot,
    timeoutMs: 20 * 60_000,
    env: {
      RUN_LIVE_TESTS: "1",
      TEST_RUNNER_RUN_LIVE_TESTS: "1",
      TEST_RUNNER_SOURCE_CERT_MODULES: ids,
    },
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  requestedModule,
  mode,
  modules: [],
  ios: null,
  passed: false,
};

for (const entry of selected) {
  const result = { id: entry.id, slug: entry.slug, fixtures: null, live: [] };
  if (mode === "fixtures" || mode === "all") result.fixtures = await certifyFixtures(entry);
  if (mode === "live" || mode === "all") result.live = await certifyNodeLive(entry);
  report.modules.push(result);
}
if (mode === "ios" || mode === "all") report.ios = await certifyIOS(selected);

const nodePassed = report.modules.every((entry) =>
  (!entry.fixtures || entry.fixtures.ok)
  && entry.live.every((scenario) => scenario.skipped || scenario.ok),
);
const iosPassed = report.ios == null || report.ios.ok;
const requiresIOS = report.modules.some((entry) => entry.live.some((scenario) => scenario.requiresIOS));
report.passed = nodePassed && iosPassed && (!requiresIOS || report.ios?.ok === true);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
  passed: report.passed,
  output: outputPath,
  modules: report.modules.map((entry) => ({
    id: entry.id,
    fixtures: entry.fixtures?.ok ?? null,
    live: entry.live.map((scenario) => ({ scenario: scenario.scenario, ok: scenario.ok, skipped: !!scenario.skipped })),
  })),
  ios: report.ios && { ok: report.ios.ok, durationMs: report.ios.durationMs },
}, null, 2));
if (!report.passed) process.exitCode = 1;
