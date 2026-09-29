import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const moduleRoot = new URL("./", import.meta.url);

async function read(name) {
  return readFile(new URL(`./${name}`, moduleRoot), "utf8");
}

async function loadModule(fetchv2) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(await read("index.js"), { filename: "modules/librivox/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

function response(body, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {},
    finalUrl: url,
    body,
    bodyDropped: false,
    text: async () => body,
  };
}

test("LibriVox searches the catalogue and resolves slug pages to audiobook records", async () => {
  const search = await read("fixtures/search.json");
  const page = await read("fixtures/page.html");
  const details = await read("fixtures/details.json");
  const expected = JSON.parse(await read("fixtures/expected.json"));
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url: String(url), headers, method, body, options });
    assert.equal(method, "GET");
    assert.equal(body, null);
    if (String(url).includes("/advanced_search")) {
      assert.equal(headers.Referer, "https://librivox.org/");
      return response(search, String(url));
    }
    if (String(url) === "https://librivox.org/fixture-audio-book/") return response(page, String(url));
    if (/[?&]id=9001/.test(String(url))) {
      assert.equal(options.responseClass, "json");
      return response(details, String(url));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const results = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), expected.search);
  assert.equal(results.items[0].id, "https://librivox.org/fixture-audio-book/");

  const detailsResult = await module.extractDetails(results.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(detailsResult)), expected.details);

  const chapters = await module.extractChapters(detailsResult.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), expected.chapters);

  const audio = await module.extractAudio(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(audio)), expected.audio);
});

test("LibriVox reports empty searches and rejects invalid identities", async () => {
  const empty = JSON.stringify({ status: "SUCCESS", results: "No results found", pagination: "", search_page: 1 });
  const module = await loadModule(async (url) => response(empty, String(url)));

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("zzzz-no-match", 1))), {
    items: [],
    hasMore: false,
  });
  await assert.rejects(
    () => module.extractDetails("https://evil.example/audiobook/"),
    /Invalid LibriVox audiobook identifier/,
  );
  await assert.rejects(
    () => module.extractDetails("librivox:book:0:section:1"),
    /Invalid LibriVox audiobook identifier/,
  );
});

test("LibriVox keeps its documented catalogue feed intact", async () => {
  const catalogue = await read("fixtures/home.json");
  const module = await loadModule(async (url) => {
    assert.ok(String(url).includes("/api/feed/audiobooks/"));
    return response(catalogue, String(url));
  });
  const home = await module.discoveryHome();
  assert.equal(home.sections[0].id, "catalogue");
  assert.equal(home.sections[0].items.length, 2);
  assert.equal(home.sections[0].items[0].id, "9001");
  const feed = await module.discoveryFeed("latest", 1);
  assert.equal(feed.items.length, 2);
});
