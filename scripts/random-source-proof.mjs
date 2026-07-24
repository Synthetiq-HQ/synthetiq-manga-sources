#!/usr/bin/env node
/**
 * Live random proof for flagship sources: WeebCentral, Atsu, MangaFire.
 * Picks up to 20 titles per source and opens 2 random chapters each.
 *
 *   node scripts/random-source-proof.mjs
 *   node scripts/random-source-proof.mjs --titles 10 --chapters 2
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const titlesWanted = Number(process.argv.includes("--titles")
  ? process.argv[process.argv.indexOf("--titles") + 1]
  : 20) || 20;
const chaptersWanted = Number(process.argv.includes("--chapters")
  ? process.argv[process.argv.indexOf("--chapters") + 1]
  : 2) || 2;

const MODULES = [
  { id: "weebcentral", file: "modules/weebcentral/index.js", name: "WeebCentral" },
  { id: "atsu", file: "modules/atsu/index.js", name: "Atsu" },
  { id: "mangafire", file: "modules/mangafire/index.js", name: "MangaFire" },
];

async function fetchv2(url, headers = {}, method = "GET", body = null, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 45000);
  try {
    const res = await fetch(url, {
      method,
      headers: headers || {},
      body: body || undefined,
      redirect: options.followRedirects === false ? "manual" : "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Minimal pagev2 stub for MangaFire — not a full browser; module may fail interactive path.
async function pagev2() {
  throw new Error("pagev2 not available in Node proof harness");
}

function loadModule(relativePath) {
  const code = readFileSync(path.join(root, relativePath), "utf8");
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    fetchv2,
    pagev2,
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.globalThis.fetchv2 = fetchv2;
  sandbox.globalThis.pagev2 = pagev2;
  sandbox.globalThis.URL = URL;
  sandbox.globalThis.URLSearchParams = URLSearchParams;
  sandbox.globalThis.setTimeout = setTimeout;
  sandbox.globalThis.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relativePath });
  const mod = sandbox.globalThis.SynthetiqModule || sandbox.SynthetiqModule;
  if (!mod?.searchResults || !mod?.extractChapters || !mod?.extractImages) {
    throw new Error(`Module missing handlers: ${relativePath}`);
  }
  return mod;
}

function pickRandom(array, n) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

async function proveModule(entry) {
  console.log(`\n═══ ${entry.name} (${entry.id}) ═══`);
  const mod = loadModule(entry.file);
  let search;
  try {
    search = await mod.searchResults("__feed:popular", 1);
  } catch (error) {
    // MangaFire popular may need pagev2 — try plain keyword
    try {
      search = await mod.searchResults("one", 1);
    } catch (error2) {
      return {
        source: entry.name,
        ok: false,
        error: String(error2?.message || error2),
        titles: 0,
        chaptersOk: 0,
        chaptersFail: 0,
        pagesOk: 0,
        pagesFail: 0,
      };
    }
  }

  const items = Array.isArray(search?.items) ? search.items : [];
  const sample = pickRandom(items, titlesWanted);
  console.log(`  search titles available: ${items.length}, sampling: ${sample.length}`);

  let chaptersOk = 0;
  let chaptersFail = 0;
  let pagesOk = 0;
  let pagesFail = 0;
  const failures = [];

  for (const title of sample) {
    const titleID = title.id || title.href || title.url;
    const titleName = String(title.title || titleID).slice(0, 48);
    let chapters = [];
    try {
      chapters = await mod.extractChapters(titleID);
      if (!Array.isArray(chapters) || chapters.length === 0) {
        chaptersFail += 1;
        failures.push(`${titleName}: no chapters`);
        continue;
      }
      chaptersOk += 1;
    } catch (error) {
      chaptersFail += 1;
      failures.push(`${titleName}: chapters ${error.message || error}`);
      continue;
    }

    const chapterSample = pickRandom(chapters, chaptersWanted);
    for (const chapter of chapterSample) {
      const chapterID = chapter.id || chapter.href || chapter.url;
      try {
        const pages = await mod.extractImages(chapterID);
        const count = Array.isArray(pages) ? pages.length : 0;
        if (count > 0) {
          pagesOk += 1;
          process.stdout.write(".");
        } else {
          pagesFail += 1;
          failures.push(`${titleName} / ${String(chapter.title || chapterID).slice(0, 30)}: 0 pages`);
          process.stdout.write("x");
        }
      } catch (error) {
        pagesFail += 1;
        failures.push(
          `${titleName} / ${String(chapter.title || chapterID).slice(0, 30)}: ${error.message || error}`,
        );
        process.stdout.write("x");
      }
    }
  }
  process.stdout.write("\n");

  const ok = pagesFail === 0 && chaptersFail === 0 && sample.length > 0;
  return {
    source: entry.name,
    ok,
    titles: sample.length,
    chaptersOk,
    chaptersFail,
    pagesOk,
    pagesFail,
    failures: failures.slice(0, 12),
  };
}

const results = [];
for (const entry of MODULES) {
  try {
    results.push(await proveModule(entry));
  } catch (error) {
    results.push({
      source: entry.name,
      ok: false,
      error: String(error?.message || error),
      titles: 0,
      chaptersOk: 0,
      chaptersFail: 0,
      pagesOk: 0,
      pagesFail: 0,
    });
  }
}

console.log("\n════════ SUMMARY ════════");
for (const row of results) {
  const status = row.ok ? "PASS" : "FAIL";
  console.log(
    `${status}  ${row.source}: titles=${row.titles} chapters_ok=${row.chaptersOk} chapters_fail=${row.chaptersFail} pages_ok=${row.pagesOk} pages_fail=${row.pagesFail}`,
  );
  if (row.error) console.log(`       error: ${row.error}`);
  if (row.failures?.length) {
    for (const f of row.failures) console.log(`       - ${f}`);
  }
}

const allPass = results.every((r) => r.ok);
process.exit(allPass ? 0 : 1);
