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

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers, body };
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
      if (url.includes("text=challenge")) {
        return response([
          "<title>400 | Weeb Central</title>",
          '<link rel="canonical" href="https://weebcentral.com/400">',
          '<a href="/series/random"><h2>Verification Required</h2></a>',
        ].join("\n"));
      }
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

  const challenge = await module.searchResults("challenge", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(challenge)), { items: [], hasMore: false });

  const home = await module.discoveryHome();
  assert.equal(home.sections.find((section) => section.id === "niche").items.length, 2);
  const nicheFeedCall = calls.find((call) => call.url.includes("sort=Subscribers"));
  assert.ok(nicheFeedCall, "Niche Gems must use a supported low-subscriber sort");
  assert.match(nicheFeedCall.url, /order=Ascending/);
  assert.equal(calls.some((call) => call.url.includes("sort=Oldest")), false);

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
  assert.deepEqual(JSON.parse(JSON.stringify(details)), {
    ...fixtures.expected.details,
    genres: ["Adventure", "Comedy", "Horror"],
  });

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
  assert.equal(search.items.some((item) => item.id === "fixture-novel"), false);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.some((chapter) => chapter.id.includes("fixture-empty")), false);

  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(images)), fixtures.expected.images);

  const discovery = await module.discoveryHome();
  assert.ok(discovery.sections.every((section) => section.items.every((item) => item.id !== "fixture-adult")));
  assert.ok(calls.every((call) => call.options.maxBytesHint <= 2 * 1024 * 1024));
});

test("MangaFire signs requests headlessly via fetchv2 and paginates chapters", async () => {
  const fixtures = {
    search: await json("modules/mangafire/fixtures/search.json"),
    details: await json("modules/mangafire/fixtures/details.json"),
    firstChapters: await json("modules/mangafire/fixtures/chapters-page-1.json"),
    secondChapters: await json("modules/mangafire/fixtures/chapters-page-2.json"),
    chapter: await json("modules/mangafire/fixtures/chapter.json"),
    structuredPages: await json("modules/mangafire/fixtures/pages.json"),
    expected: await json("modules/mangafire/fixtures/expected.json"),
  };
  const homeHTML = [
    "<html><head>",
    '<script>window.__config = "cfg-fixture";</script>',
    '<script>window.__build = "build-fixture";</script>',
    '<link rel="modulepreload" href="https://s.mfcdn.nl/build/mf/assets/polyfill-fixture.js">',
    "</head><body></body></html>",
  ].join("\n");
  const polyfillSource = [
    "const d = (config) => {",
    "  const interceptors = config.interceptors.request;",
    "  interceptors.use(async (spec) => ({ url: spec.url, params: Object.assign({}, spec.params, { vrf: 'fixture' }), headers: {} }));",
    "};",
    "export { d as a, d as i, d as n, d as r, d as t };",
  ].join("\n");
  const calls = [];
  const module = await loadModule("modules/mangafire/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      calls.push(url);
      if (url === "https://mangafire.to/") return response(homeHTML);
      if (url.endsWith("/polyfill-fixture.js")) return response(polyfillSource);
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("vrf"), "fixture", "every API request must carry the vrf signature");
      let payload;
      if (parsed.pathname === "/api/titles") payload = fixtures.search;
      else if (parsed.pathname.endsWith("/api/titles/fixture")) payload = fixtures.details;
      else if (parsed.pathname.endsWith("/api/titles/fixture/chapters") && parsed.searchParams.get("page") === "1") payload = fixtures.firstChapters;
      else if (parsed.pathname.endsWith("/api/titles/fixture/chapters") && parsed.searchParams.get("page") === "2") payload = fixtures.secondChapters;
      else if (parsed.pathname.endsWith("/api/chapters/9001")) payload = fixtures.chapter;
      else if (parsed.pathname.endsWith("/api/chapters/9002")) payload = fixtures.structuredPages;
      else throw new Error(`Unexpected URL: ${url}`);
      return response(JSON.stringify(payload));
    },
    pagev2: async () => {
      throw new Error("pagev2 must not run when headless signing succeeds");
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(calls.filter((url) => url.includes("/chapters?")).length, 2);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  const structured = await module.extractImages("9002");
  assert.equal(structured[1].scrambled, true);
  assert.equal(structured[1].scrambleKey, "fixture-key");
  assert.deepEqual(JSON.parse(JSON.stringify(structured[1].tiles)), { rows: 4, columns: 4, order: [3, 0, 1, 2] });
});

test("MangaFire falls back to pagev2 when headless signing is unavailable", async () => {
  const fixtures = {
    search: await json("modules/mangafire/fixtures/search.json"),
    details: await json("modules/mangafire/fixtures/details.json"),
    firstChapters: await json("modules/mangafire/fixtures/chapters-page-1.json"),
    secondChapters: await json("modules/mangafire/fixtures/chapters-page-2.json"),
    chapter: await json("modules/mangafire/fixtures/chapter.json"),
    structuredPages: await json("modules/mangafire/fixtures/pages.json"),
    expected: await json("modules/mangafire/fixtures/expected.json"),
  };
  fixtures.firstChapters.items.push({ id: 8998, number: 10, name: "Paid Chapter", language: "en", type: "official", locked: true });
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
      if (task.url.includes("/title/fixture-fixture-alpha/chapter/9001")) {
        assert.equal(task.waitForSelector, "#synthetiq-mangafire-reader-complete");
        assert.equal(task.returnScript, "globalThis.__synthetiqMangaFireReaderResult || JSON.stringify({ ok: false, error: 'MangaFire reader did not finish.' })");
        assert.match(task.actionScript, /button\[aria-label\^="Page "\]/);
        assert.match(task.actionScript, /img\.reader-img/);
        return {
          finalURL: task.url,
          title: "",
          html: null,
          cookies: {},
          events: [],
          evaluatedData: JSON.stringify({
            ok: true,
            expected: 4,
            pages: fixtures.expected.images.map((page, index) => ({ number: index + 1, url: page.url })),
          }),
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
      else if (task.url.endsWith("/api/chapters/9003")) payload = { data: { id: 9003, locked: true, pages: fixtures.chapter.data.pages } };
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
      throw new Error("fetchv2 headless signing must fall back to pagev2");
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
  await assert.rejects(() => module.extractImages("9003"), /locked or requires paid access/);
});

test("MangaFire bridges protected browser results as JSON text", async () => {
  const search = await json("modules/mangafire/fixtures/search.json");
  let protectedCall = null;
  const module = await loadModule("modules/mangafire/index.js", {
    fetchv2: async () => {
      throw new Error("headless signer unavailable");
    },
    pagev2: async (task) => {
      if (task.url.includes("/api/titles?")) {
        return {
          finalURL: task.url,
          title: "",
          html: null,
          cookies: {},
          events: [],
          evaluatedData: JSON.stringify({ message: "Missing token." }),
        };
      }

      protectedCall = task;
      return {
        finalURL: task.url,
        title: "",
        html: null,
        cookies: {},
        events: [],
        evaluatedData: JSON.stringify({ ok: true, payloads: [search] }),
      };
    },
  });

  const result = await module.searchResults("fixture", 1);
  assert.ok(result.items.length > 0);
  assert.equal(protectedCall.url, "https://mangafire.to/");
  assert.equal(protectedCall.waitForSelector, "#synthetiq-mangafire-protected-complete");
  assert.match(protectedCall.actionScript, /void \(async \(\) =>/);
  assert.doesNotMatch(protectedCall.returnScript, /async|Promise/);
});

test("Internet Archive format modules expose only safe, supported files", async () => {
  const fixtures = {
    search: await text("modules/internet-archive/fixtures/search.json"),
    open: await text("modules/internet-archive/fixtures/metadata-open.json"),
    statusOpen: await text("modules/internet-archive/fixtures/metadata-status-open.json"),
    closed: await text("modules/internet-archive/fixtures/metadata-closed.json"),
    unsupported: await text("modules/internet-archive/fixtures/metadata-unsupported.json"),
    oversized: await text("modules/internet-archive/fixtures/metadata-oversized.json"),
    book: await text("modules/internet-archive/fixtures/text.txt"),
    scandata: await text("modules/internet-archive/fixtures/scandata.xml"),
    expected: await json("modules/internet-archive/fixtures/expected.json"),
  };
  const fetchv2 = async (url) => {
    assert.equal(typeof url, "string");
    if (url.includes("/advancedsearch.php?")) return response(fixtures.search);
    if (url.includes("/metadata/open-fixture")) return response(fixtures.open);
    if (url.includes("/metadata/status-open-fixture")) return response(fixtures.statusOpen);
    if (url.includes("/metadata/closed-fixture")) return response(fixtures.closed);
    if (url.includes("/metadata/unsupported-fixture")) return response(fixtures.unsupported);
    if (url.includes("/metadata/oversized-fixture")) return response(fixtures.oversized);
    if (url.endsWith("/open-fixture/fixture_book_scandata.xml")) return response(fixtures.scandata);
    if (url.endsWith("/open-fixture/fixture_book_djvu.txt")) return response(fixtures.book);
    throw new Error(`Unexpected URL: ${url}`);
  };

  const scans = await loadModule("modules/internet-archive/index.js", {
    fetchv2,
  });
  const scanSearch = await scans.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(scanSearch)), fixtures.expected.search);
  const scanDetails = await scans.extractDetails("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(scanDetails)), fixtures.expected.details);
  const scanChapters = await scans.extractChapters("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(scanChapters)), fixtures.expected.chapters);
  const scanPages = await scans.extractImages(scanChapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(scanPages)), fixtures.expected.images);
  const statusChapters = await scans.extractChapters("status-open-fixture");
  assert.equal(statusChapters.length, 1);
  assert.equal(statusChapters[0].title, "Full book (3 pages)");
  const statusPages = await scans.extractImages(statusChapters[0].id);
  assert.equal(statusPages.length, 3);
  assert.match(statusPages[0].url, /status_open_fixture_0001\.jp2/);
  assert.match(statusPages[2].url, /status_open_fixture_0003\.jp2/);
  assert.equal(typeof scans.extractText, "undefined");
  await assert.rejects(
    () => scans.extractChapters("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await scans.extractChapters("unsupported-fixture"))), []);

  const publications = await loadModule("modules/internet-archive-publications/index.js", {
    fetchv2,
  });
  const publicationSearch = await publications.searchResults("fixture", 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(publicationSearch.items.map((item) => item.id))),
    ["open-fixture", "rights-fixture"],
  );
  const resources = await publications.extractResources("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(resources.map((resource) => resource.format))), ["pdf", "epub"]);
  assert.ok(resources.every((resource) => !resource.url.includes("Private")));
  assert.ok(resources.every((resource) => resource.headers.Referer.endsWith("/open-fixture")));
  await assert.rejects(
    () => publications.extractResources("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await publications.extractResources("unsupported-fixture"))), []);

  const textModule = await loadModule("modules/internet-archive-text/index.js", {
    fetchv2,
  });
  const textSearch = await textModule.searchResults("fixture", 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(textSearch.items.map((item) => item.id))),
    ["open-fixture", "rights-fixture"],
  );
  const textChapters = await textModule.extractChapters("open-fixture");
  assert.equal(textChapters.length, 1);
  assert.equal(await textModule.extractText(textChapters[0].id), fixtures.book);
  await assert.rejects(
    () => textModule.extractChapters("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(await textModule.extractChapters("unsupported-fixture"))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await textModule.extractChapters("oversized-fixture"))), []);
});

test("Internet Archive rejects invalid direct file references", async () => {
  const module = await loadModule("modules/internet-archive-text/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  await assert.rejects(() => module.extractText("https://archive.org/download/open-fixture/../secret.txt"), /Invalid Internet Archive file path/);
});

test("Internet Archive retries transient text requests and rejects dropped bodies", async () => {
  const fixtures = {
    open: await text("modules/internet-archive/fixtures/metadata-open.json"),
    book: await text("modules/internet-archive/fixtures/text.txt"),
  };
  let attempts = 0;
  const module = await loadModule("modules/internet-archive-text/index.js", {
    setTimeout: (callback) => callback(),
    fetchv2: async (url) => {
      if (url.includes("/metadata/open-fixture")) return response(fixtures.open);
      if (url.endsWith("/open-fixture/fixture_book_djvu.txt")) {
        attempts += 1;
        if (attempts === 1) return response(fixtures.book, 429);
        return response(fixtures.book);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(await module.extractText("https://archive.org/download/open-fixture/fixture_book_djvu.txt"), fixtures.book);
  assert.equal(attempts, 2);

  const dropped = await loadModule("modules/internet-archive-text/index.js", {
    fetchv2: async (url) => {
      if (url.includes("/metadata/open-fixture")) return response(fixtures.open);
      const result = response(fixtures.book);
      result.bodyDropped = true;
      result.dropReason = "maxResponseBytes";
      return result;
    },
  });
  await assert.rejects(
    () => dropped.extractText("https://archive.org/download/open-fixture/fixture_book_djvu.txt"),
    /response was dropped/i,
  );
});

test("MangaKatana parses only the selected title's chapter table and thzq page images", async () => {
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

test("MangaBuddy parses Comizy search, safe details, ordered chapters, and reader pages", async () => {
  const fixtures = {
    search: await text("modules/mangabuddy/fixtures/search.json"),
    details: await text("modules/mangabuddy/fixtures/details.html"),
    chapters: await text("modules/mangabuddy/fixtures/chapters.json"),
    chapter: await text("modules/mangabuddy/fixtures/chapter.html"),
    latest: await text("modules/mangabuddy/fixtures/latest.html"),
    ranking: await text("modules/mangabuddy/fixtures/ranking.html"),
    expected: await json("modules/mangabuddy/fixtures/expected.json"),
  };
  const module = await loadModule("modules/mangabuddy/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      const parsed = new URL(url);
      if (parsed.hostname === "api.comizy.io") {
        assert.equal(options.responseClass, "json");
        if (parsed.pathname === "/titles/search") return response(fixtures.search);
        if (parsed.pathname === "/titles/fixture-safe-id/chapters") return response(fixtures.chapters);
      }
      assert.equal(parsed.hostname, "comizy.io");
      assert.equal(options.responseClass, "html");
      if (parsed.pathname === "/fixture-chronicle") return response(fixtures.details);
      if (parsed.pathname.startsWith("/fixture-chronicle/")) return response(fixtures.chapter);
      if (parsed.pathname === "/fixture-adult") {
        return response(fixtures.details.replace('"isAdult":false', '"isAdult":true'));
      }
      if (parsed.pathname === "/latest") return response(fixtures.latest);
      if (parsed.pathname === "/ranking") return response(fixtures.ranking);
      throw new Error(`Unexpected MangaBuddy URL: ${url}`);
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture", 1))), fixtures.expected.search);
  const details = await module.extractDetails(fixtures.expected.search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.some((chapter) => /1-4/.test(chapter.title)), false, "omnibus range row is omitted");
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(chapters[0].id))), fixtures.expected.images);

  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryHome())), fixtures.expected.discovery);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.discoveryFeed("popular", 1))),
    { items: fixtures.expected.discovery.sections[0].items, hasMore: false },
  );
  await assert.rejects(
    () => module.extractDetails("https://comizy.io/fixture-adult"),
    /marked this title as adult/i,
  );
});

test("MangaBuddy paginates, retries transient API responses, and coalesces shared title loads", async () => {
  const fixtures = {
    search: await text("modules/mangabuddy/fixtures/search.json"),
    details: await text("modules/mangabuddy/fixtures/details.html"),
    chapters: await text("modules/mangabuddy/fixtures/chapters.json"),
    latest: await text("modules/mangabuddy/fixtures/latest.html"),
    ranking: await text("modules/mangabuddy/fixtures/ranking.html"),
  };
  const calls = [];
  let retryAttempts = 0;
  let inFlightHTML = 0;
  let maxInFlightHTML = 0;
  const withMore = (fixture, hasMore) => hasMore
    ? fixture.replace(/"has_next":false/, '"has_next":true')
    : fixture;
  const module = await loadModule("modules/mangabuddy/index.js", {
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    fetchv2: async (url, headers, method, body, options) => {
      const parsed = new URL(url);
      calls.push({ url, headers, method, body, options });
      assert.equal(method, "GET");
      assert.equal(body, null);

      if (parsed.hostname === "api.comizy.io") {
        assert.equal(options.responseClass, "json");
        if (parsed.pathname === "/titles/search") {
          if (parsed.searchParams.get("q") === "retry") {
            retryAttempts += 1;
            if (retryAttempts === 1) return response("temporary upstream failure", 503);
          }
          const payload = JSON.parse(fixtures.search);
          payload.data.pagination = {
            has_next: parsed.searchParams.get("page") === "2",
          };
          return response(JSON.stringify(payload));
        }
        if (parsed.pathname === "/titles/fixture-safe-id/chapters") return response(fixtures.chapters);
      }

      assert.equal(parsed.hostname, "comizy.io");
      assert.equal(options.responseClass, "html");
      inFlightHTML += 1;
      maxInFlightHTML = Math.max(maxInFlightHTML, inFlightHTML);
      try {
        await Promise.resolve();
        if (parsed.pathname === "/fixture-chronicle") return response(fixtures.details);
        if (parsed.pathname === "/latest") {
          return response(withMore(fixtures.latest, parsed.searchParams.has("page")));
        }
        if (parsed.pathname === "/ranking") {
          return response(withMore(fixtures.ranking, parsed.searchParams.has("page")));
        }
      } finally {
        inFlightHTML -= 1;
      }
      throw new Error(`Unexpected MangaBuddy URL: ${url}`);
    },
  });

  const pagedSearch = await module.searchResults({
    text: "fixture",
    tags: ["Fantasy"],
    excludeTags: ["Horror"],
    status: "Ongoing",
  }, 2);
  assert.equal(pagedSearch.items.length, 1);
  assert.equal(pagedSearch.hasMore, true);
  const searchCall = calls.find((call) => {
    const parsed = new URL(call.url);
    return parsed.hostname === "api.comizy.io" && parsed.pathname === "/titles/search"
      && parsed.searchParams.get("page") === "2";
  });
  assert.ok(searchCall, "search page 2 must be requested");
  assert.equal(new URL(searchCall.url).searchParams.get("q"), "fixture");

  const retried = await module.searchResults("retry", 1);
  assert.equal(retried.items.length, 1);
  assert.equal(retryAttempts, 2, "a transient API failure should be retried once");

  const [details, chapters] = await Promise.all([
    module.extractDetails("https://comizy.io/fixture-chronicle"),
    module.extractChapters("https://comizy.io/fixture-chronicle"),
  ]);
  assert.equal(details.title, "Fixture Chronicle");
  assert.equal(chapters.length, 4);
  assert.equal(
    calls.filter((call) => new URL(call.url).pathname === "/fixture-chronicle").length,
    1,
    "concurrent details and chapters must share one title HTML request",
  );
  await module.extractDetails("https://comizy.io/fixture-chronicle");
  assert.equal(
    calls.filter((call) => new URL(call.url).pathname === "/fixture-chronicle").length,
    1,
    "cached title details must not refetch HTML",
  );

  const latestPage = await module.discoveryFeed("latest", 2);
  assert.equal(latestPage.items.length, 1);
  assert.equal(latestPage.hasMore, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("__feed:latest", 2))),
    JSON.parse(JSON.stringify(latestPage)),
  );
  const rankingPage = await module.discoveryFeed("ranking", 2);
  assert.equal(rankingPage.items.length, 1);
  assert.equal(rankingPage.hasMore, true);

  const home = await module.discoveryHome();
  assert.equal(home.sections.length, 2);
  assert.equal(home.sections[0].id, "popular");
  assert.equal(home.sections[1].id, "latest");
  assert.equal(maxInFlightHTML, 2, "home sections should load concurrently");
});

test("MangaBuddy rejects malformed, challenged, out-of-scope, and unsafe data", async () => {
  const fixtures = {
    details: await text("modules/mangabuddy/fixtures/details.html"),
    chapter: await text("modules/mangabuddy/fixtures/chapter.html"),
  };
  const fallbackChapter = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialChapter: {
      pages: [],
      images: ["https://x1.cmzcdn.org/e/fallback.webp"],
    } } },
  })}</script>`;
  const unsafeChapter = fixtures.chapter.replace(
    /https:\/\/x[12]\.cmzcdn\.org\/e\/[^" ]+/g,
    "https://evil.example/e/bad",
  );
  const module = await loadModule("modules/mangabuddy/index.js", {
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    fetchv2: async (url, headers, method, body, options) => {
      const parsed = new URL(url);
      assert.equal(method, "GET");
      assert.equal(body, null);
      if (parsed.hostname === "api.comizy.io" && parsed.pathname === "/titles/search") {
        assert.equal(options.responseClass, "json");
        const query = parsed.searchParams.get("q");
        if (query === "challenge") return response("<html>captcha</html>");
        if (query === "dropped") return { ok: true, status: 200, bodyDropped: true, dropReason: "maxBytesHint" };
        if (query === "malformed") return response(JSON.stringify({ success: true, data: {} }));
        if (query === "not-found") return response("missing", 404);
      }
      assert.equal(parsed.hostname, "comizy.io");
      assert.equal(options.responseClass, "html");
      if (parsed.pathname === "/fixture-empty-title") {
        return response(fixtures.details.replace('"name":"Fixture Chronicle"', '"name":""'));
      }
      if (parsed.pathname === "/fixture-missing") return response("<html><body>missing data</body></html>");
      if (parsed.pathname === "/fixture-chronicle/fallback") return response(fallbackChapter);
      if (parsed.pathname === "/fixture-chronicle/unsafe") return response(unsafeChapter);
      throw new Error(`Unexpected MangaBuddy URL: ${url}`);
    },
  });

  await assert.rejects(() => module.searchResults("challenge"), /challenge page/i);
  await assert.rejects(() => module.searchResults("dropped"), /response was dropped/i);
  await assert.rejects(() => module.searchResults("malformed"), /no item list/i);
  await assert.rejects(() => module.searchResults("not-found"), /HTTP 404/i);
  await assert.rejects(
    () => module.extractDetails("https://evil.example/fixture-chronicle"),
    /Invalid MangaBuddy title identifier/i,
  );
  await assert.rejects(
    () => module.extractDetails("https://comizy.io/latest"),
    /Invalid MangaBuddy title identifier/i,
  );
  await assert.rejects(
    () => module.extractDetails("https://comizy.io/fixture-missing"),
    /did not contain Next data/i,
  );
  await assert.rejects(
    () => module.extractDetails("https://comizy.io/fixture-empty-title"),
    /did not contain a title/i,
  );

  const fallbackImages = await module.extractImages("https://comizy.io/fixture-chronicle/fallback");
  assert.equal(fallbackImages.length, 1);
  assert.equal(fallbackImages[0].url, "https://x1.cmzcdn.org/e/fallback.webp");
  await assert.rejects(
    () => module.extractImages("https://comizy.io/fixture-chronicle/unsafe"),
    /no readable page images/i,
  );
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

test("Poseidon Scans is retired and fails closed with a clear message", async () => {
  const module = await loadModule("modules/poseidon-scans/index.js", {
    fetchv2: async () => {
      throw new Error("retired sources must not fetch the network");
    },
  });

  const retired = /retired/i;
  await assert.rejects(() => module.searchResults("fixture", 1), retired);
  await assert.rejects(() => module.extractDetails("https://poseidon-scans.net/serie/fixture-one/"), retired);
  await assert.rejects(() => module.extractChapters("https://poseidon-scans.net/serie/fixture-one/"), retired);
  await assert.rejects(() => module.extractImages("https://poseidon-scans.net/serie/fixture-one/chapter/44"), retired);
  await assert.rejects(() => module.discoveryHome(), retired);
  await assert.rejects(() => module.discoveryFeed("popular", 1), retired);
});

test("xkcd serves the single series from the official JSON API", async () => {
  const fixtures = {
    latest: await text("modules/xkcd/fixtures/info-latest.json"),
    sample: await text("modules/xkcd/fixtures/info-sample.json"),
    archive: await text("modules/xkcd/fixtures/archive.html"),
    expected: await json("modules/xkcd/fixtures/expected.json"),
  };
  const module = await loadModule("modules/xkcd/index.js", {
    fetchv2: async (url, headers, method, body) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(headers.Referer, "https://xkcd.com/");
      if (url === "https://xkcd.com/info.0.json") return response(fixtures.latest);
      if (url === "https://xkcd.com/100/info.0.json") return response(fixtures.sample);
      if (url === "https://xkcd.com/archive/") return response(fixtures.archive);
      throw new Error(`Unexpected xkcd URL: ${url}`);
    },
  });

  const search = await module.searchResults("xkcd", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const popular = await module.searchResults("__feed:popular", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(popular)), fixtures.expected.search);

  const latest = await module.searchResults("__feed:latest", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(latest)), fixtures.expected.search);

  const emptyQuery = await module.searchResults("", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(emptyQuery)), fixtures.expected.search);

  const noMatch = await module.searchResults("zzz-no-match-token", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(noMatch)), fixtures.expected.noMatch);

  const titleSearch = await module.searchResults("gravity", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(titleSearch)), fixtures.expected.titleSearch);

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(fixtures.expected.details.id);
  assert.equal(chapters.length, fixtures.expected.chapters.count);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[0])), fixtures.expected.chapters.first);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[chapters.length - 1])), fixtures.expected.chapters.last);

  const pages = await module.extractImages(chapters[chapters.length - 100].id);
  assert.equal(chapters[chapters.length - 100].id, "https://xkcd.com/100/");
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const home = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(home)), {
    sections: [{ id: "latest", title: "Latest", items: fixtures.expected.search.items }],
  });
});

const singleSeriesModules = [
  "black-clover",
  "kagurabachi",
  "beginning-after-the-end",
  "solo-leveling",
  "gachiakuta",
  "haikyuu",
  "onepiece-manga-online",
];

test("One Piece preserves decimal chapters, excludes unrelated links, and rejects unavailable pages", async () => {
  const fixtures = {
    home: await text("modules/onepiece-manga-online/fixtures/home.html"),
    chapter: await text("modules/onepiece-manga-online/fixtures/chapter.html"),
    emptyChapter: await text("modules/onepiece-manga-online/fixtures/chapter-empty.html"),
    challenge: await text("modules/onepiece-manga-online/fixtures/challenge.html"),
    expected: await json("modules/onepiece-manga-online/fixtures/expected.json"),
  };
  const module = await loadModule("modules/onepiece-manga-online/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (/\/manga\//i.test(url)) return response(fixtures.chapter);
      return response(fixtures.home);
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("one piece", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractDetails(fixtures.expected.details.id))), fixtures.expected.details);
  const chapters = await module.extractChapters(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.some((chapter) => chapter.number === 1054.5), true);
  assert.equal(chapters.some((chapter) => chapter.number === 99), false);
  assert.equal(chapters.filter((chapter) => chapter.number === 1000).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractImages(chapters[2].id))), fixtures.expected.images);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.discoveryHome())), {
    sections: [{ id: "latest", title: "Latest", items: fixtures.expected.search.items }],
  });

  const emptyChapterModule = await loadModule("modules/onepiece-manga-online/index.js", {
    fetchv2: async (url) => response(/\/manga\//i.test(url) ? fixtures.emptyChapter : fixtures.home),
  });
  await assert.rejects(
    () => emptyChapterModule.extractImages(fixtures.expected.chapters[0].id),
    /chapter 1192 is not available yet/i,
  );

  const emptyHomeModule = await loadModule("modules/onepiece-manga-online/index.js", {
    fetchv2: async () => response("<html><body></body></html>"),
  });
  await assert.rejects(
    () => emptyHomeModule.extractChapters(fixtures.expected.details.id),
    /returned no owned chapter links/i,
  );

  const gateTopModule = await loadModule("modules/onepiece-manga-online/index.js", {
    fetchv2: async (url) => {
      if (url.includes("one-piece-chapter-1192/")) return response(fixtures.emptyChapter);
      if (/\/manga\//i.test(url)) return response(fixtures.chapter);
      return response(fixtures.home);
    },
  });
  const trimmedChapters = await gateTopModule.extractChapters(fixtures.expected.details.id);
  assert.equal(trimmedChapters.some((chapter) => chapter.number === 1192), false);
  assert.equal(trimmedChapters[0].number, 1054.5);
  assert.equal(trimmedChapters.length, 3);

  const challengeModule = await loadModule("modules/onepiece-manga-online/index.js", {
    fetchv2: async () => response(fixtures.challenge),
  });
  await assert.rejects(
    () => challengeModule.searchResults("one piece", 1),
    /challenge or access-denied/i,
  );
});

test("Attack on Titan collapses aliases, orders chapters, and de-duplicates lazy reader images", async () => {
  const fixtures = {
    home: await text("modules/attack-on-titan/fixtures/home.html"),
    chapter: await text("modules/attack-on-titan/fixtures/chapter.html"),
    emptyChapter: await text("modules/attack-on-titan/fixtures/chapter-empty.html"),
    challenge: await text("modules/attack-on-titan/fixtures/challenge.html"),
    expected: await json("modules/attack-on-titan/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/attack-on-titan/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(options.followRedirects, true);
      assert.equal(options.responseClass, "html");
      calls.push(url);
      if (/\/manga\/.*chapter/i.test(url)) return response(fixtures.chapter);
      return response(fixtures.home);
    },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("attack titan", 1))),
    fixtures.expected.search,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("shingeki no kyojin", 1))),
    fixtures.expected.search,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("__feed:popular", 1))),
    fixtures.expected.search,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.searchResults("zzz-no-match-token", 1))),
    { items: [], hasMore: false },
  );

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 5);
  assert.equal(chapters[0].number, 139.5);
  assert.equal(chapters[0].title, "Attack on Titan Chapter 139.5");
  assert.equal(chapters.some((chapter) => chapter.title.includes("Chapter 140")), false);
  assert.equal(new Set(chapters.map((chapter) => chapter.number)).size, chapters.length);

  const pages = await module.extractImages(chapters[2].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.equal(new Set(pages.map((page) => page.url)).size, 4);
  assert.ok(pages.every((page) => /^https:\/\/cdn\.(mangagoa\.xyz|readkakegurui\.com)\//.test(page.url)));
  assert.ok(calls.every((url) => !url.includes("evil.example")));

  const emptyChapterModule = await loadModule("modules/attack-on-titan/index.js", {
    fetchv2: async (url) => response(
      /\/manga\/.*chapter/i.test(url) ? fixtures.emptyChapter : fixtures.home,
    ),
  });
  await assert.rejects(
    () => emptyChapterModule.extractImages(chapters[2].id),
    /chapter 138 is not available yet/i,
  );

  const challengeModule = await loadModule("modules/attack-on-titan/index.js", {
    fetchv2: async () => response(fixtures.challenge),
  });
  await assert.rejects(
    () => challengeModule.searchResults("attack titan", 1),
    /challenge or access-denied/i,
  );
  await assert.rejects(
    () => module.extractImages("https://evil.example/manga/attack-on-titan-chapter-1/"),
    /invalid Attack on Titan chapter identifier/i,
  );
});

test("SNAFU Comics parses catalogue, archive pages, and comic images", async () => {
  const fixtures = {
    allComics: await text("modules/snafu/fixtures/all-comics.html"),
    home: await text("modules/snafu/fixtures/home.html"),
    archive: await text("modules/snafu/fixtures/archive.html"),
    page: await text("modules/snafu/fixtures/page.html"),
    expected: await json("modules/snafu/fixtures/expected.json"),
  };
  const module = await loadModule("modules/snafu/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.endsWith("/all-comics")) return response(fixtures.allComics);
      if (url === "https://www.snafu-comics.com/" || url.endsWith("snafu-comics.com")) {
        return response(fixtures.home);
      }
      if (url.includes("/archive")) return response(fixtures.archive);
      if (url.includes("/powerpuffgirls/")) return response(fixtures.page);
      if (url.endsWith("/powerpuffgirls")) return response(fixtures.archive);
      throw new Error(`Unexpected SNAFU URL: ${url}`);
    },
  });

  const search = await module.searchResults("powerpuff", 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, "Powerpuff Girls D");

  const popular = await module.searchResults("__feed:popular", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(popular)), fixtures.expected.search);

  const details = await module.extractDetails("https://www.snafu-comics.com/powerpuffgirls");
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters("https://www.snafu-comics.com/powerpuffgirls");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const home = await module.discoveryHome();
  assert.ok(home.sections.some((s) => s.id === "popular" && s.items.length >= 1));
  assert.ok(home.sections.some((s) => s.id === "latest" && s.items.length >= 1));
});

test("Comic Growl parses search, series details, paginated chapters, and scrambled viewer pages", async () => {
  const fixtures = {
    home: await text("modules/comicgrowl/fixtures/home.html"),
    search: await text("modules/comicgrowl/fixtures/search.html"),
    series: await text("modules/comicgrowl/fixtures/series.html"),
    seriesPage1: await text("modules/comicgrowl/fixtures/series-page-1.html"),
    episode: await text("modules/comicgrowl/fixtures/episode.html"),
    contents: await text("modules/comicgrowl/fixtures/contents.json"),
    expected: await json("modules/comicgrowl/fixtures/expected.json"),
  };
  const module = await loadModule("modules/comicgrowl/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      const u = String(url);
      if (u === "https://comic-growl.com/" || u === "https://comic-growl.com") return response(fixtures.home);
      if (u.startsWith("https://comic-growl.com/search")) return response(fixtures.search);
      if (u === "https://comic-growl.com/series/02674f27ad178") return response(fixtures.series);
      if (u === "https://comic-growl.com/series/02674f27ad178/1") return response(fixtures.seriesPage1);
      if (u === "https://comic-growl.com/episodes/4c599dfd47b2f") return response(fixtures.episode);
      if (u.includes("/api/book/contentsInfo")) return response(fixtures.contents, 200, "application/json");
      throw new Error(`Unexpected Comic Growl URL: ${u}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails(search.items[1].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, fixtures.expected.chapters.count);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[0])), fixtures.expected.chapters.first);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[chapters.length - 1])), fixtures.expected.chapters.last);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.equal(pages[0].scrambled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(pages[0].tiles)), fixtures.expected.images[0].tiles);

  const home = await module.discoveryHome();
  assert.ok(home.sections.some((s) => s.id === "popular" && s.items.length >= 1));
  assert.ok(home.sections.some((s) => s.id === "latest" && s.items.length >= 1));
});

test("Comic Fury parses search profiles, external archive chapters, and comic page images", async () => {
  const fixtures = {
    search: await text("modules/comicfury/fixtures/search.html"),
    details: await text("modules/comicfury/fixtures/details.html"),
    archive: await text("modules/comicfury/fixtures/archive.html"),
    page1: await text("modules/comicfury/fixtures/page-1.html"),
    page2: await text("modules/comicfury/fixtures/page-2.html"),
    expected: await json("modules/comicfury/fixtures/expected.json"),
  };
  const module = await loadModule("modules/comicfury/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      assert.equal(method, "GET");
      assert.equal(body, null);
      const u = String(url);
      if (u.includes("/search.php")) return response(fixtures.search);
      if (u.includes("/comicprofile.php")) return response(fixtures.details);
      if (u.includes("/goto.php")) {
        return {
          status: 302,
          ok: true,
          headers: { location: "https://gleaminghearts.thecomicseries.com" },
          finalUrl: u,
          body: "",
          bodyDropped: false,
          dropReason: null,
          bodyBytes: 0,
          contentType: "text/html",
          error: null,
          text: async () => "",
          json: async () => { throw new Error("not json"); },
        };
      }
      if (u.includes("/archive/")) return response(fixtures.archive);
      if (u.includes("/comics/1/")) return response(fixtures.page1);
      if (u.includes("/comics/2/")) return response(fixtures.page2);
      if (u.match(/\/comics\/([0-9]+)\//)) return response(fixtures.page1);
      throw new Error(`Unexpected Comic Fury URL: ${u}`);
    },
  });

  const search = await module.searchResults("gleaming", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, fixtures.expected.chapters.count);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[0])), fixtures.expected.chapters.first);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[chapters.length - 1])), fixtures.expected.chapters.last);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const home = await module.discoveryHome();
  assert.ok(home.sections.some((s) => s.id === "popular" && s.items.length >= 1));
});

test("Comic Fury parses archive layout variants and the /archive/comics fallback", async () => {
  const fixtures = {
    chapterTable: await text("modules/comicfury/fixtures/archive-chapter-title-table.html"),
    headTable: await text("modules/comicfury/fixtures/archive-chapterhead-table.html"),
    listing: await text("modules/comicfury/fixtures/archive-comics-listing.html"),
    landing: await text("modules/comicfury/fixtures/archive-landing.html"),
    page1: await text("modules/comicfury/fixtures/page-1.html"),
  };
  const calls = [];
  const module = await loadModule("modules/comicfury/index.js", {
    fetchv2: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://chaptertitle.thecomicseries.com/")) {
        if (u.endsWith("/archive/comics")) return response(fixtures.listing);
        if (u.endsWith("/archive/")) return response(fixtures.chapterTable);
      }
      if (u.startsWith("https://headtable.thecomicseries.com/")) {
        if (u.endsWith("/archive/")) return response(fixtures.headTable);
        if (u.includes("/comics/pl/")) return response(fixtures.page1);
      }
      if (u.startsWith("https://landing.thecomicseries.com/")) {
        if (u.endsWith("/archive/comics")) return response(fixtures.listing);
        if (u.endsWith("/archive/")) return response(fixtures.landing);
      }
      if (u.startsWith("https://customfury.example/")) {
        if (u.endsWith("/archive/")) return response(fixtures.chapterTable);
      }
      throw new Error(`Unexpected Comic Fury URL: ${u}`);
    },
  });

  // Grouped chapter_title tables (pages link to /comics/<N>/).
  const chapterTitle = await module.extractChapters("https://chaptertitle.thecomicseries.com/");
  assert.equal(chapterTitle.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(chapterTitle.map((c) => c.title))), ["Prologue", "Chapter Three"]);
  assert.deepEqual(JSON.parse(JSON.stringify(chapterTitle.map((c) => c.number))), [1, 2]);

  // Headed archive tables (chapterhead h2 + /comics/pl/<id>/ rows).
  const headTable = await module.extractChapters("https://headtable.thecomicseries.com/");
  assert.equal(headTable.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(headTable.map((c) => c.title))), ["Part 1", "Part 2"]);
  const headImages = await module.extractImages(headTable[0].id);
  assert.ok(headImages.length >= 1, "headed-table pages must resolve to images");
  assert.ok(calls.some((u) => u.includes("/comics/pl/2641725/")), "page URLs come from the pl/ rows");

  // /archive/ landing pages fall back to the /archive/comics listing.
  const fallback = await module.extractChapters("https://landing.thecomicseries.com/");
  assert.equal(fallback.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.map((c) => c.title))), ["OFFICIAL I HOPE SO ETSY STORE", "Chapter 1 - Soul of a Survivor"]);
  assert.ok(
    calls.some((u) => u === "https://landing.thecomicseries.com/archive/comics"),
    "expected the /archive/comics listing to be fetched as a fallback",
  );

  // Resolved domain roots outside the known host list (custom domains).
  const custom = await module.extractChapters("https://customfury.example/");
  assert.equal(custom.length, 2);
  assert.equal(custom[0].id, "https://customfury.example/archive/#chapter-1");
});

test("Dragon Ball Multiverse single-series module parses accueil chapters and page images", async () => {
  const fixtures = {
    accueil: await text("modules/dbmultiverse/fixtures/accueil.html"),
    page: await text("modules/dbmultiverse/fixtures/page-sample.html"),
    expected: await json("modules/dbmultiverse/fixtures/expected.json"),
  };
  const module = await loadModule("modules/dbmultiverse/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.endsWith("/en/accueil.html")) return response(fixtures.accueil);
      if (/\/en\/page-\d+\.html/.test(url)) return response(fixtures.page);
      throw new Error(`Unexpected DBM URL: ${url}`);
    },
  });

  const noMatch = await module.searchResults("zzz-no-match-token", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(noMatch)), { items: [], hasMore: false });

  for (const query of ["dragon ball", "Multiverse", "dbm", "", "__feed:popular", "__feed:latest"]) {
    const search = await module.searchResults(query, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  }

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(fixtures.expected.details.id);
  assert.equal(chapters.length, fixtures.expected.chapters.count);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[0])), fixtures.expected.chapters.first);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters[chapters.length - 1])), fixtures.expected.chapters.last);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const home = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(home)), {
    sections: [{ id: "latest", title: "Latest", items: fixtures.expected.search.items }],
  });
});

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
        if (/\/manga\/.*chapter/i.test(url) || /-chapter-\d/i.test(url)) return response(fixtures.chapter);
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

test("The Beginning After The End parses alternate slug shapes and trims unreadable chapters", async () => {
  const fixtures = {
    home: await text("modules/beginning-after-the-end/fixtures/home.html"),
    chapter: await text("modules/beginning-after-the-end/fixtures/chapter.html"),
    empty: await text("modules/beginning-after-the-end/fixtures/chapter-empty.html"),
    expected: await json("modules/beginning-after-the-end/fixtures/expected.json"),
  };
  const module = await loadModule("modules/beginning-after-the-end/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (/beginning-after-the-end-chapter-1\/$/i.test(url)) return response(fixtures.empty);
      if (/-chapter-\d/i.test(url)) return response(fixtures.chapter);
      return response(fixtures.home);
    },
  });

  const chapters = await module.extractChapters(fixtures.expected.details.id);
  assert.equal(chapters.length, 4);
  assert.equal(chapters.some((chapter) => chapter.number === 1), false, "unreadable chapter 1 is trimmed from the tail");
  assert.equal(chapters[chapters.length - 1].number, 2);
  assert.ok(chapters[0].id.includes("/uncategorized/"), "uncategorized chapter links are accepted");
  assert.ok(chapters.some((chapter) => chapter.number === 2.5), "dash-decimal chapter slugs parse as decimals");
});

test("NovelFire parses search, details, complete chapters, and chapter text", async () => {
  const fixtures = {
    search: await text("modules/novelfire/fixtures/search.html"),
    searchPage2: await text("modules/novelfire/fixtures/search-page-2.html"),
    home: await text("modules/novelfire/fixtures/home.html"),
    details: await text("modules/novelfire/fixtures/details.html"),
    unsafeDetails: await text("modules/novelfire/fixtures/details-unsafe.html"),
    chapters: await text("modules/novelfire/fixtures/chapters.html"),
    chaptersPage2: await text("modules/novelfire/fixtures/chapters-page-2.html"),
    chapter: await text("modules/novelfire/fixtures/chapter.html"),
  };
  const module = await loadModule("modules/novelfire/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(headers.Referer, "https://novelfire.net/");
      assert.equal(options.followRedirects, true);
      if (url.includes("/search?keyword=fixture&page=2")) return response(fixtures.searchPage2);
      if (url.includes("/search?keyword=fixture")) return response(fixtures.search);
      if (url.endsWith("/genre-all/sort-popular/status-all/all-novel")) return response(fixtures.home);
      if (url.endsWith("/genre-all/sort-new/status-all/all-novel")) return response(fixtures.home);
      if (url.endsWith("/book/fixture-chronicle/chapters")) return response(fixtures.chapters);
      if (url.endsWith("/book/fixture-chronicle/chapters?page=2")) return response(fixtures.chaptersPage2);
      if (url.endsWith("novelphoenix.com/novel/fixture-chronicle/chapter-1")) return response(fixtures.chapter);
      if (url.endsWith("/book/fixture-unsafe")) return response(fixtures.unsafeDetails);
      if (url.endsWith("/book/fixture-chronicle")) return response(fixtures.details);
      throw new Error(`Unexpected NovelFire URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), {
    items: [{
      id: "fixture-chronicle",
      href: "https://novelfire.net/book/fixture-chronicle",
      title: "Fixture Chronicle",
      image: "https://novelfire.net/server-1/fixture-chronicle.jpg",
      chapterCount: 12,
    }],
    hasMore: true,
  });

  const nextSearch = await module.searchResults("fixture", 2);
  assert.deepEqual(JSON.parse(JSON.stringify(nextSearch)), {
    items: [{
      id: "fixture-sequel",
      href: "https://novelfire.net/book/fixture-sequel",
      title: "Fixture Sequel",
      image: "https://novelfire.net/server-1/fixture-sequel.jpg",
      chapterCount: 8,
    }],
    hasMore: false,
  });

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), {
    id: "fixture-chronicle",
    href: "https://novelfire.net/book/fixture-chronicle",
    title: "Fixture Chronicle",
    author: "Sample Author",
    status: "Ongoing",
    image: "https://novelfire.net/server-1/fixture-chronicle.jpg",
    description: "A synthetic fixture description.",
    genres: ["Fantasy"],
  });
  await assert.rejects(() => module.extractDetails("fixture-unsafe"), /safety filter/i);

  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].number, 1);
  assert.equal(chapters[1].number, 2);

  const chapter = await module.extractText(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapter)), {
    title: "Chapter 1",
    content: "Fixture paragraph one.\n\nFixture paragraph two; just a moment passed.",
  });

  const home = await module.discoveryHome();
  assert.equal(home.sections.length, 2);
  assert.equal(home.sections[0].items.length, 1);
});

test("MangaWorld parses archive search, embedded details, chapter list, and reader page images", async () => {
  const fixtures = {
    search: await text("modules/mangaworld/fixtures/search.html"),
    details: await text("modules/mangaworld/fixtures/details.html"),
    reader: await text("modules/mangaworld/fixtures/chapter.html"),
    home: await text("modules/mangaworld/fixtures/home.html"),
    expected: await json("modules/mangaworld/fixtures/expected.json"),
  };
  const module = await loadModule("modules/mangaworld/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (/\/read\//.test(url)) return response(fixtures.reader);
      if (/\/archive\?/.test(url)) return response(fixtures.search);
      if (/mangaworld\.mx\/?$/.test(url)) return response(fixtures.home);
      return response(fixtures.details);
    },
  });

  const search = await module.searchResults("one piece", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const feed = await module.searchResults("__feed:popular", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(feed)), fixtures.expected.feed);

  const seriesURL = "https://www.mangaworld.mx/manga/1708/one-piece";
  const details = await module.extractDetails(seriesURL);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);
  assert.equal(details.title, "One Piece");
  assert.ok(details.chapters === undefined || Array.isArray(details.genres));

  const chapters = await module.extractChapters(seriesURL);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, fixtures.expected.chapters.length);
  assert.equal(chapters[0].number, 1191);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.ok(pages.length > 10, "chapter pages parsed");
  assert.ok(pages.every((p) => /^https:\/\/cdn\.mangaworld\.mx\/chapters\//.test(p.url)));

  const discovery = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(discovery)), fixtures.expected.discovery);
  assert.ok(discovery.sections.length >= 2, "home rails parsed");
});

test("YSK Comics parses JSON search, detail chapters, and CDN page images", async () => {
  const fixtures = {
    search: await text("modules/yskcomics/fixtures/search.json"),
    details: await text("modules/yskcomics/fixtures/details.json"),
    chapters: await text("modules/yskcomics/fixtures/chapters.json"),
    images: await text("modules/yskcomics/fixtures/images.json"),
    expected: await json("modules/yskcomics/fixtures/expected.json"),
  };
  const calls = [];
  const module = await loadModule("modules/yskcomics/index.js", {
    fetchv2: async (url) => {
      calls.push(url);
      assert.equal(typeof url, "string");
      if (url.includes("/search-comics-home")) return response(fixtures.search);
      if (url.includes("/chapters/") && url.includes("/images")) return response(fixtures.images);
      if (url.includes("/comics/") && url.includes("/chapters")) return response(fixtures.chapters);
      if (url.includes("/comics/")) return response(fixtures.details);
      return response(fixtures.details);
    },
  });

  const search = await module.searchResults("moon knight", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails("moon-knight-2016");
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const requestCount = calls.length;
  const shortSearch = await module.searchResults("ab", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(shortSearch)), { items: [], hasMore: false });
  assert.equal(calls.length, requestCount, "short search terms must not hit the network");
});

test("MangaBall is retired and fails closed with a clear message", async () => {
  const module = await loadModule("modules/mangaball/index.js", {
    fetchv2: async () => {
      throw new Error("retired sources must not fetch the network");
    },
  });

  const retired = /retired/i;
  await assert.rejects(() => module.searchResults("fixture", 1), retired);
  await assert.rejects(() => module.extractDetails("https://mangaball.net/title-detail/fixture-ball-aaaaaaaaaaaaaaaaaaaaaaaa/"), retired);
  await assert.rejects(() => module.extractChapters("https://mangaball.net/title-detail/fixture-ball-aaaaaaaaaaaaaaaaaaaaaaaa/"), retired);
  await assert.rejects(() => module.extractImages("https://mangaball.net/chapter-detail/fixture/"), retired);
  await assert.rejects(() => module.discoveryHome(), retired);
  await assert.rejects(() => module.discoveryFeed("popular", 1), retired);
});

test("Comix uses browser-owned pagination and lazy reader evidence", async () => {
  const fixtures = {
    home: await text("modules/comix/fixtures/home.html"),
    search: await json("modules/comix/fixtures/search.json"),
    details: await text("modules/comix/fixtures/details.html"),
    chapters: await json("modules/comix/fixtures/chapters.json"),
    pages: await json("modules/comix/fixtures/pages.json"),
    expected: await json("modules/comix/fixtures/expected.json"),
  };
  const calls = [];
  const progress = [];
  const module = await loadModule("modules/comix/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(method, "GET");
      assert.equal(body, null);
      assert.equal(headers.Referer, "https://comix.to/");
      assert.equal(options.responseClass, "html");
      calls.push({ kind: "fetchv2", url });
      if (url === "https://comix.to/") return response(fixtures.home);
      if (url.includes("/title/fx123-fixture-alpha")) return response(fixtures.details);
      throw new Error(`Unexpected Comix fetch URL: ${url}`);
    },
    pagev2: async (task) => {
      assert.equal(new URL(task.url).hostname, "comix.to");
      assert.equal(task.captureResponseBodies, false);
      calls.push({ kind: "pagev2", task });
      if (task.url.includes("/browse?")) {
        assert.match(task.returnScript, /lrow__title-link/);
        return { evaluatedData: JSON.stringify(fixtures.search), events: [], cookies: {} };
      }
      if (/\/title\/fx123-fixture-alpha\/\d+-chapter-/i.test(task.url)) {
        assert.match(task.actionScript, /synthetiq-comix-images-complete/);
        return { evaluatedData: JSON.stringify(fixtures.pages), events: [], cookies: {} };
      }
      if (task.url.includes("/title/fx123-fixture-alpha")) {
        assert.match(task.actionScript, /synthetiq-comix-chapters-complete/);
        assert.match(task.actionScript, /button\[aria-label/);
        return { evaluatedData: JSON.stringify(fixtures.chapters), events: [], cookies: {} };
      }
      throw new Error(`Unexpected Comix page URL: ${task.url}`);
    },
    reportProgress: async (payload) => {
      progress.push(payload);
      return { ok: true };
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture", 1))), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture", 2))), { items: [], hasMore: false });

  const discovery = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(discovery)), fixtures.expected.discovery);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.discoveryFeed("latest", 1))),
    { items: fixtures.expected.discovery.sections[1].items, hasMore: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await module.discoveryFeed("latest", 2))),
    { items: fixtures.expected.search.items, hasMore: false },
  );
  const discoveryPageCall = calls.find((call) => call.kind === "pagev2" && call.task.url.endsWith("/browse?page=2"));
  assert.ok(discoveryPageCall);
  assert.doesNotMatch(discoveryPageCall.task.returnScript, /slice\(/, "discovery pages are not arbitrarily trimmed");

  const details = await module.extractDetails(fixtures.expected.details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);
  const detailCallCount = calls.filter((call) => call.kind === "fetchv2" && call.url.includes("/title/fx123-fixture-alpha")).length;
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractDetails(details.id))), fixtures.expected.details);
  assert.equal(
    calls.filter((call) => call.kind === "fetchv2" && call.url.includes("/title/fx123-fixture-alpha")).length,
    detailCallCount,
    "details are reused during the short cache window",
  );

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.length, 3, "duplicate chapter releases are deduplicated by URL, not number");
  assert.equal(chapters[0].number, 12.5, "decimal chapter numbers remain sortable");
  assert.equal(progress[0].stage, "chapters");
  const chapterCallCount = calls.filter((call) => call.kind === "pagev2" && call.task.waitForSelector === "#synthetiq-comix-chapters-complete").length;
  assert.deepEqual(JSON.parse(JSON.stringify(await module.extractChapters(details.id))), fixtures.expected.chapters);
  assert.equal(
    calls.filter((call) => call.kind === "pagev2" && call.task.waitForSelector === "#synthetiq-comix-chapters-complete").length,
    chapterCallCount,
    "chapters are reused during the short cache window",
  );
  const chapterCall = calls.find((call) => call.kind === "pagev2" && call.task.waitForSelector === "#synthetiq-comix-chapters-complete");
  assert.match(chapterCall.task.actionScript, /iframe/);
  assert.match(chapterCall.task.actionScript, /Promise\.all/);
  assert.match(chapterCall.task.actionScript, /Last page/);
  assert.match(chapterCall.task.actionScript, /marker\.hidden = false/);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.ok(pages.every((page) => {
    const host = new URL(page.url).hostname;
    return host.endsWith(".wowpic1.store") || host.endsWith(".wowpic2.store");
  }));
  const imageCall = calls.find((call) => call.kind === "pagev2" && call.task.waitForSelector === "#synthetiq-comix-images-complete");
  assert.ok(imageCall);
  assert.match(imageCall.task.actionScript, /wowpic1\.store/);
  assert.match(imageCall.task.actionScript, /wowpic2\.store/);
  await assert.rejects(
    () => module.extractDetails("https://example.invalid/title/fx123-fixture-alpha"),
    /Invalid Comix title identifier/,
  );
});

test("Asura Scans uses public API data, filters locked chapters, and preserves page order", async () => {
  const fixtures = {
    search: await text("modules/asura-scans/fixtures/search.json"),
    searchPage2: await text("modules/asura-scans/fixtures/search-page-2.json"),
    details: await text("modules/asura-scans/fixtures/details.json"),
    chapters: await text("modules/asura-scans/fixtures/chapters.html"),
    chapter: await text("modules/asura-scans/fixtures/chapter.json"),
    chapter3: await text("modules/asura-scans/fixtures/chapter-3.json"),
    locked: await text("modules/asura-scans/fixtures/locked-chapter.json"),
    expected: await json("modules/asura-scans/fixtures/expected.json"),
  };
  const invalidPageFixture = JSON.parse(fixtures.chapter);
  invalidPageFixture.data.chapter.number = 2;
  invalidPageFixture.data.chapter.pages = invalidPageFixture.data.chapter.pages.map((page) => ({
    ...page,
    url: page.url.replace("/1/", "/2/"),
  }));
  invalidPageFixture.data.chapter.pages[1].url = "https://outside.invalid/not-an-asura-page.webp";
  const differentSeriesFixture = JSON.parse(fixtures.chapter);
  differentSeriesFixture.data.chapter.number = 5;
  differentSeriesFixture.data.series.public_url = "/comics/different-series-08677664";
  differentSeriesFixture.data.chapter.pages = differentSeriesFixture.data.chapter.pages.map((page) => ({
    ...page,
    url: page.url.replace("/1/", "/5/"),
  }));
  const calls = [];
  const module = await loadModule("modules/asura-scans/index.js", {
    fetchv2: async (url, headers, method, body) => {
      assert.equal(method, "GET");
      assert.equal(body, null);
      calls.push({ url: String(url), headers });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/search") {
        if (parsed.searchParams.get("q") === "challenge") return response("<title>Just a moment...</title>");
        return response(parsed.searchParams.get("offset") === "20" ? fixtures.searchPage2 : fixtures.search);
      }
      if (parsed.pathname === "/api/series" && parsed.search) return response(fixtures.search);
      if (parsed.pathname === "/api/series/fixture-chronicle-08677664/chapters/4") return response(fixtures.locked);
      if (parsed.pathname === "/api/series/fixture-chronicle-08677664/chapters/3") return response(fixtures.chapter3);
      if (parsed.pathname === "/api/series/fixture-chronicle-08677664/chapters/2") return response(JSON.stringify(invalidPageFixture));
      if (parsed.pathname === "/api/series/fixture-chronicle-08677664/chapters/5") return response(JSON.stringify(differentSeriesFixture));
      if (parsed.pathname.startsWith("/api/series/fixture-chronicle-08677664/chapters/")) return response(fixtures.chapter);
      if (parsed.pathname === "/api/series/fixture-chronicle-08677664") return response(fixtures.details);
      if (parsed.pathname === "/comics/fixture-chronicle-08677664") return response(fixtures.chapters);
      throw new Error(`Unexpected Asura Scans fixture URL: ${url}`);
    },
  });

  const manifest = await json("modules/asura-scans/manifest.json");
  assert.deepEqual(manifest.allowedHosts, ["asurascans.com", "api.asurascans.com", "cdn.asurascans.com"]);

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);
  assert.deepEqual(JSON.parse(JSON.stringify(await module.searchResults("fixture", 2))), fixtures.expected.page2);
  await assert.rejects(() => module.searchResults("challenge", 1), /browser challenge/i);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);
  assert.equal(chapters.some((chapter) => chapter.number === 4), false, "future early-access chapter must be hidden");
  assert.equal(chapters.some((chapter) => chapter.number === 99), false, "unrelated series chapter must be hidden");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map((chapter) => chapter.number))), [1, 2, 3]);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);
  assert.ok(pages.every((page) => page.headers.Referer === chapters[0].id));
  const restoredPages = await module.extractImages(chapters[2].id);
  assert.ok(restoredPages.every((page) => page.url.includes("/chapters-restored/")));
  await assert.rejects(
    () => module.extractImages(chapters[1].id),
    /invalid or duplicate page manifest/i,
  );
  await assert.rejects(
    () => module.extractImages("https://asurascans.com/comics/fixture-chronicle-08677664/chapter/5"),
    /different series/i,
  );
  await assert.rejects(
    () => module.extractImages("https://asurascans.com/comics/fixture-chronicle-08677664/chapter/4"),
    /locked|not publicly available/i,
  );
  await assert.rejects(
    () => module.extractDetails("https://cdn.asurascans.com/comics/fixture-chronicle-08677664"),
    /outside the source host/i,
  );

  const discovery = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(discovery)), {
    sections: [
      { id: "popular", title: "Popular", items: fixtures.expected.search.items },
      { id: "latest", title: "Latest", items: fixtures.expected.search.items },
    ],
  });
  assert.ok(calls.some((call) => call.url.includes("api.asurascans.com/api/search")));
  assert.ok(calls.some((call) => call.url.includes("api.asurascans.com/api/series?")));
});

test("MangaDex (Español) uses the public API with es/es-la scoping and deduplicated chapters", async () => {
  const fixtures = {
    search: await json("modules/mangadex-es/fixtures/search.json"),
    details: await json("modules/mangadex-es/fixtures/details.json"),
    chapters: await json("modules/mangadex-es/fixtures/chapters.json"),
    images: await json("modules/mangadex-es/fixtures/images.json"),
  };
  const calls = [];
  const module = await loadModule("modules/mangadex-es/index.js", {
    fetchv2: async (url, headers, method, body, options) => {
      assert.equal(typeof url, "string");
      calls.push({ url, headers, method, body, options });
      const u = String(url);
      if (u.includes("/at-home/server/deadbeef-")) {
        return response('{"result":"error","errors":[{"status":404}]}', 404);
      }
      if (/\/at-home\/server\//.test(u)) return response(JSON.stringify(fixtures.images));
      if (/\/manga\/[0-9a-f-]{36}\/feed/.test(u)) return response(JSON.stringify(fixtures.chapters));
      if (/\/manga\/[0-9a-f-]{36}\?/.test(u)) return response(JSON.stringify(fixtures.details));
      if (u.includes("/manga?")) return response(JSON.stringify(fixtures.search));
      throw new Error(`Unexpected MangaDex URL: ${u}`);
    },
  });

  const search = await module.searchResults("sombra", 1);
  const searchItems = [
    {
      id: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
      href: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
      url: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
      title: "La Sombra del Fénix",
      image: "https://uploads.mangadex.org/covers/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d/fixture-cover-phoenix.jpg.256.jpg",
    },
    {
      id: "https://mangadex.org/title/1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      href: "https://mangadex.org/title/1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      url: "https://mangadex.org/title/1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      title: "Rusty Lanterns",
      image: "https://uploads.mangadex.org/covers/1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d/fixture-cover-lanterns.jpg.256.jpg",
    },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(search)), { items: searchItems, hasMore: false });
  const searchURL = calls[0].url;
  assert.ok(searchURL.includes("title=sombra"));
  assert.ok(searchURL.includes("availableTranslatedLanguage[]=es-la"));
  assert.ok(searchURL.includes("availableTranslatedLanguage[]=es"));
  assert.ok(searchURL.includes("contentRating[]=safe"));
  assert.ok(searchURL.includes("contentRating[]=suggestive"));
  assert.ok(searchURL.includes("contentRating[]=erotica"));
  assert.equal(searchURL.includes("contentRating[]=pornographic"), false);
  assert.equal(searchURL.includes("translatedLanguage[]"), false);

  // Details accept the canonical title URL, normalizing case, and prefer the
  // es-la title/description while keeping author/artist/genre metadata.
  const details = await module.extractDetails("https://mangadex.org/title/7C9E1A2B-3D4F-4A5B-8C6D-7E8F9A0B1C2D");
  assert.deepEqual(JSON.parse(JSON.stringify(details)), {
    id: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
    href: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
    url: "https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d",
    title: "La Sombra del Fénix",
    description: "Una historia de prueba sobre un fénix que nunca existió.\nSolo para fixtures.",
    image: "https://uploads.mangadex.org/covers/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d/fixture-cover-phoenix.jpg",
    authors: ["Fixture Author", "Fixture Artist"],
    author: "Fixture Author",
    genres: ["Action", "Reincarnation"],
    status: "Ongoing",
  });

  // Duplicate scan groups collapse, es-la wins over es for the same chapter,
  // external/unavailable/page-less chapters are skipped, and unnumbered
  // specials keep their title without a number (newest chapter first).
  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), [
    {
      id: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb06",
      href: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb06",
      url: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb06",
      language: "es",
      title: "Cap. 4 - La revelación",
      number: 4,
      releaseDate: "2023-01-22T12:00:00+00:00",
    },
    {
      id: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb04",
      href: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb04",
      url: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb04",
      language: "es",
      title: "Cap. 3",
      number: 3,
      releaseDate: "2023-01-15T12:00:00+00:00",
    },
    {
      id: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb02",
      href: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb02",
      url: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb02",
      language: "es",
      title: "Cap. 2 - El enfrentamiento",
      number: 2,
      releaseDate: "2023-01-08T12:00:00+00:00",
    },
    {
      id: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb01",
      href: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb01",
      url: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb01",
      language: "es",
      title: "Cap. 1",
      number: 1,
      releaseDate: "2023-01-01T12:00:00+00:00",
    },
    {
      id: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb09",
      href: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb09",
      url: "https://mangadex.org/chapter/11aa22bb-33cc-44dd-8ee0-ff11aa22bb09",
      language: "es",
      title: "Especial de Año Nuevo",
      releaseDate: "2023-02-01T12:00:00+00:00",
    },
  ]);
  assert.equal(calls.some((call) => call.url.includes("11aa22bb-33cc-44dd-8ee0-ff11aa22bb03")), false);
  assert.equal(calls.some((call) => call.url.includes("11aa22bb-33cc-44dd-8ee0-ff11aa22bb05")), false);

  const images = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(images)), [
    {
      url: "https://fixture-node.mangadex.network/data/0f0e0d0c0b0a0908070605040302010f/1-fixture.png",
      headers: { Accept: "image/avif,image/webp,image/*,*/*", Referer: "https://mangadex.org/" },
    },
    {
      url: "https://fixture-node.mangadex.network/data/0f0e0d0c0b0a0908070605040302010f/2-fixture.png",
      headers: { Accept: "image/avif,image/webp,image/*,*/*", Referer: "https://mangadex.org/" },
    },
    {
      url: "https://fixture-node.mangadex.network/data/0f0e0d0c0b0a0908070605040302010f/3-fixture.png",
      headers: { Accept: "image/avif,image/webp,image/*,*/*", Referer: "https://mangadex.org/" },
    },
  ]);

  const discovery = await module.discoveryHome();
  assert.deepEqual(JSON.parse(JSON.stringify(discovery)), {
    sections: [
      { id: "popular", title: "Popular en español", items: searchItems },
      { id: "latest", title: "Actualizaciones recientes", items: searchItems },
    ],
  });
  assert.ok(calls.some((call) => call.url.includes("order[followedCount]=desc")));
  assert.ok(calls.some((call) => call.url.includes("order[latestUploadedChapter]=desc")));

  const unknownFeed = await module.discoveryFeed("nope");
  assert.deepEqual(JSON.parse(JSON.stringify(unknownFeed)), { items: [], hasMore: false });

  await assert.rejects(
    () => module.extractDetails("https://evil.example/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d"),
    /Invalid MangaDex manga identifier/,
  );
  await assert.rejects(() => module.extractChapters("not-a-uuid"), /Invalid MangaDex manga identifier/);
  await assert.rejects(
    () => module.extractImages("https://mangadex.org/title/7c9e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d"),
    /Invalid MangaDex chapter identifier/,
  );
});
