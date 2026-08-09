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

  const chapters = await module.extractChapters("open-fixture");
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const book = await module.extractText("https://archive.org/download/open-fixture/fixture_book_djvu.txt");
  assert.equal(book, fixtures.book);
  await assert.rejects(
    () => module.extractChapters("closed-fixture"),
    /not explicitly open, licensed, and downloadable/,
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

test("Poseidon Scans parses search, flight-data details, free-only chapters, and page images", async () => {
  const fixtures = {
    search: await text("modules/poseidon-scans/fixtures/search.json"),
    details: await text("modules/poseidon-scans/fixtures/details.rsc"),
    pages: await text("modules/poseidon-scans/fixtures/pages.rsc"),
    expected: await json("modules/poseidon-scans/fixtures/expected.json"),
  };
  const module = await loadModule("modules/poseidon-scans/index.js", {
    fetchv2: async (url) => {
      assert.equal(typeof url, "string");
      if (url.includes("/api/search")) return response(fixtures.search);
      if (url.includes("/api/manga/lastchapters")) return response(fixtures.search);
      if (url.includes("/chapter/")) return response(fixtures.pages);
      if (url.includes("/serie/")) return response(fixtures.details);
      if (url.endsWith("poseidon-scans.net/")) return response(fixtures.search);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(search)), fixtures.expected.search);

  const details = await module.extractDetails(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(details)), fixtures.expected.details);

  const chapters = await module.extractChapters(search.items[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters)), fixtures.expected.chapters);

  const pages = await module.extractImages(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), fixtures.expected.images);

  const discovery = await module.discoveryHome();
  assert.ok(discovery.sections.length > 0);
  assert.equal(discovery.sections[0].items[0].title, "Fixture One");
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
];

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

test("NovelFire parses search, details, complete chapters, and chapter text", async () => {
  const fixtures = {
    search: await text("modules/novelfire/fixtures/search.html"),
    searchPage2: await text("modules/novelfire/fixtures/search-page-2.html"),
    home: await text("modules/novelfire/fixtures/home.html"),
    details: await text("modules/novelfire/fixtures/details.html"),
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
      if (url.endsWith("/book/fixture-chronicle/chapter-1")) return response(fixtures.chapter);
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

  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].number, 1);
  assert.equal(chapters[1].number, 2);

  const chapter = await module.extractText(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapter)), {
    title: "Chapter 1",
    content: "Fixture paragraph one.\n\nFixture paragraph two.",
  });

  const home = await module.discoveryHome();
  assert.equal(home.sections.length, 2);
  assert.equal(home.sections[0].items.length, 1);
});
