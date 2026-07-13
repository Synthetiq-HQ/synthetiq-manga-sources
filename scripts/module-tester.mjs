#!/usr/bin/env node
/**
 * Module runtime tester — exercises modules the way the iOS app does:
 *   discoveryHome / searchResults → extractDetails → extractChapters → extractImages|extractText|extractResources
 *
 * Usage:
 *   node scripts/module-tester.mjs                 # all modules in index.json
 *   node scripts/module-tester.mjs mangadex        # one module
 *   node scripts/module-tester.mjs mangadex --live # real network (default is live)
 *   node scripts/module-tester.mjs --fixtures      # fixture-only path (no network)
 *   node scripts/module-tester.mjs mangadex --query "solo" --limit 3
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set();
const positionals = [];
let query = "a";
let itemLimit = 3;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--fixtures") {
    flags.add("--fixtures");
    continue;
  }
  if (arg === "--query") {
    query = args[i + 1] || "a";
    i += 1;
    continue;
  }
  if (arg === "--limit") {
    itemLimit = Math.max(1, Number(args[i + 1]) || 3);
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) {
    flags.add(arg);
    continue;
  }
  positionals.push(arg);
}
const useFixtures = flags.has("--fixtures");

function parseJSON(text) {
  return JSON.parse(text);
}

async function loadIndex() {
  return parseJSON(await readFile(path.join(root, "index.json"), "utf8"));
}

async function loadModuleScript(slug) {
  return readFile(path.join(root, "modules", slug, "index.js"), "utf8");
}

async function networkResponse(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(Math.max(10_000, Number(options.timeoutMilliseconds) || 25_000)),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  const textBody = dropped ? "" : new TextDecoder().decode(bytes);
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    finalUrl: response.url,
    body: textBody,
    bodyDropped: dropped,
    dropReason: dropped ? "maxBytesHint" : null,
    bodyBytes: bytes.length,
    contentType: response.headers.get("content-type") || "",
    error: null,
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  };
}

function fixtureResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    finalUrl: "https://fixture.invalid/",
    body,
    bodyDropped: false,
    dropReason: null,
    bodyBytes: Buffer.byteLength(body),
    contentType: "text/html",
    error: null,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function createRuntime(slug, mode) {
  const source = await loadModuleScript(slug);
  const calls = [];

  let bridges;
  if (mode === "fixtures") {
    // Minimal fixture wiring: load home/search + chapter if present.
    const home =
      (await readFile(path.join(root, "modules", slug, "fixtures", "home.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "search.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "search.json"), "utf8").catch(() => null));
    const chapter =
      (await readFile(path.join(root, "modules", slug, "fixtures", "chapter.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "images.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "images.json"), "utf8").catch(() => null));
    const details =
      (await readFile(path.join(root, "modules", slug, "fixtures", "details.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "details.json"), "utf8").catch(() => null));

    bridges = {
      fetchv2: async (url, headers, method, body, options) => {
        calls.push({ kind: "fetchv2", url: String(url) });
        const u = String(url);
        if (/chapter|images|at-home|pages|token/i.test(u) && chapter) return fixtureResponse(chapter);
        if (/details|manga\/|title\//i.test(u) && details) return fixtureResponse(details);
        if (!home) throw new Error(`No fixtures available for ${slug}`);
        return fixtureResponse(home);
      },
      pagev2: async (task) => {
        calls.push({ kind: "pagev2", url: String(task.url) });
        throw new Error("Fixture mode does not implement pagev2 for this module.");
      },
      reportProgress: async () => ({ ok: true }),
    };
  } else {
    bridges = {
      fetchv2: (url, headers, method, body, options) => {
        calls.push({ kind: "fetchv2", url: String(url) });
        return networkResponse(url, headers, method, body, options);
      },
      pagev2: async (task) => {
        calls.push({ kind: "pagev2", url: String(task && task.url) });
        const response = await networkResponse(task.url, task.headers || {}, "GET", null, {
          followRedirects: true,
          maxBytesHint: task.maxResponseCharacters || 1_000_000,
          timeoutMilliseconds: task.timeoutMilliseconds,
        });
        if (!response.ok || response.bodyDropped) {
          throw new Error(`pagev2 failed for ${task.url}`);
        }
        return {
          finalURL: response.finalUrl,
          title: "",
          html: task.includeHTML ? response.body : null,
          events: [],
          cookies: {},
          evaluatedData: response.body,
        };
      },
      reportProgress: async () => ({ ok: true }),
    };
  }

  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    ...bridges,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  assert.equal(typeof context.SynthetiqModule, "object", `${slug} must export SynthetiqModule`);
  return { module: context.SynthetiqModule, calls };
}

function pickTerminal(module) {
  if (typeof module.extractImages === "function") return "images";
  if (typeof module.extractText === "function") return "text";
  if (typeof module.extractResources === "function") return "resources";
  return null;
}

function summarizeItem(item) {
  if (!item || typeof item !== "object") return { ok: false, reason: "missing item" };
  const id = item.id || item.href || item.url;
  const title = item.title || item.name;
  if (!id || !title) return { ok: false, reason: "missing id/title" };
  return {
    ok: true,
    id: String(id).slice(0, 120),
    title: String(title).slice(0, 80),
    image: item.image ? String(item.image).slice(0, 120) : null,
  };
}

async function testModule(slug, mode) {
  const started = Date.now();
  const report = {
    module: slug,
    mode,
    passed: false,
    stages: {},
    error: null,
    durationMs: 0,
  };

  try {
    const { module, calls } = await createRuntime(slug, mode);
    report.stages.load = { ok: true, handlers: Object.keys(module) };

    // Stage 1: discovery / search (app home path)
    let page;
    if (typeof module.discoveryHome === "function") {
      const home = await module.discoveryHome();
      const sections = home && Array.isArray(home.sections) ? home.sections : [];
      const popular = sections.find((s) => /popular|trending/i.test(`${s.id || ""} ${s.title || ""}`)) || sections[0];
      page = {
        items: (popular && popular.items) || [],
        hasMore: false,
      };
      report.stages.discoveryHome = {
        ok: page.items.length > 0,
        sections: sections.map((s) => ({ id: s.id, title: s.title, count: (s.items || []).length })),
      };
    }
    if (!page || !page.items.length) {
      page = await module.searchResults(mode === "fixtures" ? "fixture" : query, 1);
      report.stages.searchResults = {
        ok: Array.isArray(page.items) && page.items.length > 0,
        count: Array.isArray(page.items) ? page.items.length : 0,
        hasMore: !!page.hasMore,
        sample: (page.items || []).slice(0, 3).map(summarizeItem),
      };
    } else {
      report.stages.searchResults = {
        ok: true,
        count: page.items.length,
        hasMore: !!page.hasMore,
        sample: page.items.slice(0, 3).map(summarizeItem),
        via: "discoveryHome",
      };
    }
    assert.ok(page.items && page.items.length > 0, "search/discovery returned no items");

    // Stage 2–4: try several catalogue items until a full read path succeeds.
    // Some MangaDex popular titles are restricted or external-only for EN.
    const candidates = page.items.slice(0, Math.max(itemLimit, 8));
    const detailsResults = [];
    const chapterAttempts = [];
    let details = null;
    let chapters = [];
    let terminalReport = null;
    let lastError = null;

    for (const item of candidates) {
      try {
        const d = await module.extractDetails(item.id || item.href || item.url);
        assert.ok(d && (d.title || d.name), "details missing title");
        detailsResults.push({ ok: true, id: item.id, title: d.title || d.name });

        let itemChapters = [];
        if (typeof module.extractChapters === "function") {
          itemChapters = await module.extractChapters(d.id || d.href || d.url || item.id);
          assert.ok(Array.isArray(itemChapters) && itemChapters.length > 0, "empty chapters");
          chapterAttempts.push({ ok: true, id: item.id, count: itemChapters.length });
        } else {
          chapterAttempts.push({ ok: true, id: item.id, skipped: true });
        }

        const terminal = pickTerminal(module);
        if (terminal === "images") {
          const chapter = itemChapters[0] || itemChapters[itemChapters.length - 1];
          const pages = await module.extractImages(chapter.id || chapter.href || chapter.url);
          assert.ok(Array.isArray(pages) && pages.length > 0, "no page images");
          const urls = pages.map((p) => (typeof p === "string" ? p : p && p.url)).filter(Boolean);
          assert.ok(urls.every((u) => String(u).startsWith("https://")), "non-HTTPS page image");
          terminalReport = {
            kind: "images",
            ok: true,
            count: pages.length,
            first: String(urls[0]).slice(0, 140),
            title: d.title || d.name,
          };
        } else if (terminal === "text") {
          const section = itemChapters[0];
          const text = await module.extractText(section.id || section.href || section.url);
          const content = typeof text === "string" ? text : text && (text.content || text.text || text.html);
          assert.ok(content && String(content).length > 0, "empty text");
          terminalReport = { kind: "text", ok: true, bytes: Buffer.byteLength(String(content)), title: d.title || d.name };
        } else if (terminal === "resources") {
          const resources = await module.extractResources(d.id || d.href || d.url);
          assert.ok(Array.isArray(resources) && resources.length > 0, "no publication resources");
          terminalReport = {
            kind: "resources",
            ok: true,
            count: resources.length,
            formats: resources.map((r) => r.format || r.type).filter(Boolean),
            title: d.title || d.name,
          };
        } else {
          throw new Error("Module has no terminal content handler");
        }

        details = d;
        chapters = itemChapters;
        break;
      } catch (error) {
        lastError = String(error.message || error);
        detailsResults.push({ ok: false, id: item.id, error: lastError });
        chapterAttempts.push({ ok: false, id: item.id, error: lastError });
      }
    }

    report.stages.extractDetails = {
      ok: detailsResults.some((r) => r.ok),
      tried: detailsResults.length,
      results: detailsResults,
    };
    report.stages.extractChapters = {
      ok: chapters.length > 0 || chapterAttempts.some((a) => a.skipped),
      count: chapters.length,
      attempts: chapterAttempts,
      sample: chapters.slice(0, 3).map((c) => ({
        id: String(c.id || c.href || "").slice(0, 120),
        title: c.title || c.name || null,
        number: c.number ?? null,
      })),
    };
    if (terminalReport) {
      report.stages[`extract${terminalReport.kind[0].toUpperCase()}${terminalReport.kind.slice(1)}`] = terminalReport;
    }
    assert.ok(details && terminalReport, lastError || "no full read path succeeded");

    report.stages.bridgeCalls = {
      fetchv2: calls.filter((c) => c.kind === "fetchv2").length,
      pagev2: calls.filter((c) => c.kind === "pagev2").length,
    };
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error && error.stack ? error.stack : error);
  }

  report.durationMs = Date.now() - started;
  return report;
}

const index = await loadIndex();
const allSlugs = index.modules.map((entry) => {
  // modules/<slug>/manifest.json
  const parts = String(entry.manifest.path).split("/");
  return parts[1];
});
const selected = positionals.length ? positionals : allSlugs;
const mode = useFixtures ? "fixtures" : "live";

const reports = [];
for (const slug of selected) {
  process.stderr.write(`Testing ${slug} (${mode})...\n`);
  // eslint-disable-next-line no-await-in-loop
  const report = await testModule(slug, mode);
  reports.push(report);
  process.stderr.write(
    `  ${report.passed ? "PASS" : "FAIL"} ${slug} in ${report.durationMs}ms`
      + (report.error ? ` — ${report.error.split("\n")[0]}` : "")
      + "\n",
  );
}

const summary = {
  mode,
  passed: reports.filter((r) => r.passed).length,
  failed: reports.filter((r) => !r.passed).length,
  total: reports.length,
  reports,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.failed === 0 ? 0 : 1);
