#!/usr/bin/env node
/**
 * Live end-to-end proof for the Poseidon Scans module.
 *
 * Exercises the real Next.js flight-data API with a real title:
 * discovery -> search -> details -> complete chapters (free-only, premium
 * gated) -> images + page probes for sampled chapters.
 * Opt-in: requires RUN_LIVE_TESTS=1.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1") {
  throw new Error("Set RUN_LIVE_TESTS=1 to run the Poseidon Scans live proof.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "modules", "poseidon-scans", "index.js");
const DOWNLOAD_PAGE_LIMIT = 12 * 1024 * 1024;
const IMAGE_CONCURRENCY = 4;

async function responseFor(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method,
    headers: { "User-Agent": "Mozilla/5.0", ...headers },
    body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(Math.max(10_000, Number(options.timeoutMilliseconds) || 30_000)),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  return {
    status: response.status,
    ok: response.ok,
    body: bytes.length <= limit ? new TextDecoder().decode(bytes) : "",
    bodyDropped: bytes.length > limit,
    contentType: response.headers.get("content-type") || "",
    text: async () => new TextDecoder().decode(bytes),
  };
}

async function loadModule() {
  const source = await readFile(modulePath, "utf8");
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetchv2: responseFor,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: modulePath }).runInContext(context);
  return context.SynthetiqModule;
}

const pause = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeImages(pages, label) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= pages.length) return;
      const page = pages[index];
      const imageURL = new URL(page.url);
      assert.equal(imageURL.pathname, "/_next/image", `${label} must use Poseidon's bounded image route`);
      assert.equal(imageURL.searchParams.get("w"), "1200", `${label} image width`);
      assert.equal(imageURL.searchParams.get("q"), "75", `${label} image quality`);
      assert.match(imageURL.searchParams.get("url") || "", /^https:\/\/poseidon-scans\.net\//, `${label} original image host`);

      const started = Date.now();
      try {
        const response = await fetch(page.url, {
          headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*", "User-Agent": "Mozilla/5.0", ...page.headers },
          signal: AbortSignal.timeout(30_000),
        });
        const bytes = await response.arrayBuffer();
        results.push({
          index,
          status: response.status,
          type: response.headers.get("content-type") || "",
          bytes: bytes.byteLength,
          elapsedMs: Date.now() - started,
        });
      } catch (error) {
        results.push({ index, error: String(error), bytes: 0, elapsedMs: Date.now() - started });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pages.length) }, () => worker()));
  const failures = results.filter((result) =>
    result.error
      || result.status !== 200
      || !result.type.startsWith("image/")
      || result.bytes === 0
      || result.bytes > DOWNLOAD_PAGE_LIMIT,
  );
  assert.equal(failures.length, 0, `${label} image probe failures: ${JSON.stringify(failures.slice(0, 3))}`);
  return {
    pages: results.length,
    totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
    maxBytes: Math.max(...results.map((result) => result.bytes)),
    slowestMs: Math.max(...results.map((result) => result.elapsedMs)),
  };
}

const module = await loadModule();

// 1. Discovery surfaces.
const discovery = await module.discoveryHome();
assert.ok(Array.isArray(discovery.sections) && discovery.sections.length >= 2, "discovery should expose popular + latest");
const totalDiscoveryItems = discovery.sections.reduce((sum, section) => sum + section.items.length, 0);
assert.ok(totalDiscoveryItems > 0, "discovery returned no items");
console.log(`discovery: ${discovery.sections.map((s) => `${s.id}=${s.items.length}`).join(", ")}`);

// 2. Search targets a real catalogue title.
const search = await module.searchResults("Eleceed", 1);
assert.ok(search.items.length > 0, "search should return items");
const found = search.items.find((item) => item.title.toLowerCase().includes("eleceed"));
assert.ok(found, "Eleceed should be a search result");
console.log(`search: ${found.title} — ${found.id}`);

// 3. Details carry title, id, a known status, and cover.
const details = await module.extractDetails(found.id);
assert.ok(details.title && details.id.length > 0 && details.image, "details carry title, id, image");
assert.ok(["Ongoing", "Completed", "Hiatus", "Cancelled", "Unknown"].includes(details.status), "status is a known value");
console.log(`details: ${details.title} | ${details.status} | genres=${details.genres.length} | ${details.author || "no author"}`);

// 4. Chapters: free-only, owned, unique, descending.
const chapters = await module.extractChapters(found.id);
assert.ok(chapters.length >= 5, "series exposes many chapters");
assert.ok(chapters.every((chapter) => chapter.id.startsWith(`${found.id}/chapter/`)), "chapters belong to the series");
assert.ok(chapters.every((chapter) => !/🔒/.test(chapter.title)), "premium-locked chapters must be filtered");
const unique = new Set(chapters.map((chapter) => chapter.id)).size;
assert.equal(unique, chapters.length, "no duplicate chapter ids");
for (let i = 1; i < chapters.length; i += 1) {
  assert.ok(chapters[i - 1].number >= chapters[i].number, "chapters sorted descending");
}
console.log(`chapters: ${chapters.length} free (${chapters[0].number}…${chapters[chapters.length - 1].number})`);

// 5. Images + complete bounded download probes on sampled chapters.
for (const target of [chapters[0], chapters[Math.floor(chapters.length / 2)], chapters[chapters.length - 1]]) {
  await pause();
  const pages = await module.extractImages(target.id);
  assert.ok(pages.length > 0, `chapter ${target.number} returned pages`);
  for (const page of pages) {
    const url = new URL(page.url);
    assert.ok(
      url.hostname === "poseidon-scans.net" || url.hostname.endsWith(".poseidon-scans.net"),
      "image host must be allowlisted",
    );
  }
  const probe = await probeImages(pages, `chapter ${target.number}`);
  console.log(`chapter ${target.number}: ${probe.pages} pages, max ${probe.maxBytes} bytes, slowest ${probe.slowestMs}ms`);
  await pause(300);
}

// 6. Regression case for oversized source scans reported by the owner.
const marriedSearch = await module.searchResults("More Than a Married Couple, But Not Lovers", 1);
const married = marriedSearch.items.find((item) => item.id.includes("/fuufu-ijou-koibito-miman-3939"));
assert.ok(married, "More Than a Married Couple, But Not Lovers should be discoverable");
const marriedChapters = await module.extractChapters(married.id);
const marriedChapter43 = marriedChapters.find((chapter) => chapter.number === 43);
assert.ok(marriedChapter43, "More Than a Married Couple, But Not Lovers chapter 43 should be listed");
const marriedPages = await module.extractImages(marriedChapter43.id);
const marriedProbe = await probeImages(marriedPages, "More Than a Married Couple, But Not Lovers chapter 43");
console.log(`More Than a Married Couple, But Not Lovers chapter 43: ${marriedProbe.pages} pages, max ${marriedProbe.maxBytes} bytes, slowest ${marriedProbe.slowestMs}ms`);

console.log("Poseidon Scans live proof: PASS (discovery + search + details + chapters + bounded full-page downloads)");
