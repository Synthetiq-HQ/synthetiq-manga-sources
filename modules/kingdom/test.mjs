import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("./", import.meta.url);

async function text(name) {
  return readFile(new URL(`./fixtures/${name}`, root), "utf8");
}

async function json(name) {
  return JSON.parse(await text(name));
}

function response(body, finalUrl, status = 200) {
  return {
    body,
    finalUrl,
    status,
    ok: status >= 200 && status < 300,
    bodyDropped: false,
    text: async () => body,
  };
}

async function loadModule(fetchv2) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetchv2,
  });
  context.globalThis = context;
  new vm.Script(await readFile(new URL("./index.js", root), "utf8"), {
    filename: "modules/kingdom/index.js",
  }).runInContext(context);
  return context.SynthetiqModule;
}

test("Kingdom keeps only owned chapters, sorts them, and ignores duplicate/foreign links", async () => {
  const fixtures = {
    home: await text("home.html"),
    chapter: await text("chapter.html"),
    expected: await json("expected.json"),
  };
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (String(url).includes("/chapter/")) {
      return response(fixtures.chapter, "https://ww6.readkingdom.com/chapter/kingdom-chapter-003/");
    }
    return response(fixtures.home, "https://ww6.readkingdom.com/manga/kingdom/");
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("kingdom", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractDetails(fixtures.expected.details.id))), fixtures.expected.details);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractChapters(fixtures.expected.details.id))), fixtures.expected.chapters);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(fixtures.expected.chapters[0].id))), fixtures.expected.images);

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("romance", 1))), { items: [], hasMore: false });
  assert.equal(calls.filter((call) => call.url.includes("/manga/kingdom/")).length, 1);
  assert.ok(calls.every((call) => call.method === "GET" && call.body === null));
  assert.ok(calls.every((call) => call.options.responseClass === "html"));
});

test("Kingdom accepts decimal chapter URL variants but rejects history spoilers and unusable images", async () => {
  const decimalHTML = [
    '<a href="/chapter/kingdom-chapter-823.5/">Read</a>',
    '<a href="/chapter/kingdom-chapter-823.5/">Read again</a>',
    '<a href="/chapter/kingdom-chapter-481-5/">Read dashed variant</a>',
    '<a href="/chapter/kingdom-history-spoilers-chapter-0">History Spoilers</a>',
  ].join("\n");
  const decimalChapter = await loadModule(async (url) => {
    if (String(url).includes("chapter/")) {
      return response(await text("chapter.html"), "https://ww6.readkingdom.com/chapter/kingdom-chapter-823.5/");
    }
    return response(decimalHTML, "https://ww6.readkingdom.com/manga/kingdom/");
  });
  const chapters = await decimalChapter.extractChapters("https://readkingdom.com/manga/kingdom/");
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].number, 823.5);
  assert.equal(chapters[1].number, 481.5);
  assert.equal(chapters[0].id, "https://readkingdom.com/chapter/kingdom-chapter-823.5/");
  assert.equal(chapters[1].id, "https://readkingdom.com/chapter/kingdom-chapter-481-5/");

  await assert.rejects(
    () => decimalChapter.extractImages("https://readkingdom.com/chapter/kingdom-history-spoilers-chapter-0"),
    /Invalid Kingdom chapter identifier/,
  );
  assert.equal((await decimalChapter.extractImages("https://readkingdom.com/chapter/kingdom-chapter-823.5/")).length, 2);
});
