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
  new vm.Script(await text("modules/blue-lock/index.js"), { filename: "modules/blue-lock/index.js" })
    .runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200, finalUrl = "https://ww3.bluelockread.com/manga/blue-lock/") {
  return {
    ok: status >= 200 && status < 300,
    status,
    finalUrl,
    body,
    bodyDropped: false,
    text: async () => body,
  };
}

test("Blue Lock scopes chapters to the series, preserves decimal releases, and parses lazy reader pages", async () => {
  const fixtures = {
    home: await text("modules/blue-lock/fixtures/home.html"),
    chapter: await text("modules/blue-lock/fixtures/chapter.html"),
    expected: await json("modules/blue-lock/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule({
    fetchv2: async (url, headers, method, body, options) => {
      calls.push({ url, headers, method, body, options });
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(options.followRedirects, true);
      assert.equal(options.responseClass, "html");
      if (url.includes("/manga/blue-lock/")) return response(fixtures.home);
      if (url.includes("/chapter/blue-lock-chapter-")) {
        assert.equal(headers.Referer, url);
        return response(fixtures.chapter, 200, url);
      }
      throw new Error(`Unexpected Blue Lock fixture URL: ${url}`);
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("blue lock", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture-no-match", 1))), { items: [], hasMore: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("blue lock", 2))), { items: [], hasMore: false });

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map((chapter) => chapter.number))), [12, 10.2, 10.1, 10, 1]);
  assert.equal(new Set(chapters.map((chapter) => chapter.number)).size, chapters.length);
  assert.equal(chapters.some((chapter) => chapter.number === 99 || chapter.number === 500 || chapter.number === 400), false);

  const pages = await module.extractImages("https://ww3.bluelockread.com/chapter/blue-lock-chapter-12/?mode=swipereader");
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.equal(new Set(pages.map((page) => page.url)).size, 3);
  assert.ok(pages.every((page) => new URL(page.url).hostname === "cdn.bluelockread.com"));
  assert.ok(pages.every((page) => page.headers.Referer.includes("/chapter/blue-lock-chapter-12/")));
  assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryHome())), {
    sections: [{ id: "latest", title: "Latest", items: fixtures.expected.search.items }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("popular", 1))), {
    items: fixtures.expected.search.items,
    hasMore: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("unknown", 1))), { items: [], hasMore: false });
});

test("Blue Lock rejects invalid series/chapter hosts, challenges, and empty readers", async () => {
  const fixtures = {
    home: await text("modules/blue-lock/fixtures/home.html"),
    empty: await text("modules/blue-lock/fixtures/chapter-empty.html"),
    challenge: await text("modules/blue-lock/fixtures/challenge.html"),
  };
  const module = await loadModule({
    fetchv2: async (url) => {
      if (url.includes("/manga/blue-lock/")) return response(fixtures.home);
      return response(fixtures.empty, 200, url);
    },
  });

  await assert.rejects(
    () => module.extractDetails("https://evil.example/manga/blue-lock/"),
    /Invalid Blue Lock series identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://evil.example/chapter/blue-lock-chapter-1/"),
    /Invalid Blue Lock chapter identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww3.bluelockread.com/chapter/blue-lock-chapter-1/"),
    /returned no readable page images/,
  );

  const challengeModule = await loadModule({
    fetchv2: async () => response(fixtures.challenge),
  });
  await assert.rejects(
    () => challengeModule.searchResults("blue lock", 1),
    /challenge or access-denied/,
  );
});

test("Blue Lock retries one transient catalogue response without using credentials", async () => {
  const home = await text("modules/blue-lock/fixtures/home.html");
  let attempts = 0;
  const module = await loadModule({
    fetchv2: async (url) => {
      assert.equal(url, "https://bluelockread.com/manga/blue-lock/");
      attempts += 1;
      if (attempts === 1) return response("temporary upstream failure", 429);
      return response(home);
    },
  });
  const result = await module.searchResults("blue lock", 1);
  assert.equal(result.items[0].title, "Blue Lock");
  assert.equal(attempts, 2);
});
