import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "index.json");

async function JSONFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256(relativePath) {
  const bytes = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

const index = await JSONFile(indexPath);
for (const entry of index.modules) {
  const manifestPath = path.join(root, entry.manifest.path);
  const manifest = await JSONFile(manifestPath);
  manifest.entry.sha256 = await sha256(manifest.entry.path);
  manifest.icon.sha256 = await sha256(manifest.icon.path);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  entry.manifest.sha256 = await sha256(entry.manifest.path);
  entry.icon.sha256 = await sha256(entry.icon.path);
}
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

console.log(`Finalized SHA-256 descriptors for ${index.modules.length} modules.`);
