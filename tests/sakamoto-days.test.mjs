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

async function loadModule(bridges) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    ...bridges,
  });
  context.globalThis = context;
  new vm.Script(await text("modules/sakamoto-days/index.js"), { filename: "modules/sakamoto-days/index.js" })
    .runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200, finalUrl = "https://ww2.readsakadays.com/manga/sakamoto-days/") {
  return {
    ok: status >= 200 && status < 300,
    status,
    finalUrl,
    body,
    bodyDropped: false,
    text: async () => body,
  };
}

test("Sakamoto Days scopes chapters to the series, parses lazy reader pages, and accepts the imgchest CDN", async () => {
  const fixtures = {
    details: await text("modules/sakamoto-days/fixtures/details.html"),
    chapter: await text("modules/sakamoto-days/fixtures/chapter.html"),
    expected: await json("modules/sakamoto-days/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule({
    fetchv2: async (url, headers, method, body, options) => {
      calls.push({ url, headers, method, body, options });
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(options.followRedirects, true);
      assert.equal(options.responseClass, "html");
      if (url.includes("/chapter/sakamoto-days-chapter-")) {
        assert.equal(headers.Referer, url);
        return response(fixtures.chapter, 200, url);
      }
      if (url.includes("/manga/sakamoto-days/")) return response(fixtures.details);
      throw new Error(`Unexpected Sakamoto Days fixture URL: ${url}`);
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("sakamoto", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("naruto", 1))), { items: [], hasMore: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("sakamoto", 2))), { items: [], hasMore: false });

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map((chapter) => chapter.number))), [273, 137, 1.5, 1, 0]);

  const images = await module.extractImages("https://ww2.readsakadays.com/chapter/sakamoto-days-chapter-137/");
  assert.deepEqual(JSON.parse(JSON.stringify(images)), fixtures.expected.images);
  assert.ok(images.every((page) => ["cdn.readsakadays.com", "cdn.imgchest.com"].includes(new URL(page.url).hostname)));
  assert.ok(images.some((page) => new URL(page.url).hostname === "cdn.readsakadays.com"));
  assert.ok(images.some((page) => new URL(page.url).hostname === "cdn.imgchest.com"));

  const manifest = await json("modules/sakamoto-days/manifest.json");
  assert.equal(manifest.allowedHosts.includes("cdn.imgchest.com"), true);
  assert.equal(manifest.allowedHosts.includes("cdn.readsakadays.com"), true);
  assert.ok(images.every((page) => page.headers.Referer.includes("/chapter/sakamoto-days-chapter-137/")));
  assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryHome())), {
    sections: [{ id: "latest", title: "Sakamoto Days", items: fixtures.expected.search.items }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("popular", 1))), {
    items: fixtures.expected.search.items,
    hasMore: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("unknown", 1))), { items: [], hasMore: false });
});

test("Sakamoto Days rejects invalid hosts, challenges, and empty readers", async () => {
  const fixtures = {
    details: await text("modules/sakamoto-days/fixtures/details.html"),
    empty: await text("modules/sakamoto-days/fixtures/chapter-empty.html"),
    challenge: await text("modules/sakamoto-days/fixtures/challenge.html"),
  };
  const module = await loadModule({
    fetchv2: async (url) => {
      if (url.includes("/manga/sakamoto-days/")) return response(fixtures.details);
      return response(fixtures.empty, 200, url);
    },
  });

  await assert.rejects(
    () => module.extractDetails("https://evil.example/manga/sakamoto-days/"),
    /Invalid Sakamoto Days series identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://evil.example/chapter/sakamoto-days-chapter-137/"),
    /Invalid Sakamoto Days chapter identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww2.readsakadays.com/chapter/sakamoto-days-chapter-137/"),
    /returned no readable page images/,
  );

  const challengeModule = await loadModule({
    fetchv2: async () => response(fixtures.challenge),
  });
  await assert.rejects(
    () => challengeModule.searchResults("sakamoto", 1),
    /challenge or access-denied/,
  );
});

test("Sakamoto Days retries one transient catalogue response without using credentials", async () => {
  const details = await text("modules/sakamoto-days/fixtures/details.html");
  let attempts = 0;
  const module = await loadModule({
    fetchv2: async (url) => {
      assert.equal(url, "https://ww2.readsakadays.com/manga/sakamoto-days/");
      attempts += 1;
      if (attempts === 1) return response("temporary upstream failure", 429);
      return response(details);
    },
  });
  const result = await module.searchResults("sakamoto", 1);
  assert.equal(result.items[0].title, "Sakamoto Days");
  assert.equal(attempts, 2);
});
