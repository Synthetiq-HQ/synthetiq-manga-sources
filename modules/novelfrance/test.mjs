import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(root, "fixtures", name), "utf8");

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
    contentType: "application/json",
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

test("NovelFrance filters unsafe search results and paginates with bounded public JSON routes", async () => {
  const search = await fixture("search.json");
  const calls = [];
  const module = await load(async (url) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, "novelfrance.fr");
    assert.equal(new URL(url).pathname, "/api/search");
    return response(search);
  });

  const result = await module.searchResults("fixture", 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "fixture-safe");
  assert.equal(result.items[0].image, "https://novelfrance.fr/uploads/covers/fixture-safe.webp");
  assert.equal((await module.searchResults("fixture", 2)).items.length, 1);
  assert.match(calls[1], /skip=20/);
  assert.match(calls[1], /take=20/);
});

test("NovelFrance discovery loads the public catalogue instead of returning no titles", async () => {
  const search = await fixture("search.json");
  const calls = [];
  const module = await load(async (url) => {
    calls.push(url);
    return response(search);
  });

  const home = await module.discoveryHome();
  assert.equal(home.sections.length, 1);
  assert.equal(home.sections[0].id, "latest");
  assert.equal(home.sections[0].items.length, 1);
  assert.match(calls[0], /\/api\/search\?q=&skip=0&take=20/);
  const second = await module.discoveryFeed("latest", 2);
  assert.equal(second.items.length, 1);
  assert.match(calls[1], /skip=20/);
  await assert.rejects(() => module.discoveryFeed("unknown", 1), /feed is invalid/i);
});

test("NovelFrance rejects malformed search identities and empty cleaned titles", async () => {
  const search = await fixture("search-regressions.json");
  const module = await load(async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "novelfrance.fr");
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.pathname, "/api/search");
    return response(search);
  });

  const result = await module.searchResults("regressions", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items.map(({ id, title }) => ({ id, title })))), [
    { id: "fixture-search-valid", title: "Fixture Search Valid" },
  ]);
});

test("NovelFrance rejects invalid search page input and pagination metadata", async () => {
  const module = await load(async () => response(JSON.stringify({ novels: [], hasMore: "false" })));
  await assert.rejects(() => module.searchResults("fixture", 0), /pagination page is invalid/i);
  await assert.rejects(() => module.searchResults("fixture", "not-a-page"), /pagination page is invalid/i);
  await assert.rejects(() => module.searchResults("fixture", 1), /pagination metadata was invalid/i);
});

test("NovelFrance reads safe details, ordered free chapters, and non-empty text", async () => {
  const fixtures = {
    details: await fixture("details.json"),
    chapters: await fixture("chapters.json"),
    chapter: await fixture("chapter.json"),
  };
  const module = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/novels/fixture-safe") return response(fixtures.details);
    if (parsed.pathname === "/api/chapters/fixture-safe" && !parsed.pathname.endsWith("chapter-1")) return response(fixtures.chapters);
    if (parsed.pathname === "/api/chapters/fixture-safe/chapter-1") return response(fixtures.chapter);
    throw new Error(`Unexpected URL: ${url}`);
  });

  const details = await module.extractDetails("https://novelfrance.fr/novel/fixture-safe");
  assert.equal(details.title, "Fixture Safe Novel");
  assert.deepEqual(Array.from(details.genres), ["Aventure", "Magie"]);
  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map(({ number, title }) => ({ number, title })))), [
    { number: 1, title: "Arrival" },
    { number: 3, title: "Lessons" },
  ]);
  const text = await module.extractText(chapters[0].id);
  assert.equal(text, "The first fixture paragraph.\n\nThe second fixture paragraph.");
});

test("NovelFrance fails closed for unsafe or incomplete safety metadata and locked text", async () => {
  const fixtures = {
    unsafe: await fixture("details-unsafe.json"),
    missing: await fixture("details-missing.json"),
    empty: await fixture("details-empty.json"),
    malformed: await fixture("details-malformed.json"),
    chapters: await fixture("chapters.json"),
    locked: await fixture("chapter-locked.json"),
  };
  const module = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/novels/fixture-unsafe") return response(fixtures.unsafe);
    if (parsed.pathname === "/api/novels/fixture-missing") return response(fixtures.missing);
    if (parsed.pathname === "/api/novels/fixture-empty") return response(fixtures.empty);
    if (parsed.pathname === "/api/novels/fixture-malformed") return response(fixtures.malformed);
    if (parsed.pathname === "/api/novels/fixture-safe") return response(await fixture("details.json"));
    if (parsed.pathname === "/api/chapters/fixture-safe" && parsed.pathname.split("/").length === 4) return response(fixtures.chapters);
    if (parsed.pathname === "/api/chapters/fixture-safe/chapter-locked") return response(fixtures.locked);
    throw new Error(`Unexpected URL: ${url}`);
  });

  await assert.rejects(() => module.extractDetails("fixture-unsafe"), /safety filter/i);
  await assert.rejects(() => module.extractDetails("fixture-missing"), /safety metadata is missing/i);
  await assert.rejects(() => module.extractDetails("fixture-empty"), /safety metadata is missing|empty/i);
  await assert.rejects(() => module.extractDetails("fixture-malformed"), /safety metadata is malformed|empty/i);
  await assert.rejects(() => module.extractText("https://novelfrance.fr/novel/fixture-safe/chapter-locked"), /premium or locked/i);
  await assert.rejects(() => module.extractDetails("https://evil.example/novel/fixture-safe"), /host|identifier/i);
});

test("NovelFrance excludes premium chapters and rejects malformed chapter pagination", async () => {
  const fixtures = {
    details: await fixture("details.json"),
    chapters: await fixture("chapters.json"),
    badTake: await fixture("chapters-pagination-bad-take.json"),
    badHasMore: await fixture("chapters-pagination-bad-has-more.json"),
  };
  const calls = [];
  const module = await load(async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/api/novels/fixture-safe") return response(fixtures.details);
    if (parsed.pathname === "/api/chapters/fixture-safe") return response(fixtures.chapters);
    throw new Error(`Unexpected URL: ${url}`);
  });

  const chapters = await module.extractChapters("fixture-safe");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map(({ id }) => id))), [
    "https://novelfrance.fr/novel/fixture-safe/chapter-1",
    "https://novelfrance.fr/novel/fixture-safe/chapter-3",
  ]);
  assert.equal(calls.every((url) => new URL(url).hostname === "novelfrance.fr"), true);

  const badTakeModule = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/novels/fixture-safe") return response(fixtures.details);
    if (parsed.pathname === "/api/chapters/fixture-safe") return response(fixtures.badTake);
    throw new Error(`Unexpected URL: ${url}`);
  });
  await assert.rejects(() => badTakeModule.extractChapters("fixture-safe"), /pagination metadata was invalid/i);

  const badHasMoreModule = await load(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/novels/fixture-safe") return response(fixtures.details);
    if (parsed.pathname === "/api/chapters/fixture-safe") return response(fixtures.badHasMore);
    throw new Error(`Unexpected URL: ${url}`);
  });
  await assert.rejects(() => badHasMoreModule.extractChapters("fixture-safe"), /pagination metadata was invalid/i);
});

test("NovelFrance manifest pins the entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.entry.path, "modules/novelfrance/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/novelfrance/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
