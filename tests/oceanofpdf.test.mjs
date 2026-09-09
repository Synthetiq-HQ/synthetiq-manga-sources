import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../modules/oceanofpdf/index.js", import.meta.url), "utf8");
test("manifest includes every required native Books field, including empty legacy IDs", async () => {
  const manifest = JSON.parse(await readFile(new URL("../modules/oceanofpdf/manifest.json", import.meta.url), "utf8"));
  for (const key of ["id", "familyID", "legacyIDs", "name", "version", "contractVersion", "minimumAppVersion",
    "contentType", "language", "contentRating", "releaseTrack", "status", "capabilities", "baseURL",
    "universalLink", "entry", "icon", "allowedHosts", "limits", "attribution"]) {
    assert.ok(Object.hasOwn(manifest, key), `Missing native Codable field: ${key}`);
  }
  assert.deepEqual(manifest.legacyIDs, []);
});
const base = "https://oceanofpdf.com";
const id = `${base}/authors/example-author/pdf-example-book-download/`;
const form = { action: `${base}/Fetching_Resource.php`, method: "post", server: "srv3", fileName: "Example_Book.pdf" };
const detail = { url: id, title: "Example Book", author: "Example Author", genres: [], forms: [form] };
const signed = (name = form.fileName, host = "fs4.oceanofpdf.com", expires = 4102444800) =>
  `https://${host}/OceanofPDF.com/${encodeURIComponent(name)}?md5=fixture-only&expires=${expires}`;
const plain = value => JSON.parse(JSON.stringify(value));

function runtime({ pageData = detail, pagev2, fetchv2 } = {}) {
  const calls = { pages: [], fetches: [] };
  const context = vm.createContext({ URL, Date,
    pagev2: pagev2 || (async task => {
      calls.pages.push(task);
      return { evaluatedData: typeof pageData === "function" ? pageData(task) : pageData };
    }),
    fetchv2: fetchv2 || (async (...args) => {
      calls.fetches.push(args);
      return { status: 200, body: `<script>setTimeout(function(){ location.href='${signed()}'; }, 7000)</script>` };
    }),
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return { module: context.SynthetiqModule, calls };
}

test("publication handlers do not advertise image, text or audio extraction", () => {
  assert.deepEqual(Object.keys(runtime().module).sort(), ["discoveryFeed", "discoveryHome", "extractDetails", "extractResources", "searchResults"]);
});

test("details preserve URL identity, and absent covers stay absent", async () => {
  const { module, calls } = runtime();
  const details = await module.extractDetails(id);
  assert.equal(details.id, id);
  assert.equal(details.coverURL, null);
  assert.equal(details.title, "Example Book");
  assert.deepEqual(plain(calls.pages[0].headers), {});
  for (const key of ["url", "headers", "timeoutMilliseconds", "settleMilliseconds", "includeHTML",
    "captureResponseBodies", "maxEntries", "maxResponseCharacters"]) {
    assert.ok(Object.hasOwn(calls.pages[0], key), `Missing native pagev2 field: ${key}`);
  }
  await module.extractDetails(id);
  assert.equal(calls.pages.length, 1);
});

test("search encodes queries, filters unsafe/duplicate identities and paginates", async () => {
  const { module, calls } = runtime({ pageData: task => ({ url: task.url,
    items: [{ id, title: "Example", coverURL: "data:image/svg+xml,placeholder" }, { id, title: "Duplicate" },
      { id: "https://evil.example/authors/a/b/", title: "Bad" }], next: `${base}/page/2/?s=A%26B` }) });
  const result = await module.searchResults("A&B");
  assert.equal(calls.pages[0].url, `${base}/?s=A%26B`);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].coverURL, null);
  assert.equal(result.hasMore, true);
});

test("discovery has a stable feed ID and independent next-page route", async () => {
  const { module, calls } = runtime({ pageData: task => ({ url: task.url, items: [{ id, title: "Example" }], next: null }) });
  assert.equal((await module.discoveryHome()).sections[0].id, "recently-added");
  await module.discoveryFeed("recently-added", 2);
  assert.equal(calls.pages[1].url, `${base}/recently-added/page/2/`);
  await assert.rejects(module.discoveryFeed("unknown"), /Unknown/);
});

test("blank searches do no networking and invalid paging is rejected", async () => {
  const { module, calls } = runtime();
  assert.deepEqual(plain(await module.searchResults(" ")), { items: [], hasMore: false });
  for (const page of [0, -1, 1.5, 10001]) await assert.rejects(module.searchResults("book", page), /page number/);
  assert.equal(calls.pages.length, 0);
});

test("known file links resolve with proper form encoding and no redirects", async () => {
  const { module, calls } = runtime();
  const resources = await module.extractResources(id);
  assert.equal(resources[0].format, "pdf");
  assert.equal(resources[0].url, signed());
  assert.equal(calls.fetches[0][2], "POST");
  assert.equal(calls.fetches[0][3], "id=srv3&filename=Example_Book.pdf");
  assert.equal(calls.fetches[0][4].followRedirects, false);
});

test("PDF and EPUB resolve independently, preserving exact filenames", async () => {
  const names = ["Example & Other.pdf", "Example & Other.epub"];
  const { module } = runtime({ pageData: { ...detail, forms: names.map(fileName => ({ ...form, fileName })) },
    fetchv2: async (_url, _headers, _method, body) => {
      const name = new URLSearchParams(body).get("filename");
      return { status: 200, body: signed(name).replaceAll("&", "&amp;") };
    } });
  assert.deepEqual(plain(await module.extractResources(id)).map(x => x.fileName), names);
});

for (const [label, body] of [
  ["wrong chapter or edition", signed("Different_Book.pdf")],
  ["unknown file host", signed(form.fileName, "fs99.oceanofpdf.com")],
  ["expired link", signed(form.fileName, "fs3.oceanofpdf.com", 1)],
  ["advertisement", "https://ads.example/Example_Book.pdf"],
  ["unsigned link", `https://fs3.oceanofpdf.com/OceanofPDF.com/${form.fileName}`],
  ["challenge", "<title>Just a moment...</title>"],
]) test(`rejects ${label} without executing or fetching it`, async () => {
  let requests = 0;
  const { module } = runtime({ fetchv2: async () => { requests++; return { status: 200, body }; } });
  await assert.rejects(module.extractResources(id), /valid file/);
  assert.equal(requests, 1);
});

test("unsafe forms and book IDs are rejected before requesting downloads", async () => {
  const { module, calls } = runtime({ pageData: { ...detail, forms: [{ ...form, action: "https://evil.example/post" }] } });
  await assert.rejects(module.extractResources(id), /unsafe download form/);
  await assert.rejects(module.extractDetails("https://evil.example/authors/a/b/"), /identity/);
  assert.equal(calls.fetches.length, 0);
});

test("HTTP failure, truncation and redirects never become successful resources", async () => {
  for (const response of [{ status: 403 }, { status: 200, bodyDropped: true },
    { status: 200, finalUrl: "https://evil.example/", body: signed() }]) {
    await assert.rejects(runtime({ fetchv2: async () => response }).module.extractResources(id), /failed|redirected/);
  }
});

test("challenge failures can retry; they are not cached as empty success", async () => {
  let attempts = 0;
  const { module } = runtime({ pagev2: async () => {
    if (++attempts === 1) throw new Error("verification required");
    return { evaluatedData: detail };
  } });
  await assert.rejects(module.extractDetails(id), /verification/);
  assert.equal((await module.extractDetails(id)).title, detail.title);
  assert.equal(attempts, 2);
});

test("identical pending browser requests are coalesced", async () => {
  let calls = 0;
  const { module } = runtime({ pagev2: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { evaluatedData: detail }; } });
  await Promise.all([module.extractDetails(id), module.extractDetails(id)]);
  assert.equal(calls, 1);
});

test("signed resources are regenerated even while metadata is cached", async () => {
  const { module, calls } = runtime();
  await module.extractResources(id);
  await module.extractResources(id);
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.fetches.length, 2);
});
