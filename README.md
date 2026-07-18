# Synthetiq Manga Sources

This is the loose-file module repository consumed by Synthetiq Manga. It is
separate from the app checkout and intentionally contains no module ZIPs.

| Module | Content | Network path |
| --- | --- | --- |
| WeebCentral | Page images | Direct HTTPS through `fetchv2` |
| MangaFire | Page images | Protected browser flow through `pagev2` |
| Internet Archive Open Texts | Text, EPUB, PDF | Official search, metadata, and download APIs through `fetchv2` |
| MangaDex | Page images | Official MangaDex API through `fetchv2` |
| MangaKatana | Page images | Direct HTTPS HTML through `fetchv2` |
| MGRead (LikeManga) | Page images | Direct HTTPS HTML through `fetchv2` (`mgread.io`; `likemanga.io` redirects) |
| Black Clover Online | Page images | Single-series `fetchv2` |
| Kagurabachi | Page images | Single-series `fetchv2` |
| The Beginning After The End | Page images | Single-series `fetchv2` |
| Solo Leveling | Page images | Single-series `fetchv2` |
| Gachiakuta | Page images | Single-series `fetchv2` |
| Haikyuu | Page images | Single-series `fetchv2` |

Run deterministic validation from this directory:

```sh
node scripts/validate.mjs
```

Run the explicitly network-dependent end-to-end smoke path with:

```sh
npm run test:live
```

Run the **app-shaped live probe** (Node `vm` handler walk: discovery/search → details → chapters → terminal content). This is **not** a full one-to-one iOS harness — it skips install, WebKit, library, and downloads:

```sh
# one module, live network
npm run test:module -- mangadex

# every module in index.json
npm run test:module

# fixture-only (no network)
npm run test:module:fixtures -- black-clover

# JSON + HTML report under reports/
npm run test:module:report
npm run test:module:report:fixtures
```

After changing an entry script or icon, finalize hashes and validate again:

```sh
node scripts/finalize-hashes.mjs
node scripts/validate.mjs
```

See [docs/FORMAT.md](docs/FORMAT.md), [docs/AUTHORING.md](docs/AUTHORING.md),
and [docs/SECURITY.md](docs/SECURITY.md) before changing a module.
