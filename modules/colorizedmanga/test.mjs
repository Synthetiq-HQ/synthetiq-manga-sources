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

function response(body, finalUrl) {
  return {
    status: 200,
    ok: true,
    body,
    finalUrl,
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
    filename: "modules/colorizedmanga/index.js",
  }).runInContext(context);
  return context.SynthetiqModule;
}

test("ColorizedManga covers safe search, details, chapters, volumes, and ordered pages", async () => {
  const fixtures = {
    home: await text("home.html"),
    details: await text("details.html"),
    chapters: await text("chapters.html"),
    chapter: await text("chapter.html"),
    volumeDetails: await text("volume-details.html"),
    volumes: await text("volumes.html"),
    expected: await json("expected.json"),
  };
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (url.endsWith("/fixture-manga/chapters")) return response(fixtures.chapters, url);
    if (url.includes("/fixture-manga/chapter/")) return response(fixtures.chapter, url);
    if (url.endsWith("/fixture-manga")) return response(fixtures.details, url);
    if (url.endsWith("/volume-fixture/volumes")) return response(fixtures.volumes, url);
    if (url.endsWith("/volume-fixture")) return response(fixtures.volumeDetails, url);
    return response(fixtures.home, url);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("adult", 1))), { items: [], hasMore: false });

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);
  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const volumes = await module.extractChapters("https://colorizedmangas.com/volume-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(volumes.map((volume) => [volume.number, volume.title]))), [
    [1, "Volume 1 — First Volume"],
    [2, "Volume 2 — Second Volume"],
  ]);

  const discovery = await module.discoveryHome();
  assert.equal(discovery.sections.length, 1);
  assert.equal(discovery.sections[0].items.length, 1);
  assert.ok(calls.every((call) => call.method === "GET" && call.body === null));
  assert.ok(calls.every((call) => call.options.responseClass === "html"));
  assert.equal(calls.some((call) => call.url.includes("ads.example.invalid")), false);
});
