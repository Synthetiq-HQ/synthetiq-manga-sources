import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import assert from "node:assert/strict";

// Reuses an explicitly opened test browser. Never exports its cookies or signed URLs.
if (process.env.RUN_LIVE_TESTS !== "1" || !process.env.PLAYWRIGHT_CLI) {
  throw new Error("Set RUN_LIVE_TESTS=1 and PLAYWRIGHT_CLI to the Playwright CLI wrapper; open session books-ocean first.");
}
function browser(code) {
  let output;
  try {
    output = execFileSync(process.env.PLAYWRIGHT_CLI, ["-s=books-ocean", "run-code", code],
      { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    throw new Error("Browser probe failed or timed out. Inspect the test browser; request URLs are intentionally omitted.");
  }
  const match = output.match(/### Result\n([\s\S]*?)\n### /);
  if (!match) throw new Error("Browser probe returned no structured result.");
  return JSON.parse(match[1]);
}
const moduleSource = await readFile(new URL("../modules/oceanofpdf/index.js", import.meta.url), "utf8");
const context = vm.createContext({ URL, Date,
  pagev2: async task => ({ evaluatedData: browser(`async page => {
    await page.goto(${JSON.stringify(task.url)});
    await page.waitForSelector("main", { timeout: 18000 });
    return await page.evaluate(${JSON.stringify(task.returnScript)});
  }`) }),
  fetchv2: async (url, headers, method, body) => {
    const result = browser(`async page => {
    const response = await page.request.fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)},
      data: ${JSON.stringify(body)}, maxRedirects: 0, timeout: 25000
    });
    return { status: response.status(), finalUrl: response.url(), body: await response.text() };
  }`);
    if (process.env.DEBUG_RESOLUTION === "1") {
      const links = (result.body.match(/https:\/\/fs\d+\.oceanofpdf\.com\/[^\s'"<>\\]+/g) || [])
        .map(value => { const link = new URL(value); return {host:link.host, path:link.pathname, expires:link.searchParams.get("expires")}; });
      console.log(JSON.stringify({status:result.status, requested:new URLSearchParams(body).get("filename"), links}));
    }
    return result;
  },
});
vm.runInContext(moduleSource, context, { timeout: 1000 });
const api = context.SynthetiqModule;
const home = await api.discoveryHome();
assert.ok(home.sections[0].items.length);
assert.ok(home.sections[0].items.some(item => item.coverURL));
const next = await api.discoveryFeed("recently-added", 2);
assert.ok(next.items.length);
const search = await api.searchResults("Pride and Prejudice");
assert.ok(search.items.length);
const searchNext = await api.searchResults("Pride and Prejudice", 2);
assert.ok(searchNext.items.length);
console.log(JSON.stringify({ discovery: home.sections[0].items.length, nextPage: next.items.length,
  search: search.items.length, searchNext: searchNext.items.length }));

for (const id of [
  "https://oceanofpdf.com/authors/jane-austen/pdf-pride-and-prejudice-download/",
  "https://oceanofpdf.com/authors/mary-wollstonecraft-shelley/pdf-epub-frankenstein-download-61935698295/",
]) {
  const details = await api.extractDetails(id);
  assert.ok(details.title && details.coverURL);
  const resources = await api.extractResources(id);
  assert.ok(resources.length);
  // HEAD checks avoid retrieving complete publication contents.
  const files = resources.map(resource => browser(`async page => {
    const response = await page.request.head(${JSON.stringify(resource.url)}, {timeout:25000, maxRedirects:0});
    return { format:${JSON.stringify(resource.format)}, status:response.status(),
      type:response.headers()["content-type"], bytes:response.headers()["content-length"] };
  }`));
  for (const file of files) assert.equal(file.status, 200);
  console.log(JSON.stringify({ title: details.title, files }));
}

if (process.env.FETCH_SOURCE_ICON === "1") {
  const asset = browser(`async page => {
    const response = await page.request.get("https://media.oceanofpdf.com/2019/09/cropped-favicon-4-192x192.png");
    return {status:response.status(), data:(await response.body()).toString("base64")};
  }`);
  assert.equal(asset.status, 200);
  const bytes = Buffer.from(asset.data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await writeFile(new URL("../modules/oceanofpdf/icon.png", import.meta.url), bytes);
  console.log("Official PNG icon verified.");
}
console.log("Browser-bridge live checks passed. This is not native iOS reader verification.");
