import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(fileURLToPath(import.meta.url));

async function load() {
  const source = await readFile(path.join(root, "index.js"), "utf8");
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    fetchv2: async () => {
      throw new Error("retired sources must not fetch the network");
    },
  });
  context.globalThis = context;
  new vm.Script(source, { filename: path.join(root, "index.js") }).runInContext(context);
  return context.SynthetiqModule;
}

test("NovelFrance is retired and fails closed with a clear message", async () => {
  const module = await load();
  const retired = /retired/i;
  await assert.rejects(() => module.searchResults("fixture", 1), retired);
  await assert.rejects(() => module.extractDetails("https://novelfrance.fr/novel/fixture-safe"), retired);
  await assert.rejects(() => module.extractChapters("fixture-safe"), retired);
  await assert.rejects(() => module.extractText("https://novelfrance.fr/novel/fixture-safe/chapter-1"), retired);
  await assert.rejects(() => module.discoveryHome(), retired);
  await assert.rejects(() => module.discoveryFeed("latest", 1), retired);
});

test("NovelFrance manifest pins the retired entry and a valid neutral PNG icon", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entry = await readFile(path.join(root, "index.js"));
  const icon = await readFile(path.join(root, "icon.png"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(manifest.status, "retired");
  assert.equal(manifest.entry.path, "modules/novelfrance/index.js");
  assert.equal(manifest.entry.sha256, sha256(entry));
  assert.equal(manifest.icon.path, "modules/novelfrance/icon.png");
  assert.equal(manifest.icon.sha256, sha256(icon));
  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
});
