#!/usr/bin/env node
/**
 * Bounded live proof for the MangaBuddy (Comizy) module.
 *
 * This is deliberately opt-in and checks five catalogue titles. It resolves
 * each title through the module, samples the newest/middle/oldest chapters,
 * validates every returned page URL, and downloads only the first image from
 * each sampled chapter.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1" && !process.argv.includes("--live")) {
  throw new Error("Set RUN_LIVE_TESTS=1 or pass --live to run the MangaBuddy live proof.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "modules", "mangabuddy", "index.js");
const manifest = JSON.parse(await readFile(path.join(root, "modules", "mangabuddy", "manifest.json"), "utf8"));
const requestHeaders = {
  Accept: "application/json,text/plain,*/*",
  Referer: "https://comizy.io/",
};

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function allowedHost(host) {
  const normalized = String(host || "").toLowerCase();
  return manifest.allowedHosts.some((entry) => {
    const allowed = String(entry).toLowerCase();
    return allowed.startsWith("*.")
      ? normalized.endsWith(`.${allowed.slice(2)}`)
      : normalized === allowed;
  });
}

async function responseFor(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(Math.max(10_000, Number(options.timeoutMilliseconds) || 30_000)),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  const bodyText = dropped ? "" : new TextDecoder().decode(bytes);
  return {
    status: response.status,
    ok: response.ok,
    body: bodyText,
    bodyDropped: dropped,
    dropReason: dropped ? "maxBytesHint" : null,
    contentType: response.headers.get("content-type") || "",
    text: async () => bodyText,
  };
}

async function loadModule() {
  const source = await readFile(modulePath, "utf8");
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    fetchv2: responseFor,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: modulePath }).runInContext(context);
  return context.SynthetiqModule;
}

function chooseItem(items, query) {
  const normalized = String(query).toLowerCase();
  return items.find((item) => String(item.title || "").toLowerCase() === normalized)
    || items.find((item) => String(item.title || "").toLowerCase().includes(normalized))
    || items[0];
}

function sampleChapters(chapters) {
  return [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])]
    .map((index) => chapters[index])
    .filter(Boolean);
}

const module = await loadModule();
const discovery = await module.discoveryHome();
assert.ok(discovery.sections.some((section) => section.items.length > 0), "discovery returned no usable items");

const queries = ["chainsaw", "one piece", "naruto", "jujutsu kaisen", "solo leveling"];
const report = [];

for (const query of queries) {
  const search = await module.searchResults(query, 1);
  assert.ok(search.items.length > 0, `search returned no usable items for ${query}`);
  const item = chooseItem(search.items, query);
  assert.ok(item && item.id, `search did not resolve a title for ${query}`);
  const details = await module.extractDetails(item.id);
  assert.ok(details.title && details.image, `details missing title or cover for ${query}`);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length > 0, `no chapters for ${details.title}`);
  for (let index = 1; index < chapters.length; index += 1) {
    if (chapters[index - 1].number != null && chapters[index].number != null) {
      assert.ok(chapters[index - 1].number >= chapters[index].number, `${details.title} chapters are not descending`);
    }
  }

  const chapterProofs = [];
  for (const chapter of sampleChapters(chapters)) {
    const pages = await module.extractImages(chapter.id);
    assert.ok(pages.length > 0, `${details.title} ${chapter.title} returned no pages`);
    for (const page of pages) {
      const url = new URL(typeof page === "string" ? page : page.url);
      assert.equal(url.protocol, "https:", "page image is not HTTPS");
      assert.ok(allowedHost(url.hostname), `page image host is not allowlisted: ${url.hostname}`);
    }
    const first = typeof pages[0] === "string" ? pages[0] : pages[0].url;
    const image = await fetch(first, {
      headers: { ...requestHeaders, ...((pages[0] && pages[0].headers) || {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = await image.arrayBuffer();
    assert.equal(image.status, 200, `${details.title} ${chapter.title} first page was not HTTP 200`);
    assert.match(image.headers.get("content-type") || "", /^image\//i, `${details.title} first page was not an image`);
    assert.ok(bytes.byteLength > 0, `${details.title} ${chapter.title} first page was empty`);
    chapterProofs.push({ title: chapter.title, number: chapter.number ?? null, pageCount: pages.length, firstImageStatus: image.status });
    await pause(300);
  }

  report.push({ title: details.title, itemID: item.id, chapterCount: chapters.length, sampledChapters: chapterProofs });
  await pause(500);
}

console.log(JSON.stringify({
  module: "mangabuddy",
  discoverySections: discovery.sections.map((section) => ({ id: section.id, count: section.items.length })),
  titleCount: report.length,
  report,
}, null, 2));
