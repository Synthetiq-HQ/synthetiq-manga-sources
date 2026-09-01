#!/usr/bin/env node
/**
 * Bounded live quality proof for the MangaXo module.
 *
 * Uses ordinary public HTTPS requests only. It resolves representative titles,
 * samples five evenly spaced chapters per title, validates every returned page
 * URL, and downloads only the first, middle, and last image of each sampled
 * chapter.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1" && !process.argv.includes("--live")) {
  throw new Error("Set RUN_LIVE_TESTS=1 or pass --live to run the MangaXo live proof.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "modules", "mangaxo", "index.js");
const manifest = JSON.parse(await readFile(path.join(root, "modules", "mangaxo", "manifest.json"), "utf8"));
const titleCases = [
  { query: "chainsaw man", expected: "Chainsaw Man" },
  { query: "one piece", expected: "One Piece" },
  { query: "blue lock", expected: "Blue Lock" },
  { query: "fullmetal alchemist", expected: "Fullmetal Alchemist" },
  { query: "god of martial arts", expected: "God of Martial Arts" },
  { query: "the beginning after the end", expected: "The Beginning After The End" },
];

const requestedLimit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1]);
const cases = titleCases.slice(0, Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : titleCases.length);
const withDiscovery = process.argv.includes("--with-discovery");
const QA_TIMEOUT_MS = 15_000;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function allowedHost(host) {
  const normalized = String(host || "").toLowerCase();
  return manifest.allowedHosts.some((entry) => {
    const allowed = String(entry).toLowerCase();
    return allowed.startsWith("*.")
      ? normalized.endsWith("." + allowed.slice(2))
      : normalized === allowed;
  });
}

function pageURL(value) {
  const url = new URL(typeof value === "string" ? value : value?.url);
  if (url.protocol !== "https:") throw new Error("non-HTTPS page URL: " + url.href);
  if (!allowedHost(url.hostname)) throw new Error("page host is not allowlisted: " + url.hostname);
  if (!/^\/wp-content\/uploads\/WP-manga\/data\/manga_[a-z0-9]+\/[a-z0-9]+\/[a-z0-9][a-z0-9_.-]*\.(?:jpe?g|png|webp)$/i.test(url.pathname)) {
    throw new Error("page path is not a MangaXo image: " + url.pathname);
  }
  return url;
}

async function responseFor(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(Math.max(10_000, Math.min(QA_TIMEOUT_MS, Number(options.timeoutMilliseconds) || QA_TIMEOUT_MS))),
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

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function chooseItem(items, expected) {
  const wanted = normalized(expected);
  return items.find((item) => normalized(item.title) === wanted)
    || items.find((item) => normalized(item.title).includes(wanted))
    || null;
}

function sampleChapters(chapters) {
  const indexes = [0, 0.25, 0.5, 0.75, 0.999]
    .map((fraction) => Math.floor((chapters.length - 1) * fraction));
  const seen = new Set();
  return indexes.map((index) => chapters[index])
    .filter((chapter) => chapter && !seen.has(chapter.id) && seen.add(chapter.id));
}

function samplePages(pages) {
  const indexes = [0, Math.floor((pages.length - 1) / 2), pages.length - 1];
  const seen = new Set();
  return indexes.map((index) => pages[index])
    .filter((page) => page && !seen.has(page.url) && seen.add(page.url));
}

async function fetchImage(page, chapterTitle) {
  const url = pageURL(page);
  const started = Date.now();
  const response = await fetch(url, {
    headers: page.headers || {},
    signal: AbortSignal.timeout(QA_TIMEOUT_MS),
  });
  const bytes = await response.arrayBuffer();
  const elapsedMs = Date.now() - started;
  if (response.status !== 200) throw new Error(chapterTitle + " image HTTP " + response.status);
  if (!/^image\//i.test(response.headers.get("content-type") || "")) {
    throw new Error(chapterTitle + " image returned " + (response.headers.get("content-type") || "no content type"));
  }
  if (!bytes.byteLength) throw new Error(chapterTitle + " image was empty");
  return { status: response.status, bytes: bytes.byteLength, elapsedMs, url: url.href };
}

const module = await loadModule();
const checks = [];
function record(name, passed, detail = "") {
  checks.push({ name, passed: Boolean(passed), detail });
}

const started = Date.now();
let discovery = { sections: [] };
if (withDiscovery) {
  try {
    discovery = await module.discoveryHome();
    record(
      "discovery",
      Array.isArray(discovery.sections)
        && discovery.sections.length >= 1
        && discovery.sections.every((section) => Array.isArray(section.items) && section.items.length > 0),
      discovery.sections?.map((section) => section.id + ":" + section.items.length).join(", ") || "no sections",
    );
  } catch (error) {
    record("discovery", false, error instanceof Error ? error.message : String(error));
  }
} else {
  record("discovery", true, "covered by fixture discovery test; live feed check omitted");
}

try {
  const firstPage = await module.searchResults("chainsaw man", 1);
  const secondPage = await module.searchResults("chainsaw man", 2);
  const firstIDs = new Set(firstPage.items.map((item) => String(item.id || item.href || item.url)));
  const disjoint = secondPage.items.every((item) => !firstIDs.has(String(item.id || item.href || item.url)));
  record("search-pagination", firstPage.hasMore && secondPage.items.length > 0 && disjoint, firstPage.items.length + "+" + secondPage.items.length + " unique search items");
} catch (error) {
  record("search-pagination", false, error instanceof Error ? error.message : String(error));
}

const report = [];
for (const titleCase of cases) {
  const titleStarted = Date.now();
  const result = {
    query: titleCase.query,
    expected: titleCase.expected,
    status: "PASS",
    sampledChapters: [],
  };
  try {
    console.error("[mangaxo] " + titleCase.expected + ": resolving search");
    const searchStarted = Date.now();
    const search = await module.searchResults(titleCase.query, 1);
    const item = chooseItem(search.items, titleCase.expected);
    record(titleCase.expected + ":search", Boolean(item?.id), search.items.length + " results in " + (Date.now() - searchStarted) + "ms");
    if (!item?.id) throw new Error("title was not found in search results (" + search.items.map((entry) => entry.title).join(", ") + ")");

    console.error("[mangaxo] " + titleCase.expected + ": resolving details");
    const detailsStarted = Date.now();
    const details = await module.extractDetails(item.id);
    const detailsOK = normalized(details.title).includes(normalized(titleCase.expected));
    record(titleCase.expected + ":details", detailsOK, details.title + " in " + (Date.now() - detailsStarted) + "ms");
    if (!detailsOK) throw new Error("details resolved to " + details.title);

    console.error("[mangaxo] " + titleCase.expected + ": loading chapters");
    const chaptersStarted = Date.now();
    const chapters = await module.extractChapters(details.id);
    const numbers = chapters.map((chapter) => chapter.number).filter((number) => number != null);
    const sorted = numbers.every((number, index) => index === 0 || numbers[index - 1] <= number);
    const unique = new Set(chapters.map((chapter) => chapter.id)).size === chapters.length;
    const scoped = chapters.every((chapter) => new URL(chapter.id).pathname.startsWith(new URL(details.id).pathname + "/chapter-"));
    record(
      titleCase.expected + ":chapters",
      chapters.length > 0 && sorted && unique && scoped,
      chapters.length + " chapters (" + (Date.now() - chaptersStarted) + "ms; " + numbers[0] + ".." + numbers.at(-1) + ")",
    );
    if (!chapters.length || !sorted || !unique || !scoped) throw new Error("chapter list failed ordering, uniqueness, or series-scope checks");

    for (const chapter of sampleChapters(chapters)) {
      console.error("[mangaxo] " + titleCase.expected + ": checking " + chapter.title);
      const chapterStarted = Date.now();
      const pages = await module.extractImages(chapter.id);
      const pageURLs = pages.map(pageURL);
      record(
        titleCase.expected + ":" + chapter.title + ":pages",
        pageURLs.length > 0,
        pageURLs.length + " pages in " + (Date.now() - chapterStarted) + "ms",
      );
      if (!pageURLs.length) throw new Error(chapter.title + " returned no pages");

      const sampled = samplePages(pages);
      const imageProofs = await Promise.all(sampled.map((page) => fetchImage(page, chapter.title)));
      record(
        titleCase.expected + ":" + chapter.title + ":images",
        imageProofs.length === sampled.length,
        imageProofs.map((proof) => proof.bytes + "B/" + proof.elapsedMs + "ms").join(", "),
      );
      result.sampledChapters.push({
        title: chapter.title,
        number: chapter.number,
        pageCount: pages.length,
        sampledImages: imageProofs,
      });
      await pause(200);
    }
  } catch (error) {
    result.status = "FAIL";
    result.error = error instanceof Error ? error.message : String(error);
    record(titleCase.expected + ":unhandled", false, result.error);
  }
  result.elapsedMs = Date.now() - titleStarted;
  report.push(result);
}

const passed = checks.filter((check) => check.passed).length;
const score = checks.length ? (passed / checks.length) * 100 : 0;
const output = {
  module: "mangaxo",
  evidence: score >= 80 && report.filter((entry) => entry.status === "PASS").length >= Math.min(5, cases.length)
    ? "LIVE_NODE_PASS"
    : "PARTIAL",
  titleCount: report.length,
  passedTitles: report.filter((entry) => entry.status === "PASS").length,
  score: Number(score.toFixed(2)),
  checks: { passed, total: checks.length },
  elapsedMs: Date.now() - started,
  discovery: discovery.sections.map((section) => ({ id: section.id, count: section.items.length })),
  report,
  checkFailures: checks.filter((check) => !check.passed),
};
console.log(JSON.stringify(output, null, 2));
await mkdir(path.join(root, "reports"), { recursive: true });
await writeFile(path.join(root, "reports", "live-mangaxo-proof-latest.json"), JSON.stringify(output, null, 2) + "\n", "utf8");

if (report.length < Math.min(5, cases.length) || score < 80) process.exitCode = 1;

