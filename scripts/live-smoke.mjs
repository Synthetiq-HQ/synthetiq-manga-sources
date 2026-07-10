import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1") {
  throw new Error("Set RUN_LIVE_TESTS=1 to run network-dependent source smoke checks.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(slug, bridges) {
  const source = await readFile(path.join(root, "modules", slug, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, ...bridges });
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  return context.SynthetiqModule;
}

async function networkResponse(url, headers = {}, method = "GET", body = null, options = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: options.followRedirects === false ? "manual" : "follow",
    signal: AbortSignal.timeout(20_000),
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

const fetchv2 = (url, headers, method, body, options) => networkResponse(url, headers, method, body, options);
const pagev2 = async (task) => {
  const response = await networkResponse(task.url, task.headers, "GET", null, {
    followRedirects: true,
    maxBytesHint: task.maxResponseCharacters,
  });
  if (!response.ok || response.bodyDropped) throw new Error(`pagev2 smoke request failed for ${task.url}`);
  return {
    finalURL: response.finalUrl,
    title: "",
    html: null,
    events: [],
    cookies: {},
    evaluatedData: response.body,
  };
};

const weeb = await loadModule("weebcentral", { fetchv2 });
const weebSearch = await weeb.searchResults("one piece", 1);
assert.ok(weebSearch.items.length > 0);
const weebDetails = await weeb.extractDetails(weebSearch.items[0].id);
const weebChapters = await weeb.extractChapters(weebDetails.id);
assert.ok(weebChapters.length > 0);
const weebImages = await weeb.extractImages(weebChapters[0].id);
assert.ok(weebImages.length > 0);

const mangaFire = await loadModule("mangafire", { pagev2, reportProgress: async () => ({ ok: true }) });
const mangaFireSearch = await mangaFire.searchResults("one piece", 1);
assert.ok(mangaFireSearch.items.length > 0);
const mangaFireDetails = await mangaFire.extractDetails(mangaFireSearch.items[0].id);
const mangaFireChapters = await mangaFire.extractChapters(mangaFireDetails.id);
assert.ok(mangaFireChapters.length > 0);
const mangaFireImages = await mangaFire.extractImages(mangaFireChapters[0].id);
assert.ok(mangaFireImages.length > 0);

const archive = await loadModule("internet-archive", { fetchv2 });
const archiveSearch = await archive.searchResults("XFETCH", 1);
assert.ok(archiveSearch.items.length > 0);
const archiveDetails = await archive.extractDetails(archiveSearch.items[0].id);
const archiveResources = await archive.extractResources(archiveDetails.id);
const archiveChapters = await archive.extractChapters(archiveDetails.id);
assert.ok(archiveResources.length > 0 || archiveChapters.length > 0);
let archiveTextBytes = 0;
if (archiveChapters.length > 0) {
  archiveTextBytes = (await archive.extractText(archiveChapters[0].id)).length;
  assert.ok(archiveTextBytes > 0);
}

console.log(JSON.stringify({
  weebcentral: {
    result: weebDetails.title,
    chapters: weebChapters.length,
    pages: weebImages.length,
  },
  mangafire: {
    result: mangaFireDetails.title,
    chapters: mangaFireChapters.length,
    pages: mangaFireImages.length,
  },
  internetArchive: {
    result: archiveDetails.title,
    resources: archiveResources.length,
    textSections: archiveChapters.length,
    textBytes: archiveTextBytes,
  },
}, null, 2));
