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
  new vm.Script(await read("index.js"), { filename: "modules/sakamoto-days/index.js" }).runInContext(context);
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

test("Sakamoto Days filters the home catalogue, deduplicates chapters, and preserves reader URLs", async () => {
  const details = await read("fixtures/details.html");
  const chapter = await read("fixtures/chapter.html");
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(options.followRedirects, true);
    assert.equal(options.responseClass, "html");
    if (String(url).includes("/manga/sakamoto-days/")) return response(details, String(url));
    if (String(url).includes("/chapter/sakamoto-days-chapter-137/")) return response(chapter, String(url));
    throw new Error(`Unexpected URL: ${url}`);
  });

  const search = await module.searchResults("sakamoto", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), JSON.parse(await read("fixtures/expected.json")).search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("garaku", 1))), { items: [], hasMore: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("sakamoto", 2))), { items: [], hasMore: false });

  const detailsResult = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(detailsResult)), JSON.parse(await read("fixtures/expected.json")).details);

  const chapters = await module.extractChapters(detailsResult.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), JSON.parse(await read("fixtures/expected.json")).chapters);
  assert.equal(new Set(chapters.map((item) => item.number)).size, chapters.length);
  assert.equal(chapters.some((item) => item.id.includes("colored")), false);
  assert.equal(chapters.some((item) => item.id.includes("garaku")), false);

  const images = await module.extractImages(chapters[1].id);
  assert.deepEqual(JSON.parse(JSON.stringify(images)), JSON.parse(await read("fixtures/expected.json")).images);
  assert.equal(images.every((item) => item.url.startsWith("https://cdn.readsakadays.com/file/mangap/")), true);
  assert.equal(images[1].url.includes("token=fixture"), true);
  assert.equal(calls.filter((call) => call.url.includes("/manga/sakamoto-days/")).length, 1);
});

test("Sakamoto Days rejects invalid identities and challenge pages", async () => {
  const details = await read("fixtures/details.html");
  const challenge = await read("fixtures/challenge.html");
  const module = await loadModule(async (url) => {
    if (String(url).includes("/manga/sakamoto-days/")) return response(details, String(url));
    return response(challenge, String(url));
  });

  await assert.rejects(() => module.extractDetails("https://ww2.readsakadays.com/manga/garaku/"), /Invalid Sakamoto Days series identifier/);
  await assert.rejects(() => module.extractImages("https://ww2.readsakadays.com/chapter/garaku-chapter-0/"), /Invalid Sakamoto Days chapter identifier/);
  await assert.rejects(() => module.extractImages("https://ww2.readsakadays.com/chapter/sakamoto-days-chapter-138/"), /challenge|access-denied/i);
});
