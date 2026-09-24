import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(root, "fixtures", name), "utf8");

function response(body, contentType = "text/html") {
  return {
    status: 200,
    ok: true,
    body,
    contentType,
    finalUrl: "https://novelneko.fr/",
    bodyDropped: false,
    text: async () => body,
  };
}

async function load(fetchv2) {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

test("NovelNeko Web-Novels parses safe search, details, ordered chapters, and text", async () => {
  const fixtures = {
    catalog: await fixture("webnovel.json"),
    safe: await fixture("details-safe.html"),
    unsafe: await fixture("details-unsafe.html"),
    missing: await fixture("details-missing-metadata.html"),
    lecture: await fixture("lecture.html"),
    chapter: await fixture("chapter.txt"),
  };
  const calls = [];
  const module = await load(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (url.endsWith("/webnovel.json")) return response(fixtures.catalog, "application/json");
    if (url.includes("fixture-chronicle/lecture.html")) return response(fixtures.lecture);
    if (url.includes("fixture-chronicle/chapters/chapitre_001.txt") || url.includes("fixture-chronicle/chapters/chapitre_002.txt")) {
      return response(fixtures.chapter, "text/plain");
    }
    if (url.includes("fixture-chronicle/")) return response(fixtures.safe);
    if (url.includes("fixture-ecchi/")) return response(fixtures.unsafe);
    if (url.includes("fixture-missing/")) return response(fixtures.missing);
    throw new Error(`Unexpected URL: ${url}`);
  });

  const search = await module.searchResults("fixture", 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, "Fixture Chronicle");
  assert.equal(search.items[0].language, "fr");

  const details = await module.extractDetails(search.items[0].id);
  assert.equal(details.author, "Example Author");
  assert.deepEqual(Array.from(details.genres), ["Action", "Fantasy"]);
  assert.equal(details.chapterCount, 2);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(Array.from(chapters, (chapter) => chapter.number), [1, 2]);
  assert.match(chapters[0].id, /lecture\.html\?chapitre=1$/);

  const chapter = await module.extractText(chapters[0].id);
  assert.equal(chapter.title, "Fixture Chronicle - Chapitre 001");
  assert.match(chapter.content, /contenu non vide/i);
  const secondChapter = await module.extractText(chapters[1].id);
  assert.equal(secondChapter.title, "Fixture Chronicle - Chapitre 002");
  assert.ok(calls.some((call) => call.url.includes("chapitre_001.txt")));
  assert.ok(calls.every((call) => call.url.startsWith("https://novelneko.fr/")));
});

test("NovelNeko Web-Novels fails closed for unsafe and missing safety metadata", async () => {
  const fixtures = {
    catalog: await fixture("webnovel.json"),
    unsafe: await fixture("details-unsafe.html"),
    missing: await fixture("details-missing-metadata.html"),
  };
  const module = await load(async (url) => {
    if (url.endsWith("/webnovel.json")) return response(fixtures.catalog, "application/json");
    if (url.includes("fixture-ecchi/")) return response(fixtures.unsafe);
    if (url.includes("fixture-missing/")) return response(fixtures.missing);
    throw new Error(`Unexpected URL: ${url}`);
  });

  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-ecchi/"), /strict safety filter/i);
  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-missing/"), /safety metadata is missing/i);
  const search = await module.searchResults("fixture", 1);
  assert.equal(search.items.length, 0);
});

test("NovelNeko Web-Novels rejects off-host and malformed chapter identifiers", async () => {
  const module = await load(async () => {
    throw new Error("No network request expected");
  });
  await assert.rejects(
    () => module.extractText("https://evil.example/webnovels/fixture/lecture.html?chapitre=1"),
    /Invalid NovelNeko chapter URL/i,
  );
  await assert.rejects(
    () => module.extractText("https://novelneko.fr/webnovels/fixture/lecture.html?chapitre=0"),
    /Invalid NovelNeko chapter number/i,
  );
});

test("NovelNeko Web-Novels handles restricted metadata, supported type variants, and unsafe chapter text", async () => {
  const fixtures = {
    catalog: await fixture("webnovel.json"),
    safe: await fixture("details-safe.html"),
    paid: await fixture("details-paid.html"),
    locked: await fixture("details-locked.html"),
    synopsisAdult: await fixture("details-synopsis-adult.html"),
    lightNovel: await fixture("details-light-novel.html"),
    statusEnglish: await fixture("details-status-en.html"),
    noType: await fixture("details-no-type.html"),
    unsupportedType: await fixture("details-unsupported-type.html"),
    lecture: await fixture("lecture.html"),
    chapterPaid: await fixture("chapter-paid.txt"),
    chapterLocked: await fixture("chapter-locked.txt"),
  };
  const module = await load(async (url) => {
    if (url.endsWith("/webnovel.json")) return response(fixtures.catalog, "application/json");
    if (url.includes("fixture-paid/")) return response(fixtures.paid);
    if (url.includes("fixture-locked/")) return response(fixtures.locked);
    if (url.includes("fixture-synopsis-adult/")) return response(fixtures.synopsisAdult);
    if (url.includes("fixture-light-novel/")) return response(fixtures.lightNovel);
    if (url.includes("fixture-status-en/")) return response(fixtures.statusEnglish);
    if (url.includes("fixture-no-type/")) return response(fixtures.noType);
    if (url.includes("fixture-unsupported-type/")) return response(fixtures.unsupportedType);
    if (url.includes("fixture-text-paid/lecture.html")) return response(fixtures.lecture);
    if (url.includes("fixture-text-paid/chapters/chapitre_001")) return response(fixtures.chapterPaid, "text/plain");
    if (url.includes("fixture-text-locked/lecture.html")) return response(fixtures.lecture);
    if (url.includes("fixture-text-locked/chapters/chapitre_001")) return response(fixtures.chapterLocked, "text/plain");
    if (url.includes("fixture-text-paid/") || url.includes("fixture-text-locked/")) return response(fixtures.safe);
    throw new Error(`Unexpected URL: ${url}`);
  });

  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-paid/"), /strict safety filter/i);
  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-locked/"), /strict safety filter/i);
  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-synopsis-adult/"), /strict safety filter/i);
  const lightNovelDetails = await module.extractDetails("https://novelneko.fr/webnovels/fixture-light-novel/");
  assert.equal(lightNovelDetails.type, "Light Novel");
  const statusEnglishDetails = await module.extractDetails("https://novelneko.fr/webnovels/fixture-status-en/");
  assert.equal(statusEnglishDetails.status, "Terminé");
  const noTypeDetails = await module.extractDetails("https://novelneko.fr/webnovels/fixture-no-type/");
  assert.equal(noTypeDetails.type, "Web Novel");
  await assert.rejects(() => module.extractDetails("https://novelneko.fr/webnovels/fixture-unsupported-type/"), /not a supported novel format/i);
  await assert.rejects(
    () => module.extractText("https://novelneko.fr/webnovels/fixture-text-paid/lecture.html?chapitre=1"),
    /strict safety filter|HTML instead of chapter text|paid, locked/i,
  );
  await assert.rejects(
    () => module.extractText("https://novelneko.fr/webnovels/fixture-text-locked/lecture.html?chapitre=1"),
    /strict safety filter|HTML instead of chapter text|paid, locked/i,
  );
});

test("NovelNeko Web-Novels paginates the filtered catalog and fails on malformed JSON", async () => {
  const catalog = await fixture("webnovel.json");
  const pagination = await fixture("details-pagination.html");
  const module = await load(async (url) => {
    if (url.endsWith("/webnovel.json")) return response(catalog, "application/json");
    if (url.includes("fixture-page-")) return response(pagination);
    throw new Error(`Unexpected URL: ${url}`);
  });
  const firstPage = await module.searchResults("Page", 1);
  assert.equal(firstPage.items.length, 24);
  assert.equal(firstPage.hasMore, true);
  const secondPage = await module.searchResults("Page", 2);
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);

  const malformed = await load(async (url) => {
    if (url.endsWith("/webnovel.json")) return response(await fixture("catalog-malformed.json"), "application/json");
    throw new Error(`Unexpected URL: ${url}`);
  });
  await assert.rejects(() => malformed.searchResults("anything", 1), /not an array/i);
});
