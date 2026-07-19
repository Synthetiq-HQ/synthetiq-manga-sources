#!/usr/bin/env node
/**
 * Live end-to-end proof for the Atsu module.
 *
 * This deliberately exercises a real title rather than the module's discovery
 * home: search -> details -> complete chapters -> every image in two chapters.
 * It is opt-in because it makes live requests to the source.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

if (process.env.RUN_LIVE_TESTS !== "1") {
  throw new Error("Set RUN_LIVE_TESTS=1 to run the Atsu live proof.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "modules", "atsu", "index.js");

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
    fetchv2: responseFor,
  });
  context.globalThis = context;
  new vm.Script(source, { filename: "modules/atsu/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

async function mapConcurrent(values, limit, work) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await work(values[index], index);
    }
  });
  await Promise.all(workers);
}

function numericChapter(chapter) {
  const number = Number(chapter.number);
  return Number.isFinite(number) ? number : null;
}

const module = await loadModule();
const search = await module.searchResults("one piece", 1);
const onePiece = search.items.find((item) => /one piece/i.test(item.title));
assert.ok(onePiece, "Atsu search did not return One Piece.");

const details = await module.extractDetails(onePiece.id);
assert.match(details.title, /one piece/i, "Atsu details resolved the wrong title.");

const chapters = await module.extractChapters(onePiece.id);
assert.ok(chapters.length > 1, "Atsu did not return a complete chapter list.");
const numbered = chapters
  .map((chapter) => ({ chapter, number: numericChapter(chapter) }))
  .filter(({ number }) => number !== null)
  .sort((left, right) => left.number - right.number);
assert.ok(numbered.length > 1, "Atsu chapter list did not contain numeric chapters.");

const selected = [numbered[0].chapter, numbered.at(-1).chapter];
assert.notEqual(selected[0].id, selected[1].id, "Atsu chapter selection did not span two chapters.");

const chapterProofs = [];
for (const chapter of selected) {
  const payload = await module.extractImages(chapter.id);
  const images = Array.isArray(payload) ? payload : payload.images;
  assert.ok(Array.isArray(images) && images.length > 0, `Atsu returned no pages for ${chapter.title}.`);

  await mapConcurrent(images, 4, async (image, index) => {
    const url = typeof image === "string" ? image : image.url;
    const headers = typeof image === "object" ? image.headers || {} : {};
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = await response.arrayBuffer();
    assert.ok(response.ok, `Atsu page ${index + 1} failed with HTTP ${response.status}.`);
    assert.match(response.headers.get("content-type") || "", /^image\//i, `Atsu page ${index + 1} was not an image.`);
    assert.ok(bytes.byteLength > 0, `Atsu page ${index + 1} was empty.`);
  });

  chapterProofs.push({
    id: chapter.id,
    title: chapter.title,
    number: chapter.number ?? null,
    pageCount: images.length,
  });
}

console.log(JSON.stringify({
  module: "atsu",
  searchedTitle: onePiece.title,
  remoteMangaID: onePiece.id,
  chapterCount: chapters.length,
  verifiedChapters: chapterProofs,
}, null, 2));
