import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => readFile(path.join(root, "fixtures", name), "utf8");
const json = async (name) => JSON.parse(await fixture(name));
const plain = (value) => JSON.parse(JSON.stringify(value));

function response(body, contentType = "text/html") {
  return {
    status: 200,
    ok: true,
    headers: { "content-type": contentType },
    contentType,
    body,
    bodyDropped: false,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function loadModule(fetchv2) {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const context = vm.createContext({ URL, URLSearchParams, console, fetchv2 });
  new vm.Script(source, { filename: "modules/novelneko-light/index.js" }).runInContext(context);
  return context.SynthetiqModule;
}

const catalog = JSON.stringify(await json("catalog.json"));
const pages = {
  safe: await fixture("safe.html"),
  unsafe: await fixture("unsafe.html"),
  missing: await fixture("missing.html"),
  restricted: await fixture("restricted.html"),
  "volume-missing": await fixture("volume-missing.html"),
  herostome: await fixture("herostome.html"),
  outside: await fixture("outside.html"),
};

function bridge(url, headers, method, body, options) {
  assert.equal(method, "GET");
  assert.equal(body, null);
  assert.equal(headers.Referer, "https://novelneko.fr/lightnovels/");
  assert.equal(options.followRedirects, true);
  if (url.endsWith("/lightnovel.json")) return response(catalog, "application/json");
  const match = url.match(/\/lightnovels\/(safe|unsafe|missing|restricted|volume-missing|herostome|outside)\/$/);
  if (match) return response(pages[match[1]]);
  throw new Error(`Unexpected URL: ${url}`);
}

const module = await loadModule(bridge);

assert.equal(typeof module.searchResults, "function");
assert.equal(typeof module.extractDetails, "function");
assert.equal(typeof module.extractChapters, "function");
assert.equal(typeof module.extractResources, "function");

const search = await module.searchResults("", 1);
assert.deepEqual(plain(search.items.map((item) => item.title)), ["Safe French Light Novel"]);
assert.equal(search.hasMore, false);
assert.equal(search.items[0].volumeCount, 3);

const details = await module.extractDetails("https://novelneko.fr/lightnovels/safe/");
assert.equal(details.author, "Auteur Test");
assert.deepEqual(plain(details.genres), ["Action", "Fantasy"]);
assert.deepEqual(plain(details.volumes.map((volume) => volume.number)), [1, 1.5, 2]);
assert.ok(details.volumes.every((volume) => volume.url.startsWith("https://novelneko.fr/lightnovels/safe/volumes/")));

const chapters = await module.extractChapters(details.id);
assert.deepEqual(plain(chapters.map((chapter) => chapter.title)), ["Tome 1", "Tome 1.5", "Tome 2"]);

const resources = await module.extractResources(details.id);
assert.deepEqual(plain(resources.map((resource) => resource.format)), ["pdf", "pdf", "pdf"]);
assert.deepEqual(plain(resources.map((resource) => resource.fileName)), ["tome1.pdf", "tome1-5.pdf", "tome2.pdf"]);
assert.deepEqual(plain(resources.map((resource) => resource.number)), [1, 1.5, 2]);
assert.deepEqual(plain(resources.map((resource) => resource.url)), plain(details.volumes.map((volume) => volume.url)));
assert.ok(resources.every((resource) => resource.headers.Referer === details.url));

assert.deepEqual(plain((await module.searchResults("harem", 1)).items), []);
assert.deepEqual(plain((await module.searchResults("restricted", 1)).items), []);
assert.deepEqual(plain((await module.searchResults("volume-missing", 1)).items), []);
await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/unsafe/"), /safety filter/i);
await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/missing/"), /safety metadata is missing/i);
await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/restricted/"), /no public PDF volumes/i);
await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/volume-missing/"), /no public PDF volumes/i);

const subdirDetails = await module.extractDetails("https://novelneko.fr/lightnovels/herostome/");
assert.deepEqual(plain(subdirDetails.volumes.map((volume) => volume.number)), [1, 1.5, 2]);
assert.ok(subdirDetails.volumes.every((volume) => volume.url.startsWith("https://novelneko.fr/lightnovels/herostome/herostome/")));
await assert.rejects(() => module.extractDetails("https://novelneko.fr/lightnovels/outside/"), /outside its light-novel series directory/i);
await assert.rejects(() => module.extractDetails("https://example.invalid/lightnovels/safe/"), /out-of-scope|invalid/i);

const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const hash = async (name) => createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
assert.equal(manifest.entry.path, "modules/novelneko-light/index.js");
assert.equal(manifest.icon.path, "modules/novelneko-light/icon.png");
assert.equal(manifest.entry.sha256, await hash("index.js"));
assert.equal(manifest.icon.sha256, await hash("icon.png"));
assert.deepEqual(Array.from(await readFile(path.join(root, "icon.png"))).slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);

console.log("NovelNeko Light fixture tests passed.");
