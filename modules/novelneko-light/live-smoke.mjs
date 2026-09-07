import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(root, "index.js"), "utf8");

async function fetchv2(url, headers, method, body, options) {
  assert.equal(method, "GET");
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    contentType: response.headers.get("content-type") || "",
    body: text,
    bodyDropped: false,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

const context = vm.createContext({ URL, URLSearchParams, console, fetchv2 });
new vm.Script(source, { filename: "modules/novelneko-light/index.js" }).runInContext(context);
const module = context.SynthetiqModule;

const search = await module.searchResults("Beginning After The End", 1);
assert.ok(search.items.length >= 1, "live search returned no safe title");
const details = await module.extractDetails(search.items[0].id);
assert.equal(details.title, "The Beginning After The End");
assert.ok(details.genres.length > 0);
assert.ok(details.volumes.length > 0);
const resources = await module.extractResources(details.id);
assert.ok(resources.length > 0);
assert.ok(resources.every((resource) => resource.format === "pdf"));

const headChecks = await Promise.all(resources.slice(0, 2).map(async (resource) => {
  const response = await fetch(resource.url, {
    method: "HEAD",
    headers: { Referer: details.url, "User-Agent": "Synthetiq Books module smoke test" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  return {
    url: resource.url,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    contentLength: response.headers.get("content-length") || null,
  };
}));

assert.ok(headChecks.every((check) => check.status >= 200 && check.status < 400), JSON.stringify(headChecks));
assert.ok(headChecks.every((check) => /application\/pdf/i.test(check.contentType)), JSON.stringify(headChecks));
console.log(JSON.stringify({
  title: details.title,
  genres: details.genres,
  volumeCount: resources.length,
  headChecks,
}, null, 2));
