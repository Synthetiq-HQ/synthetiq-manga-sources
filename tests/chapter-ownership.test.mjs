import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

async function loadModule(path, fetchv2) {
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(await source(path), { filename: path }).runInContext(context);
  return context.SynthetiqModule;
}

function response(body) {
  return { ok: true, status: 200, body, text: async () => body };
}

test("MGRead only returns chapters owned by the requested series", async () => {
  const details = await source("modules/mgread/fixtures/details.html");
  const module = await loadModule("modules/mgread/index.js", async (url) => {
    if (url.includes("/manga/fixture-alpha")) return response(details);
    throw new Error(`Unexpected MGRead URL: ${url}`);
  });

  const chapters = await module.extractChapters("https://mgread.io/manga/fixture-alpha/");
  assert.equal(chapters.length, 2);
  assert.ok(chapters.every((chapter) => chapter.id.startsWith("https://mgread.io/manga/fixture-alpha/")));
  assert.equal(chapters.some((chapter) => chapter.number === 99), false);
});

test("Grabber Zone only returns chapters owned by the requested series", async () => {
  const html = [
    '<li class="wp-manga-chapter"><a href="/comics/fixture-alpha/chapter-2/">Chapter 2</a></li>',
    '<li class="wp-manga-chapter"><a href="https://grabber.zone/comics/fixture-alpha/chapter-1/">Chapter 1</a></li>',
    '<li class="wp-manga-chapter"><a href="/comics/unrelated-series/chapter-99/">Chapter 99</a></li>',
  ].join("\n");
  const module = await loadModule("modules/grabber-zone/index.js", async (url) => {
    if (url === "https://grabber.zone/comics/fixture-alpha/") return response(html);
    throw new Error(`Unexpected Grabber Zone URL: ${url}`);
  });

  const chapters = await module.extractChapters("https://grabber.zone/comics/fixture-alpha/");
  assert.equal(chapters.length, 2);
  assert.ok(chapters.every((chapter) => chapter.id.startsWith("https://grabber.zone/comics/fixture-alpha/")));
  assert.equal(chapters.some((chapter) => chapter.number === 99), false);
});

test("Poseidon Scans only returns chapters owned by the requested series and skips premium-locked chapters", async () => {
  const details = await readFile(new URL("modules/poseidon-scans/fixtures/details.rsc", root), "utf8");
  const module = await loadModule("modules/poseidon-scans/index.js", async (url) => {
    if (url.includes("/serie/")) return response(details);
    throw new Error(`Unexpected Poseidon Scans URL: ${url}`);
  });

  const chapters = await module.extractChapters("https://poseidon-scans.net/serie/fixture-one/");
  assert.equal(chapters.length, 2);
  assert.ok(chapters.every((chapter) => chapter.id.startsWith("https://poseidon-scans.net/serie/fixture-one/")));
  // Premium-locked chapter 0.5 must not be listed for anonymous readers.
  assert.equal(chapters.some((chapter) => chapter.number === 0.5), false);
});
