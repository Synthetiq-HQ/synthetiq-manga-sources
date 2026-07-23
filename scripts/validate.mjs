import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipHashes = process.argv.includes("--skip-hashes");
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const requiredCommon = ["searchResults", "extractDetails"];
const requiredByType = {
  pageImages: ["extractChapters", "extractImages"],
  text: ["extractChapters", "extractText"],
  publication: ["extractResources"],
};

async function JSONFile(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function textFile(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function sha256(relativePath) {
  return createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex");
}

async function walk(directory = root) {
  const output = [];
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name);
    const info = await stat(absolute);
    if (info.isDirectory()) output.push(...await walk(absolute));
    else output.push(path.relative(root, absolute));
  }
  return output.sort();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function equalJSON(actual, expected, label) {
  assert.deepEqual(plain(actual), expected, label);
}

function mockResponse(body, contentType = "text/plain") {
  return {
    status: 200,
    ok: true,
    headers: { "content-type": contentType },
    finalUrl: "https://fixture.invalid/",
    body,
    bodyDropped: false,
    dropReason: null,
    bodyBytes: Buffer.byteLength(body),
    contentType,
    error: null,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

async function loadModule(slug, bridges) {
  const source = await textFile(`modules/${slug}/index.js`);
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
  new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);
  assert.equal(typeof context.SynthetiqModule, "object", `${slug} must publish SynthetiqModule`);
  return context.SynthetiqModule;
}

async function validateCatalogue() {
  const index = await JSONFile("index.json");
  assert.equal(index.schemaVersion, 1, "unsupported repository schema");
  assert.ok(identifierPattern.test(index.repository.id), "invalid repository id");
  assert.equal(new URL(index.repository.homepage).protocol, "https:");
  assert.equal(new URL(index.repository.universalLink).protocol, "https:");
  assert.ok(index.modules.length >= 1, "repository must publish at least one module");

  const identities = new Set();
  for (const entry of index.modules) {
    assert.ok(identifierPattern.test(entry.id), `invalid module id ${entry.id}`);
    assert.ok(identifierPattern.test(entry.familyID), `invalid family id ${entry.familyID}`);
    assert.ok(versionPattern.test(entry.version), `invalid version ${entry.version}`);
    for (const identity of new Set([entry.id, entry.familyID])) {
      assert.ok(!identities.has(identity), `duplicate identity ${identity}`);
      identities.add(identity);
    }

    const manifest = await JSONFile(entry.manifest.path);
    for (const key of ["id", "familyID", "name", "version", "language", "contentType", "contentRating", "releaseTrack", "status"]) {
      assert.equal(manifest[key], entry[key], `${entry.id} index/manifest mismatch for ${key}`);
    }
    assert.equal(manifest.contractVersion, 1, `${entry.id} contractVersion`);
    assert.ok(versionPattern.test(manifest.minimumAppVersion), `${entry.id} minimumAppVersion`);
    assert.equal(new URL(manifest.baseURL).protocol, "https:");
    assert.equal(new URL(manifest.universalLink).protocol, "https:");
    assert.ok(Array.isArray(manifest.allowedHosts) && manifest.allowedHosts.length, `${entry.id} allowedHosts`);
    assert.ok(manifest.allowedHosts.some((host) => host.replace(/^\*\./, "") === new URL(manifest.baseURL).hostname), `${entry.id} base host missing from allowlist`);
    assert.ok(manifest.limits.timeoutMilliseconds >= 1_000 && manifest.limits.timeoutMilliseconds <= 30_000);
    assert.ok(manifest.limits.maxConcurrentRequests >= 1 && manifest.limits.maxConcurrentRequests <= 4);
    assert.ok(manifest.limits.maxResponseBytes >= 1_024 && manifest.limits.maxResponseBytes <= 16 * 1024 * 1024);
    assert.ok(manifest.limits.maxScriptBytes >= 1_024 && manifest.limits.maxScriptBytes <= 512 * 1024);
    assert.ok(manifest.limits.cacheTTLSeconds >= 0 && manifest.limits.cacheTTLSeconds <= 86_400);

    for (const handler of [...requiredCommon, ...requiredByType[manifest.contentType]]) {
      const capability = {
        searchResults: "search",
        extractDetails: "details",
        extractChapters: "chapters",
        extractImages: "images",
        extractText: "text",
        extractResources: "resources",
      }[handler];
      assert.ok(manifest.capabilities.includes(capability), `${entry.id} missing ${capability} capability`);
    }
    if (entry.id === "mangafire-v2") assert.ok(manifest.capabilities.includes("interactivePage"));
    if (entry.id === "internet-archive") {
      assert.ok(manifest.capabilities.includes("text"));
      assert.ok(manifest.capabilities.includes("chapters"));
    }

    for (const asset of [manifest.entry, manifest.icon, entry.manifest, entry.icon]) {
      assert.ok(!asset.path.startsWith("/") && !asset.path.includes(".."), `unsafe asset path ${asset.path}`);
      assert.ok(hashPattern.test(asset.sha256), `invalid hash for ${asset.path}`);
      await stat(path.join(root, asset.path));
    }
    const icon = await readFile(path.join(root, manifest.icon.path));
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${entry.id} icon is not PNG`);

    if (!skipHashes) {
      assert.equal(await sha256(manifest.entry.path), manifest.entry.sha256, `${entry.id} entry hash`);
      assert.equal(await sha256(manifest.icon.path), manifest.icon.sha256, `${entry.id} manifest icon hash`);
      assert.equal(await sha256(entry.manifest.path), entry.manifest.sha256, `${entry.id} manifest hash`);
      assert.equal(await sha256(entry.icon.path), entry.icon.sha256, `${entry.id} index icon hash`);
    }

    const handlers = await loadModule(path.basename(path.dirname(entry.manifest.path)), {});
    for (const handler of [...requiredCommon, ...requiredByType[manifest.contentType]]) {
      assert.equal(typeof handlers[handler], "function", `${entry.id} missing ${handler}`);
    }
  }

  const files = await walk();
  assert.equal(files.some((file) => file.toLowerCase().endsWith(".zip")), false, "ZIP files are forbidden");
  return index;
}

async function testWeebCentral() {
  const fixtures = {
    search: await textFile("modules/weebcentral/fixtures/search.html"),
    details: await textFile("modules/weebcentral/fixtures/details.html"),
    chapters: await textFile("modules/weebcentral/fixtures/chapters.html"),
    images: await textFile("modules/weebcentral/fixtures/images.html"),
  };
  const expected = await JSONFile("modules/weebcentral/fixtures/expected.json");
  const fetchv2 = async (url, headers, method, body, options) => {
    assert.equal(typeof url, "string", "WeebCentral must use positional fetchv2");
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(headers.Referer, "https://weebcentral.com/");
    assert.equal(options.responseClass, "html");
    if (url.includes("/search/data?")) return mockResponse(fixtures.search, "text/html");
    if (url.includes("/full-chapter-list")) return mockResponse(fixtures.chapters, "text/html");
    if (url.includes("/chapters/") && url.includes("/images?")) return mockResponse(fixtures.images, "text/html");
    if (url.includes("/series/")) return mockResponse(fixtures.details, "text/html");
    throw new Error(`Unexpected WeebCentral URL: ${url}`);
  };
  const module = await loadModule("weebcentral", { fetchv2 });
  equalJSON(await module.searchResults("fixture", 1), expected.search, "WeebCentral search fixture");
  equalJSON(await module.extractDetails(expected.details.url), expected.details, "WeebCentral details fixture");
  equalJSON(await module.extractChapters(expected.details.url), expected.chapters, "WeebCentral complete chapter fixture");
  equalJSON(await module.extractImages(expected.chapters[0].url), expected.images, "WeebCentral image fixture");
}

async function testMangaFire() {
  const fixtures = {
    search: await textFile("modules/mangafire/fixtures/search.json"),
    details: await textFile("modules/mangafire/fixtures/details.json"),
    chapters1: await textFile("modules/mangafire/fixtures/chapters-page-1.json"),
    chapters2: await textFile("modules/mangafire/fixtures/chapters-page-2.json"),
    chapter: await textFile("modules/mangafire/fixtures/chapter.json"),
    structuredPages: await textFile("modules/mangafire/fixtures/pages.json"),
  };
  const expected = await JSONFile("modules/mangafire/fixtures/expected.json");
  const pagev2 = async (task) => {
    assert.equal(new URL(task.url).hostname, "mangafire.to");
    if (new URL(task.url).pathname === "/browse") {
      assert.equal(task.captureResponseBodies, true);
      return {
        finalURL: task.url,
        title: "",
        html: null,
        events: [{
          phase: "response",
          url: "https://mangafire.to/api/titles?keyword=fixture&vrf=fixture",
          body: fixtures.search,
        }],
        cookies: {},
        evaluatedData: null,
      };
    }
    assert.ok(new URL(task.url).pathname.startsWith("/api/"));
    assert.equal(task.returnScript, "document.body ? document.body.innerText : ''");
    assert.equal(task.captureResponseBodies, false);
    let body;
    const url = new URL(task.url);
    if (url.pathname === "/api/titles" || url.pathname === "/api/top-titles") body = fixtures.search;
    else if (url.pathname === "/api/titles/fixture/chapters") body = url.searchParams.get("page") === "2" ? fixtures.chapters2 : fixtures.chapters1;
    else if (url.pathname === "/api/titles/fixture") body = fixtures.details;
    else if (url.pathname === "/api/chapters/9001") body = fixtures.chapter;
    else if (url.pathname === "/api/chapters/9002") body = fixtures.structuredPages;
    else throw new Error(`Unexpected MangaFire URL: ${task.url}`);
    return {
      finalURL: task.url,
      title: "",
      html: `<html><body><pre>${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre></body></html>`,
      events: [],
      cookies: {},
      evaluatedData: body,
    };
  };
  const module = await loadModule("mangafire", { pagev2, reportProgress: async () => ({ ok: true }) });
  equalJSON(await module.searchResults("fixture", 1), expected.search, "MangaFire search fixture");
  equalJSON(await module.extractDetails(expected.details.url), expected.details, "MangaFire details fixture");
  equalJSON(await module.extractChapters(expected.details.url), expected.chapters, "MangaFire paginated chapter fixture");
  equalJSON(await module.extractImages(expected.chapters[0].url), expected.images, "MangaFire image-marker fixture");
  const structured = await module.extractImages("9002");
  assert.equal(structured[1].scrambled, true, "MangaFire structured scramble flag");
  assert.equal(structured[1].scrambleKey, "fixture-key", "MangaFire structured scramble key");
  equalJSON(structured[1].tiles, { rows: 4, columns: 4, order: [3, 0, 1, 2] }, "MangaFire tile metadata");
}

async function testInternetArchive() {
  const fixtures = {
    search: await textFile("modules/internet-archive/fixtures/search.json"),
    open: await textFile("modules/internet-archive/fixtures/metadata-open.json"),
    closed: await textFile("modules/internet-archive/fixtures/metadata-closed.json"),
    text: await textFile("modules/internet-archive/fixtures/text.txt"),
  };
  const expected = await JSONFile("modules/internet-archive/fixtures/expected.json");
  const fetchv2 = async (url, headers, method, body, options) => {
    assert.equal(typeof url, "string", "Internet Archive must use positional fetchv2");
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.ok(options.maxBytesHint > 0);
    if (url.includes("/advancedsearch.php?")) return mockResponse(fixtures.search, "application/json");
    if (url.includes("/metadata/open-fixture")) return mockResponse(fixtures.open, "application/json");
    if (url.includes("/metadata/closed-fixture")) return mockResponse(fixtures.closed, "application/json");
    if (url.includes("/download/open-fixture/fixture_book_djvu.txt")) return mockResponse(fixtures.text, "text/plain");
    throw new Error(`Unexpected Internet Archive URL: ${url}`);
  };
  const module = await loadModule("internet-archive", { fetchv2 });
  equalJSON(await module.searchResults("fixture", 1), expected.search, "Internet Archive open-license search fixture");
  equalJSON(await module.extractDetails("open-fixture"), expected.details, "Internet Archive details fixture");
  equalJSON(await module.extractChapters("open-fixture"), expected.chapters, "Internet Archive text-section fixture");
  equalJSON(await module.extractResources("open-fixture"), expected.resources, "Internet Archive resources fixture");
  assert.equal(await module.extractText(expected.chapters[0].url), fixtures.text, "Internet Archive text fixture");
  await assert.rejects(() => module.extractDetails("closed-fixture"), /not explicitly open/i);
}

const index = await validateCatalogue();
await testWeebCentral();
await testMangaFire();
await testInternetArchive();

console.log(`Validated ${index.modules.length} manifests, all deterministic fixtures, JSON, PNG assets, no ZIPs${skipHashes ? ", hashes skipped" : ", and all SHA-256 descriptors"}.`);
