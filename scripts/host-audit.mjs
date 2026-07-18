#!/usr/bin/env node
/** Audit: sample chapters across each module's list; verify every image URL host is in the manifest allowlist. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function networkResponse(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method, headers, body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(Math.max(10_000, Number(options.timeoutMilliseconds) || 25_000)),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  const textBody = dropped ? "" : new TextDecoder().decode(bytes);
  return {
    status: response.status, ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    finalUrl: response.url, body: textBody, bodyDropped: dropped,
    dropReason: dropped ? "maxBytesHint" : null, bodyBytes: bytes.length,
    contentType: response.headers.get("content-type") || "", error: null,
    text: async () => textBody, json: async () => JSON.parse(textBody),
  };
}
const bridges = {
  fetchv2: (url, headers, method, body, options) => networkResponse(url, headers, method, body, options),
  pagev2: async (task) => {
    const response = await networkResponse(task.url, task.headers || {}, "GET", null, {
      followRedirects: true, maxBytesHint: task.maxResponseCharacters || 1_000_000,
      timeoutMilliseconds: task.timeoutMilliseconds,
    });
    if (!response.ok || response.bodyDropped) throw new Error(`pagev2 failed for ${task.url} (HTTP ${response.status})`);
    return { finalURL: response.finalUrl, title: "", html: task.includeHTML ? response.body : null, events: [], cookies: {}, evaluatedData: response.body };
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

function isAllowedHost(host, allowedHosts) {
  const normalized = String(host || "").toLowerCase();
  return (allowedHosts || []).some((entry) => {
    const allowed = String(entry || "").toLowerCase();
    if (allowed.startsWith("*.")) return normalized.endsWith(`.${allowed.slice(2)}`);
    return normalized === allowed;
  });
}

const queries = {
  weebcentral: "one piece",
  mangafire: "one piece",
  mangakatana: "one piece",
  mgread: "martial peak",
  "black-clover": "black clover",
  kagurabachi: "kagurabachi",
  "beginning-after-the-end": "the beginning after the end",
  "solo-leveling": "solo leveling",
  haikyuu: "haikyuu",
};

const report = {};
for (const [slug, query] of Object.entries(queries)) {
  const entry = { hosts: new Set(), violations: [], sampled: [] };
  report[slug] = entry;
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "modules", slug, "manifest.json"), "utf8"));
    const mod = await load(slug);
    const search = await mod.searchResults(query, 1);
    const details = await mod.extractDetails(search.items[0].id || search.items[0].href || search.items[0].url);
    const chapters = await mod.extractChapters(details.id || details.href || details.url);
    const picks = [...new Set([0, 1, Math.floor(chapters.length / 2), chapters.length - 2, chapters.length - 1])]
      .filter((i) => i >= 0 && i < chapters.length);
    for (const i of picks) {
      const chapter = chapters[i];
      try {
        const pages = await mod.extractImages(chapter.id || chapter.href || chapter.url);
        const hosts = new Set();
        for (const page of pages) {
          const url = typeof page === "string" ? page : page && page.url;
          if (!url) continue;
          const host = new URL(url).hostname;
          hosts.add(host);
          entry.hosts.add(host);
          if (!isAllowedHost(host, manifest.allowedHosts)) {
            entry.violations.push({ chapter: String(chapter.id).slice(0, 90), host });
          }
        }
        entry.sampled.push({ chapter: String(chapter.id).slice(-40), pages: pages.length, hosts: [...hosts] });
      } catch (error) {
        entry.sampled.push({ chapter: String(chapter.id).slice(-40), error: String(error.message || error).slice(0, 120) });
      }
    }
  } catch (error) {
    entry.error = String(error.message || error).slice(0, 160);
  }
}
for (const [slug, entry] of Object.entries(report)) {
  console.log(`\n=== ${slug} ===`);
  if (entry.error) console.log("  ERROR:", entry.error);
  console.log("  hosts:", [...entry.hosts].join(", ") || "(none)");
  for (const s of entry.sampled) console.log("  sample:", JSON.stringify(s));
  console.log(entry.violations.length ? `  VIOLATIONS: ${JSON.stringify(entry.violations)}` : "  allowlist: OK");
}
