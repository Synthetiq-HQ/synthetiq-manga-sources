#!/usr/bin/env node
/**
 * Deep stress probe for Synthetiq modules (live network).
 * Per module: repeated cold walks (fresh vm context each time), long chapter
 * lists (One Piece where available), oldest+newest chapter image extraction.
 * Not part of npm test; manual diagnostics only.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const bridges = {
  fetchv2: (url, headers, method, body, options) => networkResponse(url, headers, method, body, options),
  pagev2: async (task) => {
    const response = await networkResponse(task.url, task.headers || {}, "GET", null, {
      followRedirects: true,
      maxBytesHint: task.maxResponseCharacters || 1_000_000,
      timeoutMilliseconds: task.timeoutMilliseconds,
    });
    if (!response.ok || response.bodyDropped) throw new Error(`pagev2 failed for ${task.url} (HTTP ${response.status})`);
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

async function load(slug) {
  const source = await readFile(path.join(root, "modules", slug, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, ...bridges });
  context.globalThis = context;
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  return context.SynthetiqModule;
}

function summarizeError(error) {
  return String((error && error.message) || error).slice(0, 160);
}

const queries = {
  weebcentral: "one piece",
  mangafire: "one piece",
  "internet-archive": "grimm",
  mangakatana: "one piece",
  mgread: "martial peak",
  "black-clover": "black clover",
  kagurabachi: "kagurabachi",
  "beginning-after-the-end": "beginning after the end",
  "solo-leveling": "solo leveling",
  haikyuu: "haikyuu",
};

const slug = process.argv[2];
const rounds = Number(process.argv[3]) || 3;
const targets = slug ? [slug] : Object.keys(queries);

const out = {};
for (const target of targets) {
  const log = { walks: [], longList: null, oldest: null, newest: null, chaptersCount: null };
  out[target] = log;
  // Repeated cold walks (fresh context = no warm state), like first app launch.
  for (let round = 1; round <= rounds; round += 1) {
    const started = Date.now();
    try {
      const mod = await load(target); // fresh vm each round: cold module state
      const search = await mod.searchResults(queries[target], 1);
      if (!search.items.length) throw new Error("search returned no items");
      const details = await mod.extractDetails(search.items[0].id || search.items[0].href || search.items[0].url);
      let chapters = [];
      if (typeof mod.extractChapters === "function") {
        chapters = await mod.extractChapters(details.id || details.href || details.url);
        if (!chapters.length) throw new Error("no chapters");
      }
      log.chaptersCount = chapters.length;
      if (typeof mod.extractImages === "function" && chapters.length) {
        const newest = chapters[0];
        const oldest = chapters[chapters.length - 1];
        const newestPages = await mod.extractImages(newest.id || newest.href || newest.url);
        const oldestPages = await mod.extractImages(oldest.id || oldest.href || oldest.url);
        log.newest = { id: String(newest.id).slice(0, 90), pages: newestPages.length, first: (typeof newestPages[0] === "string" ? newestPages[0] : newestPages[0]?.url || "").slice(0, 110) };
        log.oldest = { id: String(oldest.id).slice(0, 90), pages: oldestPages.length, first: (typeof oldestPages[0] === "string" ? oldestPages[0] : oldestPages[0]?.url || "").slice(0, 110) };
      }
      log.walks.push({ round, ok: true, ms: Date.now() - started });
    } catch (error) {
      log.walks.push({ round, ok: false, ms: Date.now() - started, error: summarizeError(error) });
    }
  }
}

console.log(JSON.stringify(out, null, 2));
