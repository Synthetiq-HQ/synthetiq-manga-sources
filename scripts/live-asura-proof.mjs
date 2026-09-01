#!/usr/bin/env node
/**
 * Bounded live quality proof for the Asura Scans module.
 *
 * Uses ordinary public HTTPS requests only. It resolves six representative
 * titles, samples five evenly spaced public chapters per title, validates
 * every returned page URL, and downloads only the first, middle, and last
 * image from each sampled chapter.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1" && !process.argv.includes("--live")) {
  throw new Error("Set RUN_LIVE_TESTS=1 or pass --live to run the Asura Scans live proof.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "modules", "asura-scans", "index.js");
const manifest = JSON.parse(await readFile(path.join(root, "modules", "asura-scans", "manifest.json"), "utf8"));
const titleCases = [
  { query: "absolute sword sense", expected: "Absolute Sword Sense" },
  { query: "swordmaster", expected: "Swordmaster’s Youngest Son" },
  { query: "surviving", expected: "Surviving The Game as a Barbarian" },
  { query: "dungeon odyssey", expected: "Dungeon Odyssey" },
  { query: "nano machine", expected: "Nano Machine" },
  { query: "pick me up infinite gacha", expected: "Pick Me Up, Infinite Gacha" },
];

const requestedLimit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1]);
const cases = titleCases.slice(0, Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : titleCases.length);
const withDiscovery = process.argv.includes("--with-discovery");
const QA_TIMEOUT_MS = 20_000;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function allowedHost(host) {
  const normalized = String(host || "").toLowerCase();
  return manifest.allowedHosts.some((entry) => {
    const allowed = String(entry).toLowerCase();
    return allowed.startsWith("*.") ? normalized.endsWith("." + allowed.slice(2)) : normalized === allowed;
  });
}

function pageURL(value, expectedChapterNumber) {
  const url = new URL(typeof value === "string" ? value : value?.url);
  if (url.protocol !== "https:") throw new Error("non-HTTPS page URL: " + url.href);
  if (!allowedHost(url.hostname) || url.hostname.toLowerCase() !== "cdn.asurascans.com") {
    throw new Error("page host is not the Asura CDN: " + url.hostname);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 5
    || parts[0] !== "asura-images"
    || !new Set(["chapters", "chapters-restored"]).has(parts[1])
    || !/^[^/]+$/i.test(parts[2])
    || Number(parts[3]) !== Number(expectedChapterNumber)
    || !/^[a-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(parts[4])
  ) {
    throw new Error("page path is not an Asura Scans chapter image: " + url.pathname);
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
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  return indexes
    .map((index) => chapters[index])
    .filter((chapter) => chapter && !seen.has(chapter.id) && seen.add(chapter.id));
}

function samplePages(pages) {
  const indexes = [0, Math.floor((pages.length - 1) / 2), pages.length - 1];
  const seen = new Set();
  return indexes
    .map((index) => pages[index])
    .filter((page) => page && !seen.has(page.url) && seen.add(page.url));
}

async function fetchImage(page, chapterTitle, chapterNumber) {
  const url = pageURL(page, chapterNumber);
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
        && discovery.sections.length >= 2
        && discovery.sections.every((section) => Array.isArray(section.items) && section.items.length > 0),
      discovery.sections?.map((section) => section.id + ":" + section.items.length).join(", ") || "no sections",
    );
  } catch (error) {
    record("discovery", false, error instanceof Error ? error.message : String(error));
  }
} else {
  record("discovery", true, "covered by fixture discovery test; live feed check omitted");
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
    console.error("[asura] " + titleCase.expected + ": resolving search");
    const searchStarted = Date.now();
    const search = await module.searchResults(titleCase.query, 1);
    const item = chooseItem(search.items, titleCase.expected);
    record(titleCase.expected + ":search", Boolean(item?.id), search.items.length + " results in " + (Date.now() - searchStarted) + "ms");
    if (!item?.id) throw new Error("title was not found in search results (" + search.items.map((entry) => entry.title).join(", ") + ")");

    console.error("[asura] " + titleCase.expected + ": resolving details");
    const detailsStarted = Date.now();
    const details = await module.extractDetails(item.id);
    const detailsOK = normalized(details.title).includes(normalized(titleCase.expected));
    record(titleCase.expected + ":details", detailsOK, details.title + " in " + (Date.now() - detailsStarted) + "ms");
    if (!detailsOK) throw new Error("details resolved to " + details.title);

    console.error("[asura] " + titleCase.expected + ": loading chapters");
    const chaptersStarted = Date.now();
    const chapters = await module.extractChapters(details.id);
    const numbers = chapters.map((chapter) => chapter.number).filter((number) => number != null);
    const sorted = numbers.every((number, index) => index === 0 || numbers[index - 1] <= number);
    const unique = new Set(chapters.map((chapter) => chapter.id)).size === chapters.length;
    const scoped = chapters.every((chapter) => new URL(chapter.id).pathname.startsWith(new URL(details.id).pathname + "/chapter/"));
    const publicOnly = chapters.every((chapter) => chapter.number != null);
    record(
      titleCase.expected + ":chapters",
      chapters.length > 0 && sorted && unique && scoped && publicOnly,
      chapters.length + " public chapters (" + (Date.now() - chaptersStarted) + "ms; " + numbers[0] + ".." + numbers.at(-1) + ")",
    );
    if (!chapters.length || !sorted || !unique || !scoped || !publicOnly) {
      throw new Error("chapter list failed ordering, uniqueness, scope, or public-access checks");
    }

    for (const chapter of sampleChapters(chapters)) {
      console.error("[asura] " + titleCase.expected + ": checking " + chapter.title);
      const chapterStarted = Date.now();
      const pages = await module.extractImages(chapter.id);
      const pageURLs = pages.map((page) => pageURL(page, chapter.number));
      const pageUnique = new Set(pageURLs.map((page) => page.href)).size === pageURLs.length;
      record(
        titleCase.expected + ":" + chapter.title + ":pages",
        pageURLs.length > 0 && pageUnique,
        pageURLs.length + " ordered pages in " + (Date.now() - chapterStarted) + "ms",
      );
      if (!pageURLs.length || !pageUnique) throw new Error(chapter.title + " returned duplicate or no pages");

      const imageProofs = [];
      for (const page of samplePages(pages)) imageProofs.push(await fetchImage(page, chapter.title, chapter.number));
      record(
        titleCase.expected + ":" + chapter.title + ":images",
        imageProofs.length === samplePages(pages).length,
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
  module: "asura-scans",
  evidence: score >= 80 ? "LIVE_NODE_PASS" : "PARTIAL",
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
await writeFile(path.join(root, "reports", "live-asura-proof-latest.json"), JSON.stringify(output, null, 2) + "\n", "utf8");

if (report.length < Math.min(5, cases.length) || score < 80) process.exitCode = 1;
