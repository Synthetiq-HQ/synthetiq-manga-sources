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
  const context = vm.createContext({ URL, URLSearchParams, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, fetchv2 });
  context.globalThis = context;
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  return context.SynthetiqModule;
}

async function proveNovelFrance() {
  const module = await loadModule("novelfrance");
  const search = await module.searchResults("harry", 1);
  assert.ok(search.items.length > 0, "NovelFrance returned no safe live search results");
  const item = search.items[0];
  const details = await module.extractDetails(item.id);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length > 0, "NovelFrance returned no live chapters");
  const result = await module.extractText(chapters[0].id);
  assert.ok(result.length > 100, "NovelFrance first live chapter was empty");
  return {
    source: "NovelFrance",
    title: details.title,
    searchItems: search.items.length,
    chapters: chapters.length,
    firstChapterBytes: Buffer.byteLength(result),
  };
}

async function proveNovelNekoWeb() {
  const module = await loadModule("novelneko-web");
  const search = await module.searchResults("arifureta", 1);
  assert.ok(search.items.length > 0, "NovelNeko Web-Novels returned no safe live search results");
  const item = search.items[0];
  const details = await module.extractDetails(item.id);
  const chapters = await module.extractChapters(details.id);
  assert.ok(chapters.length >= 3, "NovelNeko Web-Novels returned too few live chapters");
  const sampleIndexes = [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])];
  const samples = [];
  for (const index of sampleIndexes) {
    const result = await module.extractText(chapters[index].id);
    assert.ok(result.content.length > 100, `NovelNeko Web-Novels chapter ${index + 1} was empty`);
    samples.push({ number: chapters[index].number, bytes: Buffer.byteLength(result.content) });
  }
  return {
    source: "NovelNeko Web-Novels",
    title: details.title,
    searchItems: search.items.length,
    chapters: chapters.length,
    samples,
  };
}

const results = [];
for (const prove of [proveNovelFrance, proveNovelNekoWeb]) {
  try {
    results.push(await prove());
  } catch (error) {
    results.push({ source: prove.name, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
