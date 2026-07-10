import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

async function loadModule(path, bridges) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, ...bridges });
  context.globalThis = context;
  new vm.Script(await text(path), { filename: path }).runInContext(context);
  return context;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, body };
}

test("WeebCentral parses direct HTTP fixtures and preserves every chapter", async () => {
  const fixtures = {
    search: await text("modules/weebcentral/fixtures/search.html"),
    details: await text("modules/weebcentral/fixtures/details.html"),
    chapters: await text("modules/weebcentral/fixtures/chapters.html"),
    images: await text("modules/weebcentral/fixtures/images.html"),
    expected: await json("modules/weebcentral/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/weebcentral/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      calls.push({ url, headers, method, body, options });
      if (url.includes("/search/data?")) return response(fixtures.search);
      if (url.endsWith("/full-chapter-list")) return response(fixtures.chapters);
      if (url.includes("/images?")) return response(fixtures.images);
      if (url.includes("/series/")) return response(fixtures.details);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.match(calls[0].url, /adult=False/);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
});

test("MangaFire uses pagev2, paginates chapters, and keeps scramble markers", async () => {
  const fixtures = {
    search: await json("modules/mangafire/fixtures/search.json"),
    details: await json("modules/mangafire/fixtures/details.json"),
    firstChapters: await json("modules/mangafire/fixtures/chapters-page-1.json"),
    secondChapters: await json("modules/mangafire/fixtures/chapters-page-2.json"),
    chapter: await json("modules/mangafire/fixtures/chapter.json"),
    structuredPages: await json("modules/mangafire/fixtures/pages.json"),
    expected: await json("modules/mangafire/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/mangafire/index.js", {
    pagev2: async (task) => {
      assert.equal(typeof task, "object");
      assert.equal(task.captureResponseBodies, false);
      assert.equal(task.returnScript, "document.body ? document.body.innerText : ''");
      calls.push(task);
      let payload;
      if (task.url.includes("/api/titles?")) payload = fixtures.search;
      else if (task.url.endsWith("/api/titles/fixture")) payload = fixtures.details;
      else if (task.url.includes("/api/titles/fixture/chapters") && task.url.includes("page=1")) payload = fixtures.firstChapters;
      else if (task.url.includes("/api/titles/fixture/chapters") && task.url.includes("page=2")) payload = fixtures.secondChapters;
      else if (task.url.endsWith("/api/chapters/9001")) payload = fixtures.chapter;
      else if (task.url.endsWith("/api/chapters/9002")) payload = fixtures.structuredPages;
      else throw new Error(`Unexpected URL: ${task.url}`);
      return {
        finalURL: task.url,
        title: "",
        html: null,
        cookies: {},
        events: [],
        evaluatedData: JSON.stringify(payload),
      };
    },
    fetchv2: async () => {
      throw new Error("fetchv2 fallback should not run when pagev2 succeeds");
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(calls.filter((call) => call.url.includes("/chapters?")).length, 2);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  const structured = await module.extractImages("9002");
  assert.equal(structured[1].scrambled, true);
  assert.equal(structured[1].scrambleKey, "fixture-key");
  assert.deepEqual(JSON.parse(JSON.stringify(structured[1].tiles)), { rows: 4, columns: 4, order: [3, 0, 1, 2] });
});

test("Internet Archive exposes only explicitly open, public files", async () => {
  const fixtures = {
    search: await text("modules/internet-archive/fixtures/search.json"),
    open: await text("modules/internet-archive/fixtures/metadata-open.json"),
    closed: await text("modules/internet-archive/fixtures/metadata-closed.json"),
    book: await text("modules/internet-archive/fixtures/text.txt"),
    expected: await json("modules/internet-archive/fixtures/expected.json"),
  };
  const module = await loadModule("modules/internet-archive/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.includes("/advancedsearch.php?")) return response(fixtures.search);
      if (url.includes("/metadata/open-fixture")) return response(fixtures.open);
      if (url.includes("/metadata/closed-fixture")) return response(fixtures.closed);
      if (url.endsWith("/open-fixture/fixture_book_djvu.txt")) return response(fixtures.book);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const resources = await module.extractResources("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(resources)), fixtures.expected.resources);

  const chapters = await module.extractChapters("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const book = await module.extractText(chapters[0].url);
  assert.equal(book, fixtures.book);
  await assert.rejects(
    () => module.extractResources("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
  );
});
