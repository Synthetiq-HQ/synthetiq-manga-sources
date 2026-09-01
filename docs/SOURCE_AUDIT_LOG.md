# Source Audit Log

**Product:** Synthetiq Books module repository  
**Audit date:** 2026-08-31  
**Current queue item:** MangaBuddy (`https://mangabuddy.com/`, currently Comizy)  
**Publication state:** Comix removed from the active catalogue; its files are retained for recovery while MangaBuddy is evaluated locally

## Evidence labels

- **FIXTURE PASS** — deterministic offline module and repository tests passed.
- **LIVE PASS** — a bounded check through ordinary public HTTPS/browser behavior passed.
- **RUNTIME PASS** — the real Books bridge passed; not claimed by this Windows-only audit.
- **DEVICE PASS** — the installed iOS/iPad app passed; not claimed here.
- **BLOCKED** — ordinary access returned a challenge/error; no bypass was attempted.
- **REACHABLE / UNASSESSED** — ordinary access responded, but no module has been accepted yet.

## Queue audit

This is a triage log, not a claim that every reachable site is suitable for a module.

| Queue | Source | Result | Action |
|---:|---|---|---|
| 1 | MangaBall | EXISTING | Previously handled; keep its current module. |
| 2 | Atsu | EXISTING | Previously handled; keep its current module. |
| 3 | Onisaga | SKIPPED | Skipped at the owner's direction. |
| 4 | Kagane | BLOCKED | HTTP 403 Cloudflare challenge; no module started. |
| 5 | AquaReader | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 6 | Comick | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 7 | Comix | REMOVED | Removed from the active catalogue after the owner reported a title-specific Bleach failure; historical files retained for recovery. |
| 8 | MangaDot | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 9 | MangaBuddy | LOCAL DRAFT / CURRENT | HTTP 200; local module draft is being unit-tested before publication. |
| 10 | QToon | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 11 | Specter Scans | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 12 | Mangago | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 13 | MangaFire | EXISTING | Existing module; no duplicate created. |
| 14 | AllManga | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 15 | MangaKakalot | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 16 | Asura | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 17 | Batcave | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 18 | ReadComicsOnline | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 19 | MangaHub | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 20 | WeebCentral | EXISTING | Existing module; no duplicate created. |
| 21 | MangaKatana | EXISTING | Existing module; no duplicate created. |
| 22 | LikeManga | EXISTING | Covered by the existing MGRead module. |
| 23 | MangaXO | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |
| 24 | AllManga (duplicate) | DUPLICATE | Same queue source as item 14. |
| 25 | KingOfShojo | REACHABLE / UNASSESSED | HTTP 200; queued for a separate bounded evaluation. |

## Comix module (historical release; removed from catalogue)

**Module:** `comix`  
**Version:** `1.0.5`
**Track:** beta  
**Type:** `pageImages`  
**Source:** `https://comix.to/`  
**Catalogue status:** Removed from `index.json` on 2026-09-01 at the owner's request after the module failed on the Bleach title. The source files and historical tests remain in the repository so the removal is recoverable.  
**Reader media:** `*.wowpic1.store/i5/` and `*.wowpic2.store/i5/` (declared in the manifest)

The module uses direct server-rendered HTML for the home feed and title details. Search, chapter pagination, and reader-page discovery use the app's normal `pagev2` browser bridge so the source's own browser session owns its client-side state. The module does not call the source's protected API directly, extract its token, decrypt its responses, or bypass a challenge.

The chapter parser is title-scoped, deduplicates by full chapter URL rather than chapter number, preserves decimal chapter numbers, and follows both the arrow and numbered pagination controls. The 1.0.5 path uses the source's Last page control, then collects ordinary source title pages in bounded same-origin browser-frame batches, with sequential fallback if a frame cannot load. The reader parser walks the source's lazy page containers and returns only the source's own loaded image resources. Page images are returned with the source-page `Referer` header.

## Comix evidence

### FIXTURE PASS

- `node --check modules/comix/index.js` — passed.
- `node --test tests/modules.test.mjs` — **35/35 passed**.
- `npm run test:module:fixtures -- comix` — **1/1 passed**.
- Fixture coverage includes search, discovery, details, duplicate chapter releases, decimal chapter numbers, browser pagination markers, reader image URLs, progress reporting, and invalid-host rejection.
- The repository fixture harness recorded `fetchv2: 2` and `pagev2: 4` bridge calls for the Comix flow.

### LIVE PASS (bounded ordinary browser checks)

Checks were performed against the public site in a normal browser session and did not bulk-download books:

- `browse?q=chainsaw` rendered 23 title results, including Chainsaw Man.
- Chainsaw Man's chapter UI traversed 60 pagination pages and produced 1,190 unique chapter links, from chapter 232 through chapter 0.
- The module-generated reader action returned 30/30 page image URLs for chapter 232.
- First, middle, and last sampled image requests returned 200 with `image/webp` and non-zero bodies: 427,632 bytes, 239,154 bytes, and 287,164 bytes.
- Sampled first/last reader pages were visually readable; no cropping or tile-jumbling was observed in the checked pages.
- Direct module parsing of the live home page and Chainsaw Man details returned 50 Popular items, 31 Latest items, the correct title, a 297-character synopsis, and genres.
- The Good Student's title HTML returned in roughly 0.13–0.34 seconds; the module-generated chapter action collected 147 unique chapters across eight browser pages in roughly 1.9 seconds once the title page was available.
- The 1.0.5 generated action returned 147 unique chapters across eight pages in roughly 1.7 seconds in a real browser, including the bounded frame collection and completion marker.
- The live browse continuation returned a full 28-item page 2 and exposed an active next page, so discovery feeds no longer stop after the first home batch or return an artificially trimmed six-card page.
- A real-browser reproduction of the same bounded frame strategy returned all 1,190 Chainsaw Man chapter links across 60 pages in roughly 8.1 seconds; this metadata check did not load reader images.
- After the timing fix, the actual module-generated reader action returned 116/116 image URLs for the `wowpic2.store` A Sibling's POV chapter.

The first cross-title sweep exposed that the reader CDN rotates between `wowpic1.store` and `wowpic2.store`. The module was corrected to declare and recognize both observed families, and the same sweep was rerun:

| Title | Sampled chapter | Page containers | Image resources | Result |
|---|---:|---:|---:|---|
| Special A | 99.5 | 4 | 4 | PASS |
| Anyone Can See It's A Beast | 64 | 94 | 94 | PASS |
| The Ruined World Was Mistaken for a Game | 21 | 122 | 122 | PASS |
| A Strange Phenomenon | 18 | 120 | 120 | PASS |
| A Sibling's POV | 21 | 116 | 116 | PASS |

Cross-title result: **5/5 passed**, 456/456 page resources observed. The sampled chapters were current/latest entries from each title, not a 20/30-title random-chapter statistical score.

### Not yet claimed

- **RUNTIME PASS:** pending execution inside the Synthetiq Books `pagev2` bridge.
- **DEVICE PASS:** pending installation/update and verification on iPad/iOS.
- `npm run test:module -- comix` is **PARTIAL** in the Node harness: its emulated `pagev2` returns HTML but does not execute browser action scripts, so Comix correctly reports `Comix search returned no browser data.` This is not runtime/device evidence.
- A 20/30-title random-chapter statistical score remains a follow-up acceptance pass before promoting the beta module to stable.

## Files changed for this candidate

- `modules/comix/manifest.json`
- `modules/comix/manifest-1.0.4.json`
- `modules/comix/manifest-1.0.5.json`
- `modules/comix/index.js`
- `modules/comix/icon.png`
- `modules/comix/fixtures/`
- `index.json`
- `tests/source-test-policy.json`
- `scripts/module-tester.mjs`
- `tests/modules.test.mjs`

The 1.0.5 beta is ready for public update testing. Runtime and iPad/device acceptance remain separate checks because this audit environment cannot execute the installed Books bridge.
