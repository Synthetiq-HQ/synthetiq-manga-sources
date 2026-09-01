import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));

async function read(relativePath) {
  return readFile(path.join(moduleRoot, relativePath), "utf8");
}

async function readJSON(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function loadModule(fetchv2) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    fetchv2,
    setTimeout,
  });
  context.globalThis = context;
  new vm.Script(await read("index.js"), { filename: "modules/ichi-the-witch/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200) {
  return {
    body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function fixtureRouter(fixtures) {
  return async (url, headers, method, body, options) => {
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(options.responseClass, "html");
    if (url === "https://ww2.readichithewitch.com/manga/ichi-the-witch/") {
      assert.equal(headers.Referer, "https://readichithewitch.com/");
      return response(fixtures.details);
    }
    if (url.endsWith("/chapter/ichi-the-witch-chapter-1/")) {
      assert.equal(headers.Referer, url);
      return response(fixtures.chapter1);
    }
    if (url.endsWith("/chapter/ichi-the-witch-chapter-48/")) {
      assert.equal(headers.Referer, url);
      return response(fixtures.chapter48);
    }
    if (url.endsWith("/chapter/ichi-the-witch-chapter-96/")) {
      assert.equal(headers.Referer, url);
      return response(fixtures.chapter96);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("Ichi the Witch parses its owned listing and all three sampled reader layouts", async () => {
  const fixtures = {
    chapter1: await read("fixtures/chapter-1.html"),
    chapter48: await read("fixtures/chapter-48.html"),
    chapter96: await read("fixtures/chapter-96.html"),
    details: await read("fixtures/details.html"),
    expected: await readJSON("fixtures/expected.json"),
  };
  const module = await loadModule(fixtureRouter(fixtures));

  const search = await module.searchResults("Madan no Ichi", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("unrelated title", 1))), { items: [], hasMore: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("Ichi the Witch", 2))), { items: [], hasMore: false });

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(new Set(chapters.map((chapter) => chapter.number)).size, chapters.length);
  assert.ok(chapters.every((chapter) => chapter.url.startsWith("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-")));

  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(chapters[2].id))), fixtures.expected.images1);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(chapters[1].id))), fixtures.expected.images48);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(chapters[0].id))), fixtures.expected.images96);

  const discovery = await module.discoveryHome();
  assert.equal(discovery.sections.length, 1);
  assert.equal(discovery.sections[0].items[0].title, "Ichi the Witch");
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("unsupported", 1))), { items: [], hasMore: false });
});

test("Ichi the Witch rejects invalid chapter ownership, empty readers, and challenge pages", async () => {
  const details = await read("fixtures/details.html");
  const empty = await read("fixtures/empty-chapter.html");
  const challenge = await read("fixtures/challenge.html");
  const module = await loadModule(async (url, headers, method, body, options) => {
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(options.responseClass, "html");
    if (url.includes("/manga/ichi-the-witch/")) return response(details);
    if (url.endsWith("chapter-2/")) return response(empty);
    if (url.endsWith("chapter-3/")) return response(challenge);
    throw new Error(`Unexpected URL: ${url}`);
  });

  await assert.rejects(
    () => module.extractDetails("https://ww2.readichithewitch.com/manga/other-title/"),
    /Invalid Ichi the Witch series identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww2.readichithewitch.com/chapter/other-series-chapter-1/"),
    /Invalid Ichi the Witch chapter identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-2/"),
    /no readable page images/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-3/"),
    /challenge or access-denied/,
  );
});

test("Ichi the Witch manifest declares complete hashed module metadata", async () => {
  const manifest = await readJSON("manifest.json");
  assert.equal(manifest.id, "ichi-the-witch");
  assert.equal(manifest.contentType, "pageImages");
  assert.equal(manifest.releaseTrack, "beta");
  assert.ok(manifest.allowedHosts.includes("readichithewitch.com"));
  assert.ok(manifest.allowedHosts.includes("ww2.readichithewitch.com"));
  assert.ok(manifest.allowedHosts.includes("cdn.readichithewitch.com"));
  assert.ok(manifest.allowedHosts.includes("i.imgur.com"));
  assert.equal(
    createHash("sha256").update(await read("index.js")).digest("hex"),
    manifest.entry.sha256,
  );
  const icon = await readFile(path.join(moduleRoot, "icon.png"));
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(createHash("sha256").update(icon).digest("hex"), manifest.icon.sha256);
});
