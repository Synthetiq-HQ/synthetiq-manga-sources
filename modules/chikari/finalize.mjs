import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = async p => createHash('sha256').update(await readFile(path.join(root, p))).digest('hex');
const icon = { path: 'modules/chikari/icon.png', sha256: await hash('modules/chikari/icon.png') };
const manifest = {
  contractVersion: 1, id: 'chikari', familyID: 'chikari', legacyIDs: [], name: 'Chikari', version: '1.0.0',
  minimumAppVersion: '1.0.0', language: 'en', contentType: 'pageImages', contentRating: 'suggestive',
  releaseTrack: 'beta', status: 'active', description: 'Chikari manga, manhwa and manhua. Non-adult comics only.',
  baseURL: 'https://chikari.moe', universalLink: 'https://chikari.moe',
  capabilities: ['popular', 'latest', 'search', 'details', 'chapters', 'images', 'imageRequest', 'discovery'],
  entry: { path: 'modules/chikari/index.js', sha256: await hash('modules/chikari/index.js') }, icon,
  allowedHosts: ['chikari.moe', 'cdn.chikari.moe'],
  limits: { timeoutMilliseconds: 30000, maxConcurrentRequests: 2, maxResponseBytes: 4194304, maxScriptBytes: 262144, cacheTTLSeconds: 300 },
  attribution: { author: 'Synthetiq-HQ', website: 'https://chikari.moe', licenseName: null, licenseURL: null, authorizationURL: null }
};
await writeFile(path.join(root, 'modules/chikari/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const indexPath = path.join(root, 'index.json');
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const entry = Object.fromEntries(['id','familyID','name','version','language','contentType','contentRating','releaseTrack','status'].map(k => [k, manifest[k]]));
entry.manifest = { path: 'modules/chikari/manifest.json', sha256: await hash('modules/chikari/manifest.json') };
entry.icon = icon;
const at = index.modules.findIndex(x => x.id === manifest.id);
if (at < 0) index.modules.push(entry); else index.modules[at] = entry;
await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log('Finalized Chikari only:', entry.manifest.sha256);
