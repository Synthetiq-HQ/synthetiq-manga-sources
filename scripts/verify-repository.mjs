import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const expectedHandlers = {
  "internet-archive": ["searchResults", "extractDetails", "extractText", "extractResources"],
  mangafire: ["searchResults", "extractDetails", "extractChapters", "extractImages"],
  weebcentral: ["searchResults", "extractDetails", "extractChapters", "extractImages"],
};

function fail(message) {
  failures.push(message);
}

async function sha256(relativePath) {
  const data = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(data).digest("hex");
}

async function readJSON(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

function validRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..")
    && !value.includes("://");
}

async function verifyDescriptor(label, descriptor) {
  if (!descriptor || !validRelativePath(descriptor.path)) {
    fail(`${label}: invalid asset path`);
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 || "")) {
    fail(`${label}: invalid SHA-256`);
    return;
  }
  try {
    const actual = await sha256(descriptor.path);
    if (actual !== descriptor.sha256) fail(`${label}: hash mismatch for ${descriptor.path}`);
  } catch (error) {
    fail(`${label}: missing asset ${descriptor.path} (${error.message})`);
  }
}

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

const allFiles = await walk(root);
for (const file of allFiles) {
  if (/\.zip$/i.test(file)) fail(`${file}: ZIP files are not allowed`);
  if (file.endsWith(".json")) await readJSON(file);
}

const index = await readJSON("index.json");
if (index) {
  if (index.schemaVersion !== 1) fail("index.json: schemaVersion must be 1");
  if (!Array.isArray(index.modules) || index.modules.length !== 3) fail("index.json: expected exactly three modules");
  const identities = new Set();

  for (const entry of index.modules || []) {
    const entryIdentities = new Set([entry.id, entry.familyID].map((identity) => String(identity || "").toLowerCase()));
    for (const identity of entryIdentities) {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(identity || "")) fail(`index.json: invalid identity ${identity}`);
      if (identities.has(identity)) fail(`index.json: duplicate identity ${identity}`);
      identities.add(identity);
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version || "")) fail(`${entry.id}: invalid version`);
    await verifyDescriptor(`${entry.id} manifest`, entry.manifest);
    await verifyDescriptor(`${entry.id} icon`, entry.icon);

    const manifest = entry.manifest?.path ? await readJSON(entry.manifest.path) : null;
    if (!manifest) continue;
    for (const key of ["id", "familyID", "name", "version", "language", "contentType", "contentRating", "releaseTrack", "status"]) {
      if (manifest[key] !== entry[key]) fail(`${entry.id}: index/manifest mismatch for ${key}`);
    }
    if (JSON.stringify(manifest.icon) !== JSON.stringify(entry.icon)) fail(`${entry.id}: index/manifest icon mismatch`);
    if (manifest.contractVersion !== 1) fail(`${entry.id}: contractVersion must be 1`);
    if (!Array.isArray(manifest.allowedHosts) || manifest.allowedHosts.length === 0) fail(`${entry.id}: allowedHosts is empty`);
    if (!manifest.allowedHosts.some((host) => new URL(manifest.baseURL).hostname === host)) fail(`${entry.id}: base host is not explicitly allowed`);
    if ((manifest.limits?.maxScriptBytes || 0) > 512 * 1024) fail(`${entry.id}: maxScriptBytes exceeds app contract`);
    await verifyDescriptor(`${entry.id} entry`, manifest.entry);
    await verifyDescriptor(`${entry.id} manifest icon`, manifest.icon);
    for (const [fixtureIndex, fixture] of (manifest.fixtures || []).entries()) {
      await verifyDescriptor(`${entry.id} fixture ${fixtureIndex}`, fixture);
    }

    const moduleFolder = path.basename(path.dirname(entry.manifest.path));
    const source = await readFile(path.join(root, manifest.entry.path), "utf8");
    for (const handler of expectedHandlers[moduleFolder] || []) {
      if (!new RegExp(`\\b${handler}\\b`).test(source)) fail(`${entry.id}: missing ${handler} export`);
    }
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) fail(`${entry.id}: dynamic code evaluation is forbidden`);
    if (/\b(?:localStorage|sessionStorage)\s*\./.test(source)) fail(`${entry.id}: browser storage is forbidden`);
    const scriptSize = (await stat(path.join(root, manifest.entry.path))).size;
    if (scriptSize > manifest.limits.maxScriptBytes) fail(`${entry.id}: script exceeds declared maxScriptBytes`);

    const icon = await readFile(path.join(root, manifest.icon.path));
    if (!icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`${entry.id}: icon is not a PNG`);
  }
}

if (failures.length > 0) {
  console.error(`Repository verification failed (${failures.length}):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`Repository verification passed: ${allFiles.length} files, 3 modules, all hashes exact.`);
}
