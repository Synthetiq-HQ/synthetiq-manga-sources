import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

async function loadModule(bridges) {
  const source = await readFile(new URL("../modules/audioaz/index.js", import.meta.url), "utf8");
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    ...bridges,
  });
  new vm.Script(source, { filename: "modules/audioaz/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    bodyDropped: false,
    headers: { get: () => "" },
  };
}

const searchHTML = `
  <a href="/en/archive/fixture-archive-book">
    <img src="https://f.audioaz.com/media/fixture.webp" alt="Fixture Archive Book" />
    <span>Fixture Archive Book</span>
  </a>`;

const detailsHTML = `
  <script type="application/ld+json">{"@type":"Audiobook","name":"Fixture Archive Book","author":{"name":"Fixture Author"},"image":"https://f.audioaz.com/media/fixture.webp","description":"Fixture description","inLanguage":"en","genre":["Fantasy"]}</script>
  <audio>
    <source src="https://archive.org/download/fixture-archive-book/01.mp3" type="audio/mpeg" />
    <source src="https://api.audioaz.com/v1/stream?token=fixture-secret" type="audio/mpeg" />
  </audio>`;

const malformedLegacyHTML = '<p><a href="[https://archive.org/download/legacy-audio/LegacyBook.](https://archive.org/download/legacy-audio/LegacyBook.)m4b">M4B Audiobook</a></p>';

test("AudioAZ extracts a public archive audiobook and rejects tokenized media", async () => {
  const calls = [];
  const module = await loadModule({
    fetchv2: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/en/search?")) return response(searchHTML);
      if (String(url).includes("/en/archive/fixture-archive-book")) return response(detailsHTML);
      throw new Error(`Unexpected AudioAZ URL: ${url}`);
    },
  });

  const search = await module.searchResults("fixture", 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].id, "https://audioaz.com/en/archive/fixture-archive-book");
  const details = await module.extractDetails(search.items[0].id);
  assert.equal(details.title, "Fixture Archive Book");
  const chapters = await module.extractChapters(details.id);
  assert.equal(chapters.length, 1);
  const audio = await module.extractAudio(chapters[0].id);
  assert.equal(audio.tracks[0].url, "https://archive.org/download/fixture-archive-book/01.mp3");
  assert.equal(audio.tracks[0].format, "mp3");
  assert.equal(calls.filter((url) => url.includes("/en/archive/fixture-archive-book")).length, 1);
  assert.equal(calls.some((url) => url.includes("api.audioaz.com")), false);
});

test("AudioAZ repairs a malformed public legacy archive link", async () => {
  const module = await loadModule({
    fetchv2: async (url) => {
      if (String(url).includes("/en/archive/legacy-book")) return response(malformedLegacyHTML);
      throw new Error(`Unexpected AudioAZ legacy URL: ${url}`);
    },
  });
  const chapters = await module.extractChapters("https://audioaz.com/en/archive/legacy-book");
  assert.equal(chapters.length, 1);
  const audio = await module.extractAudio(chapters[0].id);
  assert.equal(audio.tracks[0].url, "https://archive.org/download/legacy-audio/LegacyBook.m4b");
  assert.equal(audio.tracks[0].format, "m4b");
});

test("AudioAZ accepts public provider MP3s and still rejects tokenized media", async () => {
  const providerHTML = '<audio><source src="https://api.spreaker.com/v2/episodes/68218023/ondemand.mp3" type="audio/mpeg" /><source src="https://api.audioaz.com/v1/stream?token=fixture-secret" type="audio/mpeg" /></audio>';
  const module = await loadModule({
    fetchv2: async (url) => {
      if (String(url).includes("/en/archive/provider-book")) return response(providerHTML);
      throw new Error(`Unexpected AudioAZ provider URL: ${url}`);
    },
  });
  const chapters = await module.extractChapters("https://audioaz.com/en/archive/provider-book");
  const audio = await module.extractAudio(chapters[0].id);
  assert.equal(audio.tracks[0].url, "https://api.spreaker.com/v2/episodes/68218023/ondemand.mp3");
  assert.equal(audio.tracks[0].format, "mp3");
});

test("AudioAZ retries a transient page failure and coalesces concurrent extraction", async () => {
  let pageAttempts = 0;
  const module = await loadModule({
    fetchv2: async (url) => {
      if (String(url).includes("/en/archive/fixture-archive-book")) {
        pageAttempts += 1;
        if (pageAttempts === 1) throw new Error("network timeout");
        return response(detailsHTML);
      }
      throw new Error(`Unexpected AudioAZ retry URL: ${url}`);
    },
  });
  const [details, chapters] = await Promise.all([
    module.extractDetails("https://audioaz.com/en/archive/fixture-archive-book"),
    module.extractChapters("https://audioaz.com/en/archive/fixture-archive-book"),
  ]);
  assert.equal(details.chapterCount, 1);
  assert.equal(chapters.length, 1);
  assert.equal(pageAttempts, 2);
});

test("AudioAZ discovery uses the paginated browse catalogue", async () => {
  const pageOne = '<a href="/en/browse?page=2&amp;sort=popular">2</a><a href="/en/audiobook/page-one"><img src="https://f.audioaz.com/page-one.webp" alt="Page One" /><span>Page One</span></a>';
  const pageTwo = '<a href="/en/audiobook/page-two"><img src="https://f.audioaz.com/page-two.webp" alt="Page Two" /><span>Page Two</span></a>';
  const requested = [];
  const module = await loadModule({
    fetchv2: async (url) => {
      requested.push(String(url));
      if (String(url).includes("/en/browse?page=1")) return response(pageOne);
      if (String(url).includes("/en/browse?page=2")) return response(pageTwo);
      throw new Error(`Unexpected AudioAZ browse URL: ${url}`);
    },
  });
  const first = await module.discoveryFeed("popular", 1);
  const second = await module.discoveryFeed("popular", 2);
  const latest = await module.discoveryFeed("latest", 1);
  assert.equal(first.items[0].title, "Page One");
  assert.equal(second.items[0].title, "Page Two");
  assert.equal(latest.items[0].title, "Page One");
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(requested.at(-1).includes("sort=recent"), true);
  assert.equal(requested.every((url) => url.includes("/en/browse?")), true);
});

test("AudioAZ does not advertise nonexistent search pages", async () => {
  const searchPage = Array.from({ length: 20 }, (_, index) => `<a href="/en/audiobook/search-${index}"><span>Search Result ${index}</span></a>`).join("");
  const module = await loadModule({
    fetchv2: async (url) => {
      if (String(url).includes("/en/search?")) return response(searchPage);
      throw new Error(`Unexpected AudioAZ search URL: ${url}`);
    },
  });
  const result = await module.searchResults("fixture", 1);
  assert.equal(result.items.length, 20);
  assert.equal(result.hasMore, false);
});

test("AudioAZ excludes explicitly adult-labelled entries and off-host pages", async () => {
  const adultSearch = '<a href="/en/archive/adult-book"><span>Adult Fixture Audiobook</span></a><a href="/en/audiobook/sex"><span>Sex</span></a>';
  const adultDetails = '<script type="application/ld+json">{"@type":"Audiobook","name":"Safe Title","genre":["Adult"]}</script><audio><source src="https://archive.org/download/adult-book/01.mp3" /></audio>';
  const module = await loadModule({
    fetchv2: async (url) => {
      if (String(url).includes("/en/search?")) return response(adultSearch);
      if (String(url).includes("/en/archive/adult-book")) return response(adultDetails);
      throw new Error(`Unexpected AudioAZ safety URL: ${url}`);
    },
  });
  const search = await module.searchResults("adult", 1);
  assert.equal(search.items.length, 0);
  await assert.rejects(() => module.extractDetails("https://audioaz.com/en/archive/adult-book"), /content-safety filter/i);
  await assert.rejects(() => module.extractDetails("https://example.com/en/archive/fixture"), /Invalid AudioAZ audiobook page/i);
});

test("AudioAZ is present in the production catalogue", async () => {
  const index = JSON.parse(await readFile(new URL("index.json", root), "utf8"));
  assert.equal(index.modules.some((entry) => entry.id === "audioaz"), true);
  const manifest = JSON.parse(await readFile(new URL("modules/audioaz/manifest.json", root), "utf8"));
  assert.equal(manifest.contentType, "audio");
  assert.equal(manifest.contentRating, "suggestive");
  assert.equal(manifest.allowedHosts.includes("api.spreaker.com"), true);
  assert.equal(manifest.allowedHosts.includes("darkerprojects.dreamhosters.com"), true);
  assert.ok(manifest.capabilities.includes("audio"));
});
