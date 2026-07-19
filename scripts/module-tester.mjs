#!/usr/bin/env node
/**
 * App-shaped live probe (Node vm) — NOT a full iOS one-to-one harness.
 *
 * Exercises module script handlers the way the app's ModuleSourceReader path
 * roughly does:
 *   load → discoveryHome / searchResults → extractDetails → extractChapters →
 *   extractImages | extractText | extractResources
 *
 * Does NOT cover: module install/activate, WebKit pagev2 fidelity, library,
 * offline downloads, image policy, or UI. Prefer EngineTests on device for those.
 *
 * Usage:
 *   node scripts/module-tester.mjs                 # all modules in index.json (live)
 *   node scripts/module-tester.mjs mangadex        # one module
 *   node scripts/module-tester.mjs --fixtures      # fixture-only path (no network)
 *   node scripts/module-tester.mjs --limit 2
 *   node scripts/module-tester.mjs --report        # write reports/module-test-latest.{json,html}
 *   node scripts/module-tester.mjs --report --out reports/custom
 *   node scripts/module-tester.mjs mangadex --query "solo" --limit 3
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set();
const positionals = [];
let query = "a";
let itemLimit = 3;
let reportOutBase = path.join(root, "reports", "module-test-latest");

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--fixtures") {
    flags.add("--fixtures");
    continue;
  }
  if (arg === "--report") {
    flags.add("--report");
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
  if (arg === "--out") {
    reportOutBase = path.resolve(root, args[i + 1] || reportOutBase);
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
const writeReport = flags.has("--report") || flags.has("--html") || flags.has("--json");

function parseJSON(text) {
  return JSON.parse(text);
}

async function loadIndex() {
  return parseJSON(await readFile(path.join(root, "index.json"), "utf8"));
}

async function loadModuleScript(slug) {
  return readFile(path.join(root, "modules", slug, "index.js"), "utf8");
}

async function loadManifest(slug) {
  try {
    return parseJSON(await readFile(path.join(root, "modules", slug, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

async function networkResponse(url, headers = {}, method = "GET", body = null, options = {}) {
  const started = Date.now();
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
    bodyMagicHex: Buffer.from(bytes.slice(0, 16)).toString("hex"),
    contentType: response.headers.get("content-type") || "",
    error: null,
    durationMs: Date.now() - started,
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  };
}

function isAllowedHost(host, allowedHosts) {
  const normalized = String(host || "").toLowerCase();
  return (allowedHosts || []).some((entry) => {
    const allowed = String(entry || "").toLowerCase();
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(2);
      return normalized.endsWith(`.${suffix}`);
    }
    return normalized === allowed;
  });
}

function looksLikeImage(response) {
  const contentType = String(response.contentType || "").toLowerCase();
  if (contentType.startsWith("image/")) return true;

  const magic = String(response.bodyMagicHex || "");
  if (magic.slice(8, 16) === "66747970") return true; // ISO BMFF (AVIF/HEIF)
  return [
    "89504e470d0a1a0a", // PNG
    "ffd8ff", // JPEG
    "47494638", // GIF
    "52494646", // RIFF/WebP (the WebP marker follows at byte 8)
  ].some((prefix) => magic.startsWith(prefix));
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
    durationMs: 0,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function createRuntime(slug, mode) {
  const source = await loadModuleScript(slug);
  const calls = [];
  const lifecycle = [];

  let bridges;
  if (mode === "fixtures") {
    const home =
      (await readFile(path.join(root, "modules", slug, "fixtures", "home.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "search.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "search.json"), "utf8").catch(() => null));
    const chapter =
      (await readFile(path.join(root, "modules", slug, "fixtures", "chapter.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "images.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "images.json"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "pages.json"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "chapter.json"), "utf8").catch(() => null));
    const details =
      (await readFile(path.join(root, "modules", slug, "fixtures", "details.html"), "utf8").catch(() => null))
      || (await readFile(path.join(root, "modules", slug, "fixtures", "details.json"), "utf8").catch(() => null));
    const sourceInfo = await readFile(path.join(root, "modules", slug, "fixtures", "chapters.json"), "utf8").catch(() => null);
    const sourcePages = await readFile(path.join(root, "modules", slug, "fixtures", "pages.json"), "utf8").catch(() => null);

    bridges = {
      fetchv2: async (url, headers, method, body, options) => {
        calls.push({ kind: "fetchv2", url: String(url) });
        const u = String(url);
        if (slug === "atsu") {
          if (/\/api\/read\/chapter/i.test(u) && sourcePages) return fixtureResponse(sourcePages);
          if (/\/api\/manga\/info/i.test(u) && sourceInfo) return fixtureResponse(sourceInfo);
          if (/\/collections\/manga\/documents\/search/i.test(u) && home) return fixtureResponse(home);
          if (/\/manga\//i.test(u) && details) return fixtureResponse(details);
          if (home) return fixtureResponse(home);
        }
        if (/chapter|images|at-home|pages|token/i.test(u) && chapter) return fixtureResponse(chapter);
        if (/details|manga\/|title\//i.test(u) && details) return fixtureResponse(details);
        if (!home) throw new Error(`No fixtures available for ${slug}`);
        return fixtureResponse(home);
      },
      pagev2: async (task) => {
        calls.push({ kind: "pagev2", url: String(task.url) });
        throw new Error("Fixture mode does not implement pagev2 for this module.");
      },
      reportProgress: async (payload) => {
        lifecycle.push({ at: Date.now(), kind: "reportProgress", payload: payload ?? null });
        return { ok: true };
      },
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
      reportProgress: async (payload) => {
        lifecycle.push({ at: Date.now(), kind: "reportProgress", payload: payload ?? null });
        return { ok: true };
      },
    };
  }

  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    ...bridges,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  assert.equal(typeof context.SynthetiqModule, "object", `${slug} must export SynthetiqModule`);
  return { module: context.SynthetiqModule, calls, lifecycle };
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

async function timed(fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, durationMs: Date.now() - started, error: null };
  } catch (error) {
    return {
      ok: false,
      value: null,
      durationMs: Date.now() - started,
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function testModule(slug, mode, indexEntry) {
  const started = Date.now();
  const manifest = await loadManifest(slug);
  const report = {
    module: slug,
    moduleID: indexEntry?.id || manifest?.id || slug,
    name: indexEntry?.name || manifest?.name || slug,
    version: indexEntry?.version || manifest?.version || null,
    contentType: indexEntry?.contentType || manifest?.contentType || null,
    releaseTrack: indexEntry?.releaseTrack || manifest?.releaseTrack || null,
    mode,
    passed: false,
    stages: {},
    timingsMs: {},
    lifecycle: [],
    error: null,
    durationMs: 0,
  };

  try {
    const loadResult = await timed(() => createRuntime(slug, mode));
    report.timingsMs.load = loadResult.durationMs;
    if (!loadResult.ok) throw new Error(loadResult.error);
    const { module, calls, lifecycle } = loadResult.value;
    report.lifecycle = lifecycle;
    report.stages.load = {
      ok: true,
      durationMs: loadResult.durationMs,
      handlers: Object.keys(module),
      terminal: pickTerminal(module),
    };

    // Stage 1: discovery / search
    let page;
    if (typeof module.discoveryHome === "function") {
      const homeResult = await timed(() => module.discoveryHome());
      report.timingsMs.discoveryHome = homeResult.durationMs;
      if (homeResult.ok) {
        const home = homeResult.value;
        const sections = home && Array.isArray(home.sections) ? home.sections : [];
        const popular =
          sections.find((s) => /popular|trending/i.test(`${s.id || ""} ${s.title || ""}`)) || sections[0];
        page = {
          items: (popular && popular.items) || [],
          hasMore: false,
        };
        report.stages.discoveryHome = {
          ok: page.items.length > 0,
          durationMs: homeResult.durationMs,
          sections: sections.map((s) => ({ id: s.id, title: s.title, count: (s.items || []).length })),
        };
      } else {
        report.stages.discoveryHome = {
          ok: false,
          durationMs: homeResult.durationMs,
          error: homeResult.error,
        };
      }
    }

    if (!page || !page.items.length) {
      const searchResult = await timed(() => module.searchResults(mode === "fixtures" ? "fixture" : query, 1));
      report.timingsMs.searchResults = searchResult.durationMs;
      if (!searchResult.ok) throw new Error(searchResult.error);
      page = searchResult.value;
      report.stages.searchResults = {
        ok: Array.isArray(page.items) && page.items.length > 0,
        durationMs: searchResult.durationMs,
        count: Array.isArray(page.items) ? page.items.length : 0,
        hasMore: !!page.hasMore,
        sample: (page.items || []).slice(0, 3).map(summarizeItem),
      };
    } else {
      report.stages.searchResults = {
        ok: true,
        durationMs: 0,
        count: page.items.length,
        hasMore: !!page.hasMore,
        sample: page.items.slice(0, 3).map(summarizeItem),
        via: "discoveryHome",
      };
      report.timingsMs.searchResults = 0;
    }
    assert.ok(page.items && page.items.length > 0, "search/discovery returned no items");

    const candidates = page.items.slice(0, Math.max(itemLimit, 8));
    const detailsResults = [];
    const chapterAttempts = [];
    let details = null;
    let chapters = [];
    let terminalReport = null;
    let lastError = null;
    let detailsMs = 0;
    let chaptersMs = 0;
    let terminalMs = 0;

    for (const item of candidates) {
      try {
        const dResult = await timed(() => module.extractDetails(item.id || item.href || item.url));
        detailsMs += dResult.durationMs;
        if (!dResult.ok) throw new Error(dResult.error);
        const d = dResult.value;
        assert.ok(d && (d.title || d.name), "details missing title");
        detailsResults.push({ ok: true, id: item.id, title: d.title || d.name, durationMs: dResult.durationMs });

        let itemChapters = [];
        if (typeof module.extractChapters === "function") {
          const cResult = await timed(() => module.extractChapters(d.id || d.href || d.url || item.id));
          chaptersMs += cResult.durationMs;
          if (!cResult.ok) throw new Error(cResult.error);
          itemChapters = cResult.value;
          assert.ok(Array.isArray(itemChapters) && itemChapters.length > 0, "empty chapters");
          chapterAttempts.push({ ok: true, id: item.id, count: itemChapters.length, durationMs: cResult.durationMs });
        } else {
          chapterAttempts.push({ ok: true, id: item.id, skipped: true });
        }

        const terminal = pickTerminal(module);
        if (terminal === "images") {
          const chapter = itemChapters[0] || itemChapters[itemChapters.length - 1];
          const pResult = await timed(() => module.extractImages(chapter.id || chapter.href || chapter.url));
          terminalMs += pResult.durationMs;
          if (!pResult.ok) throw new Error(pResult.error);
          const pages = pResult.value;
          assert.ok(Array.isArray(pages) && pages.length > 0, "no page images");
          const urls = pages.map((p) => (typeof p === "string" ? p : p && p.url)).filter(Boolean);
          assert.ok(urls.every((u) => String(u).startsWith("https://")), "non-HTTPS page image");

          let deliveries = [];
          if (mode === "live") {
            // A single cover-like first page can hide broken later page URLs.
            // Sample the first, middle, and final page while keeping the live
            // suite bounded enough to run for every module on each change.
            const sampleIndexes = [...new Set([0, Math.floor((pages.length - 1) / 2), pages.length - 1])];
            deliveries = await Promise.all(sampleIndexes.map(async (index) => {
              const page = pages[index];
              const url = typeof page === "string" ? page : page.url;
              const headers = typeof page === "string" ? {} : (page.headers || {});
              const parsedURL = new URL(url);
              assert.ok(
                isAllowedHost(parsedURL.hostname, manifest.allowedHosts),
                `image host is not declared by manifest: ${parsedURL.hostname}`
              );

              const imageResult = await timed(() => networkResponse(
                url,
                headers,
                "GET",
                null,
                { timeoutMilliseconds: manifest.limits?.timeoutMilliseconds, maxBytesHint: manifest.limits?.maxResponseBytes }
              ));
              if (!imageResult.ok) throw new Error(imageResult.error);
              const image = imageResult.value;
              assert.ok(image.ok, `page ${index + 1} returned HTTP ${image.status}`);
              assert.ok(image.bodyBytes > 0, `page ${index + 1} response was empty`);
              assert.ok(looksLikeImage(image), `page ${index + 1} did not look like an image (${image.contentType || "unknown content type"})`);
              return {
                ok: true,
                page: index + 1,
                durationMs: imageResult.durationMs,
                status: image.status,
                contentType: image.contentType || null,
                bytes: image.bodyBytes,
                host: parsedURL.hostname,
              };
            }));
          }

          terminalReport = {
            kind: "images",
            ok: true,
            durationMs: pResult.durationMs,
            count: pages.length,
            first: String(urls[0]).slice(0, 140),
            title: d.title || d.name,
            deliveries,
          };
        } else if (terminal === "text") {
          const section = itemChapters[0];
          const tResult = await timed(() => module.extractText(section.id || section.href || section.url));
          terminalMs += tResult.durationMs;
          if (!tResult.ok) throw new Error(tResult.error);
          const text = tResult.value;
          const content = typeof text === "string" ? text : text && (text.content || text.text || text.html);
          assert.ok(content && String(content).length > 0, "empty text");
          terminalReport = {
            kind: "text",
            ok: true,
            durationMs: tResult.durationMs,
            bytes: Buffer.byteLength(String(content)),
            title: d.title || d.name,
          };
        } else if (terminal === "resources") {
          const rResult = await timed(() => module.extractResources(d.id || d.href || d.url));
          terminalMs += rResult.durationMs;
          if (!rResult.ok) throw new Error(rResult.error);
          const resources = rResult.value;
          assert.ok(Array.isArray(resources) && resources.length > 0, "no publication resources");
          terminalReport = {
            kind: "resources",
            ok: true,
            durationMs: rResult.durationMs,
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

    report.timingsMs.extractDetails = detailsMs;
    report.timingsMs.extractChapters = chaptersMs;
    report.timingsMs.terminal = terminalMs;

    report.stages.extractDetails = {
      ok: detailsResults.some((r) => r.ok),
      durationMs: detailsMs,
      tried: detailsResults.length,
      results: detailsResults,
    };
    report.stages.extractChapters = {
      ok: chapters.length > 0 || chapterAttempts.some((a) => a.skipped),
      durationMs: chaptersMs,
      count: chapters.length,
      attempts: chapterAttempts,
      sample: chapters.slice(0, 3).map((c) => ({
        id: String(c.id || c.href || "").slice(0, 120),
        title: c.title || c.name || null,
        number: c.number ?? null,
      })),
    };
    if (terminalReport) {
      const stageName = `extract${terminalReport.kind[0].toUpperCase()}${terminalReport.kind.slice(1)}`;
      report.stages[stageName] = terminalReport;
    }
    assert.ok(details && terminalReport, lastError || "no full read path succeeded");

    report.stages.bridgeCalls = {
      fetchv2: calls.filter((c) => c.kind === "fetchv2").length,
      pagev2: calls.filter((c) => c.kind === "pagev2").length,
    };
    report.stages.lifecycle = {
      ok: true,
      progressEvents: lifecycle.filter((e) => e.kind === "reportProgress").length,
      notes: lifecycle.length
        ? `Module emitted ${lifecycle.length} progress event(s) via reportProgress.`
        : "No reportProgress lifecycle events during this run.",
    };
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error && error.stack ? error.stack : error);
  }

  report.durationMs = Date.now() - started;
  report.timingsMs.total = report.durationMs;
  return report;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stageStatus(stage) {
  if (!stage) return "skip";
  return stage.ok ? "pass" : "fail";
}

function renderHTML(summary) {
  const rows = summary.reports
    .map((r) => {
      const stages = [
        "load",
        "discoveryHome",
        "searchResults",
        "extractDetails",
        "extractChapters",
        "extractImages",
        "extractText",
        "extractResources",
      ];
      const stageCells = stages
        .map((name) => {
          const st = r.stages[name];
          if (!st) return `<td class="skip">—</td>`;
          const label = st.ok ? "OK" : "FAIL";
          const ms = st.durationMs != null ? ` ${st.durationMs}ms` : "";
          return `<td class="${st.ok ? "pass" : "fail"}">${label}${ms}</td>`;
        })
        .join("");
      return `<tr class="${r.passed ? "pass-row" : "fail-row"}">
        <td><strong>${escapeHtml(r.name || r.module)}</strong><br><code>${escapeHtml(r.module)}</code></td>
        <td>${escapeHtml(r.version || "")}</td>
        <td>${escapeHtml(r.contentType || "")}</td>
        <td>${escapeHtml(r.releaseTrack || "")}</td>
        <td class="${r.passed ? "pass" : "fail"}">${r.passed ? "PASS" : "FAIL"}</td>
        <td>${r.durationMs}ms</td>
        ${stageCells}
        <td class="error">${escapeHtml(r.error ? r.error.split("\n")[0] : "")}</td>
      </tr>`;
    })
    .join("\n");

  const timingBars = summary.reports
    .map((r) => {
      const total = Math.max(1, r.durationMs || 1);
      const parts = Object.entries(r.timingsMs || {})
        .filter(([k]) => k !== "total")
        .map(([k, v]) => {
          const pct = Math.max(2, Math.round((Number(v) / total) * 100));
          return `<div class="bar-seg" style="width:${pct}%" title="${escapeHtml(k)}: ${v}ms">${escapeHtml(k)}</div>`;
        })
        .join("");
      return `<div class="timing-row"><div class="timing-label">${escapeHtml(r.module)}</div><div class="bar">${parts}</div><div class="timing-ms">${r.durationMs}ms</div></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Synthetiq Module Probe Report (app-shaped, Node vm)</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --card:#151a22; --text:#e8eef7; --muted:#9aa7b8; --pass:#3dd68c; --fail:#ff6b6b; --skip:#6b7280; --accent:#6ea8fe; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:28px 32px; border-bottom:1px solid #243041; background:linear-gradient(180deg,#121826,#0b0d12); }
  h1 { margin:0 0 8px; font-size:28px; }
  .meta { color:var(--muted); font-size:14px; }
  .stats { display:flex; gap:16px; margin-top:16px; flex-wrap:wrap; }
  .stat { background:var(--card); border:1px solid #243041; border-radius:12px; padding:12px 16px; min-width:120px; }
  .stat strong { display:block; font-size:22px; }
  main { padding:24px 32px 48px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; }
  th, td { padding:10px 12px; border-bottom:1px solid #243041; text-align:left; font-size:13px; vertical-align:top; }
  th { background:#1b2330; color:var(--muted); font-weight:600; }
  .pass { color:var(--pass); font-weight:700; }
  .fail { color:var(--fail); font-weight:700; }
  .skip { color:var(--skip); }
  .error { color:#f5a97f; max-width:280px; word-break:break-word; }
  code { font-size:12px; color:var(--accent); }
  h2 { margin-top:32px; }
  .timing-row { display:grid; grid-template-columns:160px 1fr 80px; gap:10px; align-items:center; margin:8px 0; }
  .bar { display:flex; height:22px; background:#1b2330; border-radius:6px; overflow:hidden; }
  .bar-seg { background:linear-gradient(90deg,#3b82f6,#22c55e); color:#041018; font-size:10px; display:flex; align-items:center; justify-content:center; overflow:hidden; white-space:nowrap; }
  .timing-ms { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .lifecycle { background:var(--card); border:1px solid #243041; border-radius:12px; padding:16px; margin-top:12px; color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>Synthetiq Module Probe Report</h1>
  <div class="meta">App-shaped Node vm probe — not a full iOS install/WebKit/library harness.</div>
  <div class="meta">Mode: <strong>${escapeHtml(summary.mode)}</strong> · Generated: ${escapeHtml(summary.generatedAt)} · Query: ${escapeHtml(summary.query)} · Item limit: ${summary.itemLimit}</div>
  <div class="stats">
    <div class="stat"><strong class="pass">${summary.passed}</strong>Passed</div>
    <div class="stat"><strong class="fail">${summary.failed}</strong>Failed</div>
    <div class="stat"><strong>${summary.total}</strong>Total</div>
    <div class="stat"><strong>${summary.totalDurationMs}ms</strong>Wall time</div>
  </div>
</header>
<main>
  <h2>Modules</h2>
  <table>
    <thead>
      <tr>
        <th>Module</th><th>Ver</th><th>Type</th><th>Track</th><th>Result</th><th>Total</th>
        <th>Load</th><th>Home</th><th>Search</th><th>Details</th><th>Chapters</th><th>Images</th><th>Text</th><th>Resources</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <h2>Stage timings</h2>
  ${timingBars}

  <h2>Lifecycle notes</h2>
  <div class="lifecycle">
    ${summary.reports
      .map((r) => {
        const note = r.stages?.lifecycle?.notes || "—";
        return `<div><strong>${escapeHtml(r.module)}</strong>: ${escapeHtml(note)}</div>`;
      })
      .join("")}
  </div>

  <h2>How to re-run</h2>
  <div class="lifecycle">
    <code>npm run test:module:report</code> · fixtures: <code>npm run test:module:report:fixtures</code> · subset: <code>npm run test:module -- mangadex --report</code>
  </div>
</main>
</body>
</html>`;
}

const index = await loadIndex();
const indexBySlug = new Map(
  index.modules.map((entry) => {
    const parts = String(entry.manifest.path).split("/");
    return [parts[1], entry];
  }),
);
const allSlugs = [...indexBySlug.keys()];
const selected = positionals.length ? positionals : allSlugs;
const mode = useFixtures ? "fixtures" : "live";
const wallStarted = Date.now();

const reports = [];
for (const slug of selected) {
  process.stderr.write(`Testing ${slug} (${mode})...\n`);
  // eslint-disable-next-line no-await-in-loop
  const report = await testModule(slug, mode, indexBySlug.get(slug));
  reports.push(report);
  process.stderr.write(
    `  ${report.passed ? "PASS" : "FAIL"} ${slug} in ${report.durationMs}ms`
      + (report.error ? ` — ${report.error.split("\n")[0]}` : "")
      + "\n",
  );
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode,
  query,
  itemLimit,
  passed: reports.filter((r) => r.passed).length,
  failed: reports.filter((r) => !r.passed).length,
  total: reports.length,
  totalDurationMs: Date.now() - wallStarted,
  reports,
};

if (writeReport) {
  const jsonPath = reportOutBase.endsWith(".json") ? reportOutBase : `${reportOutBase}.json`;
  const htmlPath = reportOutBase.endsWith(".json")
    ? reportOutBase.replace(/\.json$/i, ".html")
    : `${reportOutBase}.html`;
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(htmlPath, renderHTML(summary), "utf8");
  process.stderr.write(`Wrote ${jsonPath}\nWrote ${htmlPath}\n`);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.failed === 0 ? 0 : 1);
