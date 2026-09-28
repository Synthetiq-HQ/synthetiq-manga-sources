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
  new vm.Script(await text("modules/ichi-the-witch/index.js"), { filename: "modules/ichi-the-witch/index.js" })
    .runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200, finalUrl = "https://ww2.readichithewitch.com/manga/ichi-the-witch/") {
  return {
    ok: status >= 200 && status < 300,
    status,
    finalUrl,
    body,
    bodyDropped: false,
    text: async () => body,
  };
}

function chapterFixture(fixtures, url) {
  if (url.includes("ichi-the-witch-chapter-96")) return fixtures.chapter96;
  if (url.includes("ichi-the-witch-chapter-48")) return fixtures.chapter48;
  return fixtures.chapter1;
}

test("Ichi the Witch scopes chapters to the series, parses lazy reader pages, and accepts the imgchest CDN", async () => {
  const fixtures = {
    details: await text("modules/ichi-the-witch/fixtures/details.html"),
    chapter1: await text("modules/ichi-the-witch/fixtures/chapter-1.html"),
    chapter48: await text("modules/ichi-the-witch/fixtures/chapter-48.html"),
    chapter96: await text("modules/ichi-the-witch/fixtures/chapter-96.html"),
    expected: await json("modules/ichi-the-witch/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule({
    fetchv2: async (url, headers, method, body, options) => {
      calls.push({ url, headers, method, body, options });
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(options.followRedirects, true);
      assert.equal(options.responseClass, "html");
      if (url.includes("/chapter/ichi-the-witch-chapter-")) {
        assert.equal(headers.Referer, url);
        return response(chapterFixture(fixtures, url), 200, url);
      }
      if (url.includes("/manga/ichi-the-witch/")) return response(fixtures.details);
      throw new Error(`Unexpected Ichi the Witch fixture URL: ${url}`);
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("ichi", 1))), fixtures.expected.search);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("naruto shippuden", 1))),
    { items: [], hasMore: false },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("ichi", 2))), { items: [], hasMore: false });

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 3);

  const images96 = await module.extractImages("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-96/");
  assert.deepEqual(JSON.parse(JSON.stringify(images96)), fixtures.expected.images96);
  assert.ok(
    images96.every((page) => ["cdn.readichithewitch.com", "cdn.imgchest.com"].includes(new URL(page.url).hostname)),
  );
  assert.ok(images96.some((page) => new URL(page.url).hostname === "cdn.readichithewitch.com"));
  assert.ok(images96.some((page) => new URL(page.url).hostname === "cdn.imgchest.com"));

  const images1 = await module.extractImages("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-1/");
  assert.deepEqual(JSON.parse(JSON.stringify(images1)), fixtures.expected.images1);

  const manifest = await json("modules/ichi-the-witch/manifest.json");
  assert.equal(manifest.allowedHosts.includes("cdn.imgchest.com"), true);
  assert.equal(manifest.allowedHosts.includes("cdn.readichithewitch.com"), true);
  assert.ok(images96.every((page) => page.headers.Referer.includes("/chapter/ichi-the-witch-chapter-96/")));
  assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryHome())), {
    sections: [{ id: "latest", title: "Ichi the Witch", items: fixtures.expected.search.items }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("popular", 1))), {
    items: fixtures.expected.search.items,
    hasMore: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryFeed("unknown", 1))), { items: [], hasMore: false });
});

test("Ichi the Witch rejects invalid hosts, challenges, and empty readers", async () => {
  const fixtures = {
    details: await text("modules/ichi-the-witch/fixtures/details.html"),
    empty: await text("modules/ichi-the-witch/fixtures/empty-chapter.html"),
    challenge: await text("modules/ichi-the-witch/fixtures/challenge.html"),
  };
  const module = await loadModule({
    fetchv2: async (url) => {
      if (url.includes("/manga/ichi-the-witch/")) return response(fixtures.details);
      return response(fixtures.empty, 200, url);
    },
  });

  await assert.rejects(
    () => module.extractDetails("https://evil.example/manga/ichi-the-witch/"),
    /Invalid Ichi the Witch series identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://evil.example/chapter/ichi-the-witch-chapter-1/"),
    /Invalid Ichi the Witch chapter identifier/,
  );
  await assert.rejects(
    () => module.extractImages("https://ww2.readichithewitch.com/chapter/ichi-the-witch-chapter-1/"),
    /returned no readable page images/,
  );

  const challengeModule = await loadModule({
    fetchv2: async () => response(fixtures.challenge),
  });
  await assert.rejects(
    () => challengeModule.searchResults("ichi", 1),
    /challenge or access-denied/,
  );
});

test("Ichi the Witch retries one transient catalogue response without using credentials", async () => {
  const details = await text("modules/ichi-the-witch/fixtures/details.html");
  let attempts = 0;
  const module = await loadModule({
    fetchv2: async (url) => {
      assert.equal(url, "https://ww2.readichithewitch.com/manga/ichi-the-witch/");
      attempts += 1;
      if (attempts === 1) return response("temporary upstream failure", 429);
      return response(details);
    },
  });
  const result = await module.searchResults("ichi", 1);
  assert.equal(result.items[0].title, "Ichi the Witch");
  assert.equal(attempts, 2);
});
