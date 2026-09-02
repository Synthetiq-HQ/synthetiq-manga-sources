import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function loadModule(fetchv2) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(await text("modules/lnori/index.js"), { filename: "modules/lnori/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { "content-type": "text/html" },
    body,
    bodyDropped: false,
    text: async () => body,
  };
}

test("Lnori filters tagged catalogue entries and reads ordered volume text", async () => {
  const fixtures = {
    library: await text("modules/lnori/fixtures/library.html"),
    home: await text("modules/lnori/fixtures/home.html"),
    series: await text("modules/lnori/fixtures/series.html"),
    volume: await text("modules/lnori/fixtures/volume.html"),
  };
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (url === "https://lnori.com/library") return response(fixtures.library);
    if (url === "https://lnori.com/") return response(fixtures.home);
    if (url === "https://lnori.com/series/100/fixture-academy") return response(fixtures.series);
    if (url === "https://lnori.com/book/501/fixture-academy-vol-1") return response(fixtures.volume);
    throw new Error(`Unexpected Lnori URL: ${url}`);
  });

  const search = await module.searchResults("fixture", 1);
  assert.equal(search.items.length, 1);
  assert.equal((await module.searchResults("re zero", 1)).items.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(search.items[0])), {
    id: "https://lnori.com/series/100/fixture-academy",
    href: "https://lnori.com/series/100/fixture-academy",
    title: "Fixture Academy",
    image: "https://cdn.lnori.com/cover/100.webp",
    author: "A. Writer",
    genres: ["action", "fantasy", "school"],
  });
  assert.equal((await module.searchResults("fixture", 2)).items.length, 0);
  assert.equal((await module.discoveryHome()).sections[0].items.length, 1);

  const details = await module.extractDetails(search.items[0].id);
  assert.equal(details.title, "Fixture Academy");
  assert.deepEqual(JSON.parse(JSON.stringify(details.genres)), ["action", "fantasy"]);

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })))), [
    { number: 1, title: "Volume 1" },
    { number: 2, title: "Volume 2" },
    { number: 3, title: "Volume 3" },
  ]);
  const volume = await module.extractText(chapters[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(volume)), {
    title: "Fixture Academy, Vol. 1",
    content: "Chapter 1: Arrival\n\nThe first synthetic paragraph.\n\nThe second synthetic paragraph.\n\nChapter 2: Lessons\n\nThe final synthetic paragraph; just a moment passed.",
  });
  assert.ok(calls.every((call) => call.headers.Referer === "https://lnori.com/"));
  assert.ok(calls.every((call) => call.options.followRedirects === true));
});

test("Lnori rejects unsafe details, hostile identifiers, and challenge pages", async () => {
  const series = await text("modules/lnori/fixtures/series.html");
  const challenge = await text("modules/lnori/fixtures/challenge.html");
  const unsafe = series.replace(">action</a>", ">ecchi</a>");
  const module = await loadModule(async (url) => {
    if (url.endsWith("/series/101/fixture-after-dark")) return response(unsafe);
    return response(challenge);
  });
  await assert.rejects(() => module.extractDetails("https://lnori.com/series/101/fixture-after-dark"), /safety filter|browser-verification/i);
  await assert.rejects(() => module.extractDetails("https://evil.example/series/100/fixture-academy"), /host|identifier/i);
});
