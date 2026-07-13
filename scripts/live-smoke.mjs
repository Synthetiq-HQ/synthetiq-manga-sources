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

const mangaKatana = await loadModule("mangakatana", { fetchv2 });
const mangaKatanaSearch = await mangaKatana.searchResults("naruto", 1);
assert.ok(mangaKatanaSearch.items.length > 0);
const mangaKatanaDetails = await mangaKatana.extractDetails(mangaKatanaSearch.items[0].id);
const mangaKatanaChapters = await mangaKatana.extractChapters(mangaKatanaDetails.id);
assert.ok(mangaKatanaChapters.length > 0);
const mangaKatanaImages = await mangaKatana.extractImages(mangaKatanaChapters[mangaKatanaChapters.length - 1].id);
assert.ok(mangaKatanaImages.length > 0);

const mgread = await loadModule("mgread", { fetchv2, reportProgress: async () => ({ ok: true }) });
const mgreadSearch = await mgread.searchResults("martial peak", 1);
assert.ok(mgreadSearch.items.length > 0);
const mgreadDetails = await mgread.extractDetails(mgreadSearch.items[0].id);
const mgreadChapters = await mgread.extractChapters(mgreadDetails.id);
assert.ok(mgreadChapters.length > 0);
const mgreadImages = await mgread.extractImages(
  mgreadChapters.find((chapter) => chapter.number === 1)?.id || mgreadChapters[mgreadChapters.length - 1].id,
);
assert.ok(mgreadImages.length > 0);

console.log(JSON.stringify({
  weebcentral: {
    result: weebDetails.title,
    chapters: weebChapters.length,
    pages: weebImages.length,
    firstPage: typeof weebImages[0] === "string" ? weebImages[0] : weebImages[0]?.url,
  },
  mangafire: {
    result: mangaFireDetails.title,
    chapters: mangaFireChapters.length,
    pages: mangaFireImages.length,
    firstPage: typeof mangaFireImages[0] === "string" ? mangaFireImages[0] : mangaFireImages[0]?.url,
  },
  internetArchive: {
    result: archiveDetails.title,
    resources: archiveResources.length,
    textSections: archiveChapters.length,
    textBytes: archiveTextBytes,
  },
  mangakatana: {
    result: mangaKatanaDetails.title,
    chapters: mangaKatanaChapters.length,
    pages: mangaKatanaImages.length,
    firstPage: typeof mangaKatanaImages[0] === "string" ? mangaKatanaImages[0] : mangaKatanaImages[0]?.url,
  },
  mgread: {
    result: mgreadDetails.title,
    chapters: mgreadChapters.length,
    pages: mgreadImages.length,
    firstPage: typeof mgreadImages[0] === "string" ? mgreadImages[0] : mgreadImages[0]?.url,
  },
}, null, 2));
