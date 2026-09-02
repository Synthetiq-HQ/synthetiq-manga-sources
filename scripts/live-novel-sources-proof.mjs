#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(slug) {
  const source = await readFile(path.join(root, "modules", slug, "index.js"), "utf8");
  const fetchv2 = async (url, headers = {}, method = "GET", body = null, options = {}) => {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: options.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maxBytes = Number(options.maxBytesHint) || 8 * 1024 * 1024;
    const dropped = bytes.length > maxBytes;
    const bodyText = dropped ? "" : new TextDecoder().decode(bytes);
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      finalUrl: response.url,
      body: bodyText,
      bodyDropped: dropped,
      bodyBytes: bytes.length,
      contentType: response.headers.get("content-type") || "",
      text: async () => bodyText,
    };
  };
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: "modules/" + slug + "/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

async function proveLnori() {
  const module = await loadModule("lnori");
  const search = await module.searchResults("re zero", 1);
  assert.ok(search.items.length > 0, "Lnori search returned no safe Re:Zero result");
  const item = search.items.find((candidate) => candidate.id.includes("/series/3343/"));
  assert.ok(item, "Lnori canonical Re:Zero series was not returned");
  const details = await module.extractDetails(item.id);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length >= 20, "Lnori canonical Re:Zero returned too few volumes");
  const sampleIndexes = [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])];
  const samples = [];
  for (const index of sampleIndexes) {
    const result = await module.extractText(chapters[index].id);
    assert.ok(result.content.length > 100, "Lnori volume " + (index + 1) + " was empty");
    samples.push({ volume: chapters[index].number, bytes: Buffer.byteLength(result.content) });
  }
  return { source: "Lnori", searchItems: search.items.length, volumes: chapters.length, samples };
}

async function proveNovelFire() {
  const module = await loadModule("novelfire");
  const search = await module.searchResults("shadow slave cinema", 1);
  assert.ok(search.items.length > 0, "NovelFire search returned no result");
  const item = search.items[0];
  const details = await module.extractDetails(item.id);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length >= 3, "NovelFire returned too few chapters");
  const result = await module.extractText(chapters[0].id);
  assert.ok(result.content.length > 100, "NovelFire first chapter was empty");
  const redirectedResult = await module.extractText("shadow-slave-chapter-1");
  assert.ok(redirectedResult.content.length > 100, "NovelFire source-provided chapter handoff was empty");
  return {
    source: "NovelFire",
    searchItems: search.items.length,
    title: details.title,
    chapters: chapters.length,
    firstChapterBytes: Buffer.byteLength(result.content),
    redirectedChapterBytes: Buffer.byteLength(redirectedResult.content),
  };
}

async function proveWitchCult() {
  const module = await loadModule("witchculttranslation");
  const search = await module.searchResults("re zero");
  assert.equal(search.items.length, 1, "Witch Cult search did not return its fixed series");
  const details = await module.extractDetails(search.items[0].id);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length >= 10, "Witch Cult returned too few HTML chapters");
  const sampleIndexes = [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])];
  const samples = [];
  for (const index of sampleIndexes) {
    const result = await module.extractText(chapters[index].id);
    assert.ok(result.content.length > 100, "Witch Cult chapter " + (index + 1) + " was empty");
    samples.push({ number: chapters[index].number, title: chapters[index].title, bytes: Buffer.byteLength(result.content) });
  }
  return { source: "Witch Cult Translations", searchItems: search.items.length, htmlChapters: chapters.length, samples };
}

const results = [];
for (const prove of [proveLnori, proveNovelFire, proveWitchCult]) {
  try {
    results.push(await prove());
  } catch (error) {
    results.push({ source: prove.name, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
