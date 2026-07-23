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

async function loadModule(path, bridges) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout, ...bridges });
  context.globalThis = context;
  new vm.Script(await text(path), { filename: path }).runInContext(context);
  return context;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, body };
}

test("WeebCentral parses direct HTTP fixtures and preserves every chapter", async () => {
  const manifest = await json("modules/weebcentral/manifest.json");
  assert.ok(
    manifest.allowedHosts.includes("*.lowee.us"),
    "WeebCentral serves less-common series from official.lowee.us",
  );

  const fixtures = {
    search: await text("modules/weebcentral/fixtures/search.html"),
    details: await text("modules/weebcentral/fixtures/details.html"),
    chapters: await text("modules/weebcentral/fixtures/chapters.html"),
    images: await text("modules/weebcentral/fixtures/images.html"),
    expected: await json("modules/weebcentral/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/weebcentral/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      calls.push({ url, headers, method, body, options });
      if (url.includes("/search/data?")) return response(fixtures.search);
      if (url.endsWith("/search")) {
        return response([
          '<input name="included_tag" value="Comedy">',
          '<input name="included_tag" value="Horror">',
        ].join("\n"));
      }
      if (url.endsWith("/full-chapter-list")) return response(fixtures.chapters);
      if (url.includes("/images?")) return response(fixtures.images);
      if (url.includes("/series/")) return response(fixtures.details);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.match(calls[0].url, /adult=False/);

  const nicheEnvelope = "__niche__:" + JSON.stringify({
    text: "",
    tags: ["Comedy", "Horror"],
    excludeTags: ["Romance"],
    status: "Ongoing",
  });
  const niche = await module.searchResults(nicheEnvelope, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(niche)), fixtures.expected.search);
  const nicheURL = new URL(calls.at(-1).url);
  assert.deepEqual(nicheURL.searchParams.getAll("included_tag"), ["Comedy", "Horror"]);
  assert.deepEqual(nicheURL.searchParams.getAll("excluded_tag"), ["Romance"]);
  assert.equal(nicheURL.searchParams.get("included_status"), "Ongoing");
  assert.equal(nicheURL.searchParams.get("offset"), "32");
  assert.equal(nicheURL.searchParams.get("adult"), "False");

  const tags = await module.extractTags();
  assert.ok(tags.includes("Comedy"));
  assert.ok(tags.includes("Horror"));

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
});

test("Atsu uses direct APIs, keeps complete chapters, and filters source-marked adult titles", async () => {
  const fixtures = {
    search: await text("modules/atsu/fixtures/search.json"),
    details: await text("modules/atsu/fixtures/details.html"),
    chapters: await text("modules/atsu/fixtures/chapters.json"),
    pages: await text("modules/atsu/fixtures/pages.json"),
    expected: await json("modules/atsu/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/atsu/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(headers.Referer, "https://atsu.moe/");
      calls.push({ url, options });
      if (url.includes("/collections/manga/documents/search?")) return response(fixtures.search);
      if (url.endsWith("/api/search/popular")) {
        return response(JSON.stringify({ items: JSON.parse(fixtures.search).hits.map((hit) => hit.document) }));
      }
      if (url.includes("/api/manga/info?mangaId=fixture-safe")) return response(fixtures.chapters);
      if (url.includes("/api/read/chapter?mangaId=fixture-safe&chapterId=fixture-chapter-1")) return response(fixtures.pages);
      if (url.endsWith("/manga/fixture-safe")) return response(fixtures.details);
      throw new Error(`Unexpected Atsu URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.equal(search.items.some((item) => item.id === "fixture-adult"), false);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(images)), fixtures.expected.images);

  const discovery = await module.discoveryHome();
  assert.ok(discovery.sections.every((section) => section.items.every((item) => item.id !== "fixture-adult")));
  assert.ok(calls.every((call) => call.options.maxBytesHint <= 2 * 1024 * 1024));
});

test("MangaFire uses pagev2, paginates chapters, and keeps scramble markers", async () => {
  const fixtures = {
    search: await json("modules/mangafire/fixtures/search.json"),
    details: await json("modules/mangafire/fixtures/details.json"),
    firstChapters: await json("modules/mangafire/fixtures/chapters-page-1.json"),
    secondChapters: await json("modules/mangafire/fixtures/chapters-page-2.json"),
    chapter: await json("modules/mangafire/fixtures/chapter.json"),
    structuredPages: await json("modules/mangafire/fixtures/pages.json"),
    expected: await json("modules/mangafire/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/mangafire/index.js", {
    pagev2: async (task) => {
      assert.equal(typeof task, "object");
      calls.push(task);
      if (task.url.includes("/browse?keyword=")) {
        assert.equal(task.captureResponseBodies, true);
        assert.equal(task.returnScript, null);
        return {
          finalURL: task.url,
          title: "",
          html: null,
          cookies: {},
          events: [{
            phase: "response",
            url: "https://mangafire.to/api/titles?keyword=fixture&vrf=fixture",
            body: JSON.stringify(fixtures.search),
          }],
          evaluatedData: null,
        };
      }
      assert.equal(task.captureResponseBodies, false);
      assert.equal(task.returnScript, "document.body ? document.body.innerText : ''");
      let payload;
      if (task.url.includes("/api/titles?")) payload = fixtures.search;
      else if (task.url.endsWith("/api/titles/fixture")) payload = fixtures.details;
      else if (task.url.includes("/api/titles/fixture/chapters") && task.url.includes("page=1")) payload = fixtures.firstChapters;
      else if (task.url.includes("/api/titles/fixture/chapters") && task.url.includes("page=2")) payload = fixtures.secondChapters;
      else if (task.url.endsWith("/api/chapters/9001")) payload = fixtures.chapter;
      else if (task.url.endsWith("/api/chapters/9002")) payload = fixtures.structuredPages;
      else throw new Error(`Unexpected URL: ${task.url}`);
      return {
        finalURL: task.url,
        title: "",
        html: null,
        cookies: {},
        events: [],
        evaluatedData: JSON.stringify(payload),
      };
    },
    fetchv2: async () => {
      throw new Error("fetchv2 fallback should not run when pagev2 succeeds");
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(calls.filter((call) => call.url.includes("/chapters?")).length, 2);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  const structured = await module.extractImages("9002");
  assert.equal(structured[1].scrambled, true);
  assert.equal(structured[1].scrambleKey, "fixture-key");
  assert.deepEqual(JSON.parse(JSON.stringify(structured[1].tiles)), { rows: 4, columns: 4, order: [3, 0, 1, 2] });
});

test("Internet Archive exposes only explicitly open, public files", async () => {
  const fixtures = {
    search: await text("modules/internet-archive/fixtures/search.json"),
    open: await text("modules/internet-archive/fixtures/metadata-open.json"),
    closed: await text("modules/internet-archive/fixtures/metadata-closed.json"),
    book: await text("modules/internet-archive/fixtures/text.txt"),
    expected: await json("modules/internet-archive/fixtures/expected.json"),
  };
  const module = await loadModule("modules/internet-archive/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.includes("/advancedsearch.php?")) return response(fixtures.search);
      if (url.includes("/metadata/open-fixture")) return response(fixtures.open);
      if (url.includes("/metadata/closed-fixture")) return response(fixtures.closed);
      if (url.endsWith("/open-fixture/fixture_book_djvu.txt")) return response(fixtures.book);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const resources = await module.extractResources("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(resources)), fixtures.expected.resources);

  const chapters = await module.extractChapters("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const book = await module.extractText(chapters[0].url);
  assert.equal(book, fixtures.book);
  await assert.rejects(
    () => module.extractResources("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
  );
});

test("MangaDex uses fetchv2 against the official API, paginates chapters, excludes non-permitted ratings, and skips externally-hosted/unavailable chapters", async () => {
  const fixtures = {
    search: await json("modules/mangadex/fixtures/search.json"),
    details: await json("modules/mangadex/fixtures/details.json"),
    detailsExcluded: await json("modules/mangadex/fixtures/details-excluded.json"),
    chapters1: await json("modules/mangadex/fixtures/chapters-page-1.json"),
    chapters2: await json("modules/mangadex/fixtures/chapters-page-2.json"),
    images: await json("modules/mangadex/fixtures/images.json"),
    expected: await json("modules/mangadex/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/mangadex/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      calls.push({ url });
      const u = new URL(url);
      if (u.pathname === "/manga" && u.searchParams.get("title") === "fixture") return response(JSON.stringify(fixtures.search));
      if (u.pathname === "/manga/11111111-1111-4111-8111-111111111111") return response(JSON.stringify(fixtures.details));
      if (u.pathname === "/manga/22222222-2222-4222-8222-222222222222") return response(JSON.stringify(fixtures.detailsExcluded));
      if (u.pathname === "/manga/11111111-1111-4111-8111-111111111111/feed") {
        const offset = u.searchParams.get("offset") || "0";
        if (offset === "0") return response(JSON.stringify(fixtures.chapters1));
        if (offset === "500") return response(JSON.stringify(fixtures.chapters2));
        return response(JSON.stringify({ result: "ok", data: [], total: 501, limit: 500, offset: Number(offset) }));
      }
      if (u.pathname === "/at-home/server/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") return response(JSON.stringify(fixtures.images));
      throw new Error(`Unexpected URL: ${url}`);
    },
    reportProgress: async () => ({ ok: true }),
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.equal(search.items.length, 1, "the erotica-rated fixture entry must be excluded");

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);
  await assert.rejects(
    () => module.extractDetails("22222222-2222-4222-8222-222222222222"),
    /excluded by the module content policy/,
  );

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 3, "external-URL and unavailable chapters must be filtered out");
  assert.equal(calls.filter((call) => call.url.includes("/feed")).length, 2, "must follow chapter feed pagination");

  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(images)), fixtures.expected.images);
});

test("MangaKatana parses search, details, complete chapter list, and thzq page images", async () => {
  const fixtures = {
    search: await text("modules/mangakatana/fixtures/search.html"),
    details: await text("modules/mangakatana/fixtures/details.html"),
    chapter: await text("modules/mangakatana/fixtures/chapter.html"),
    expected: await json("modules/mangakatana/fixtures/expected.json"),
  };
  const module = await loadModule("modules/mangakatana/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.includes("?search=") || url.includes("&search=")) return response(fixtures.search);
      if (/\/manga\/fixture-alpha\.1001\/c\d+/.test(url)) return response(fixtures.chapter);
      if (url.includes("/manga/fixture-alpha.1001")) return response(fixtures.details);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[2].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
});

test("MGRead (LikeManga) parses search, details, paginated chapters, and CDN page images", async () => {
  const fixtures = {
    search: await text("modules/mgread/fixtures/search.html"),
    details: await text("modules/mgread/fixtures/details.html"),
    chapter: await text("modules/mgread/fixtures/chapter.html"),
    expected: await json("modules/mgread/fixtures/expected.json"),
  };
  const module = await loadModule("modules/mgread/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.includes("?s=") || url.includes("/?s=")) return response(fixtures.search);
      if (url.includes("/chapter-")) return response(fixtures.chapter);
      if (url.includes("/manga/fixture-alpha")) return response(fixtures.details);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[1].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
});

const singleSeriesModules = [
  "black-clover",
  "kagurabachi",
  "beginning-after-the-end",
  "solo-leveling",
  "gachiakuta",
  "haikyuu",
];

for (const slug of singleSeriesModules) {
  test(`${slug} single-series module parses home chapters and page images`, async () => {
    const fixtures = {
      home: await text(`modules/${slug}/fixtures/home.html`),
      chapter: await text(`modules/${slug}/fixtures/chapter.html`),
      expected: await json(`modules/${slug}/fixtures/expected.json`),
    };
    const module = await loadModule(`modules/${slug}/index.js`, {
      fetchv2: async (url) => {
        assert.equal(typeof url, "string");
        if (/\/manga\/.*chapter/i.test(url)) return response(fixtures.chapter);
        return response(fixtures.home);
      },
    });

    const search = await module.searchResults("zzz-no-match-token", 1);
    assert.equal(search.items.length, 0);

    const openSearch = await module.searchResults("__feed:popular", 1);
    assert.deepEqual(JSON.parse(JSON.stringify(openSearch)), fixtures.expected.search);

    const details = await module.extractDetails(fixtures.expected.details.id);
    assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

    const chapters = await module.extractChapters(fixtures.expected.details.id);
    assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

    const pages = await module.extractImages(chapters[2].id);
    assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  });
}
