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
  new vm.Script(await text("modules/witchculttranslation/index.js"), { filename: "modules/witchculttranslation/index.js" }).runInContext(context);
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

test("Witch Cult Translations exposes one series and only same-host HTML chapters", async () => {
  const fixtures = {
    toc: await text("modules/witchculttranslation/fixtures/toc.html"),
    chapter: await text("modules/witchculttranslation/fixtures/chapter.html"),
  };
  const calls = [];
  const module = await loadModule(async (url, headers, method, body, options) => {
    calls.push({ url, headers, method, body, options });
    if (url === "https://witchculttranslation.com/table-of-content/") return response(fixtures.toc);
    if (url === "https://witchculttranslation.com/2026/01/04/arc-2-chapter-3-fixture/") return response(fixtures.chapter);
    throw new Error(`Unexpected Witch Cult URL: ${url}`);
  });

  assert.equal((await module.searchResults("Re:Zero")).items.length, 1);
  assert.equal((await module.searchResults("unrelated title")).items.length, 0);
  assert.equal((await module.discoveryHome()).sections[0].items[0].id, "rezero-web-novel");

  const details = await module.extractDetails("rezero-web-novel");
  assert.equal(details.title, "Re:Zero Web Novel Translations");
  assert.equal(details.author, "Tappei Nagatsuki");

  const chapters = await module.extractChapters(details.id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapters.map((chapter) => ({ number: chapter.number, title: chapter.title, volume: chapter.volume })))), [
    { number: 1, title: "Chapter 1: Fixture Beginning", volume: "Arc 1" },
    { number: 2, title: "Chapter 2: Fixture Middle", volume: "Arc 1" },
    { number: 3, title: "Arc 2, Chapter 3: Fixture End", volume: "Arc 2" },
    { number: 4, title: "Interlude: Fixture Bridge", volume: "Arc 2" },
  ]);
  const chapter = await module.extractText(chapters[2].id);
  assert.deepEqual(JSON.parse(JSON.stringify(chapter)), {
    title: "Arc 2, Chapter 3: Fixture End",
    content: "First fixture paragraph.\n\nSecond fixture paragraph; just a moment passed.\n\nLast fixture paragraph.",
  });
  assert.ok(calls.every((call) => new URL(call.url).protocol === "https:"));
  assert.ok(calls.every((call) => call.options.followRedirects === true));
});

test("Witch Cult Translations rejects PDF, external, malformed, and challenge URLs", async () => {
  const toc = await text("modules/witchculttranslation/fixtures/toc.html");
  const challenge = await text("modules/witchculttranslation/fixtures/challenge.html");
  const module = await loadModule(async (url) => {
    if (url.endsWith("/table-of-content/")) return response(challenge);
    return response(toc);
  });
  await assert.rejects(() => module.extractText("https://witchculttranslation.com/wp-content/uploads/2024/01/arc-1.pdf"), /PDF|chapter URL/i);
  await assert.rejects(() => module.extractText("https://external.example/2026/01/01/arc-1-chapter-1"), /URL|out-of-scope/i);
  await assert.rejects(() => module.extractDetails("rezero-web-novel"), /browser-verification/i);
});
