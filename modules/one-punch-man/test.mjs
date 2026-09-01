import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleDir = path.join(root, "modules", "one-punch-man");

async function loadText(name) {
  return readFile(path.join(moduleDir, "fixtures", name), "utf8");
}

function response(body, finalUrl, status = 200, contentType = "text/html") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": contentType },
    finalUrl,
    body,
    bodyDropped: false,
    dropReason: null,
    bodyBytes: Buffer.byteLength(body),
    contentType,
    error: null,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadModule(options = {}) {
  const source = await readFile(path.join(moduleDir, "index.js"), "utf8");
  const details = await loadText("details.html");
  const chapter = await loadText("chapter.html");
  const challenge = await loadText("challenge.html");
  const calls = [];
  const fetchv2 = async (url, headers, method, body, requestOptions) => {
    calls.push({ url: String(url), headers, method, body, requestOptions });
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(headers.Cookie, undefined, "the module must not require cookies");
    assert.equal(requestOptions.followRedirects, true);
    const requested = String(url);
    if (requested.includes("/manga/one-punch-man/")) {
      return response(details, "https://ww7.readopm.com/manga/one-punch-man/");
    }
    if (requested.includes("one-punch-man-chapter-999")) {
      return response(challenge, "https://ww7.readopm.com/chapter/one-punch-man-chapter-999/");
    }
    if (requested.includes("/chapter/one-punch-man-chapter-")) {
      return response(chapter, "https://ww7.readopm.com/chapter/one-punch-man-chapter-237/");
    }
    if (options.onRequest) return options.onRequest(requested);
    throw new Error(`Unexpected fixture URL: ${requested}`);
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    fetchv2,
  });
  new vm.Script(source, { filename: "modules/one-punch-man/index.js" }).runInContext(context);
  assert.equal(typeof context.SynthetiqModule, "object");
  return { module: context.SynthetiqModule, calls };
}

test("search and discovery remain restricted to the main One Punch Man series", async () => {
  const { module } = await loadModule();
  const expected = JSON.parse(await loadText("expected.json"));
  assert.deepEqual(plain(await module.searchResults("one punch man", 1)), expected.search);
  assert.deepEqual(plain(await module.searchResults("colored", 1)), { items: [], hasMore: false });
  assert.deepEqual(plain(await module.searchResults("official", 1)), { items: [], hasMore: false });
  const discovery = await module.discoveryHome();
  assert.equal(discovery.sections.length, 2);
  assert.ok(discovery.sections.every((section) => section.items.length === 1));
  assert.ok(discovery.sections.every((section) => section.items[0].title === "One Punch Man"));
});

test("details and chapter parsing use displayed numbers, deduplicate URLs, and exclude other editions", async () => {
  const { module } = await loadModule();
  const expected = JSON.parse(await loadText("expected.json"));
  assert.deepEqual(plain(await module.extractDetails(expected.details.id)), expected.details);
  const chapters = await module.extractChapters(expected.details.id);
  assert.deepEqual(plain(chapters), expected.chapters);
  assert.equal(new Set(chapters.map((chapter) => chapter.id)).size, chapters.length);
  assert.deepEqual(plain(chapters.map((chapter) => chapter.number)), [237, 143, 100.2, 78.5, 55.003, 55, 1]);
  assert.ok(chapters.every((chapter) => !/official|colored|other-series/i.test(chapter.url)));
  await assert.rejects(
    () => module.extractDetails("https://readopm.com/manga/one-punch-man-official/"),
    /Invalid One Punch Man series identifier/,
  );
});

test("reader parsing returns real lazy image URLs in page order and rejects challenge pages", async () => {
  const { module } = await loadModule();
  const expected = JSON.parse(await loadText("expected.json"));
  assert.deepEqual(plain(await module.extractImages(expected.chapters[0].id)), expected.images);
  await assert.rejects(
    () => module.extractImages("https://readopm.com/chapter/one-punch-man-chapter-999/"),
    /challenge or access-denied/i,
  );
  await assert.rejects(
    () => module.extractImages("https://readopm.com/chapter/one-punch-man-official-chapter-167/"),
    /Invalid One Punch Man chapter identifier/,
  );
});
