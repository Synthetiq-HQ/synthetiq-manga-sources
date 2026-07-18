# Module Health Report

**Product:** Synthetiq Books (module-only iOS app)
**Repository:** `Synthetiq-HQ/synthetiq-manga-sources`
**Catalogue:** `index.json` (`schemaVersion` 1)
**Generated:** 2026-07-18
**Module count:** 12

## Summary

| Status | Count | Notes |
|--------|------:|-------|
| Active (stable) | 3 | WeebCentral, MangaFire, Internet Archive |
| Active (beta) | 7 | Hub scrapers + single-series modules |
| Retired | 2 | MangaDex awaits iOS runtime proof; Gachiakuta is upstream preview-only |
| CAPTCHA/CF bypass | 0 | Not implemented; modules fail closed on challenges |
| Silent default repo | No | App installs only user-added repositories |

Health below combines **fixture unit tests** (`npm test`), **live smoke** (`npm run test:live` / module tester), and authoring notes. Live results vary with upstream availability, rate limits, and region.

## Inventory

| # | Module ID | Folder | Type | Track | Base host | Terminal | Icon strategy |
|---|-----------|--------|------|-------|-----------|----------|---------------|
| 1 | `weebcentral-v2` | `weebcentral` | hub | stable | weebcentral.com | page images | Site favicon/logo |
| 2 | `mangafire-v2` | `mangafire` | hub | stable | mangafire.to | page images (+ interactive) | Site favicon |
| 3 | `internet-archive` | `internet-archive` | hub (texts) | stable | archive.org | text / publication resources | Official glogo |
| 4 | `mangadex` | `mangadex` | hub (API) | stable, retired | api.mangadex.org | page images | Branded initials (MD) |
| 5 | `mangakatana` | `mangakatana` | hub | beta | mangakatana.com | page images | Branded initials (MK) |
| 6 | `mgread` | `mgread` | hub | beta | mgread.io | page images | Site favicon |
| 7 | `black-clover` | `black-clover` | single-series | beta | blackcloveronline.com | page images | Branded initials (BC) |
| 8 | `kagurabachi` | `kagurabachi` | single-series | beta | thekagurabachi.com | page images | Branded initials (KB) |
| 9 | `beginning-after-the-end` | `beginning-after-the-end` | single-series | beta | thebeginningaftertheendmanga.com | page images | Branded initials (BT) |
| 10 | `solo-leveling` | `solo-leveling` | single-series | beta | thesololevelingmanga.com | page images | Branded initials (SL) |
| 11 | `gachiakuta` | `gachiakuta` | single-series | beta, retired | gachiakuta.com.lv | preview only | Branded initials (GA) |
| 12 | `haikyuu` | `haikyuu` | single-series | beta | read-haikyuu.com | page images | Branded initials (HQ) |

All modules: `contentRating` suggestive (except Internet Archive `unknown`), language `en` (Archive `multi`), `contractVersion` 1.

## Per-module status

### Hubs (multi-title)

#### WeebCentral (`weebcentral-v2` / v4.0.1)
- **Fixtures:** Pass (search, details, chapters, images).
- **Live (last known):** Generally healthy for popular listings and chapter pages when host is reachable; CDN hosts under `allowedHosts` (`compsci88`, `planeptune`).
- **Risks:** HTML structure drift; image CDN host changes.
- **Legal posture:** Third-party catalogue; no CAPTCHA bypass in module.

#### MangaFire (`mangafire-v2` / v2.0.1)
- **Fixtures:** Pass (JSON chapter/page paths + descramble token path).
- **Live (last known):** Works when API/HTML endpoints respond; may require `interactivePage` / pagev2 for some flows.
- **Risks:** Endpoint churn; image descramble offset changes.
- **Legal posture:** Aggregator; no CF bypass.

#### Internet Archive Open Texts (`internet-archive` / v1.0.0)
- **Fixtures:** Pass (search, open/public/restricted metadata, text, resources).
- **Live (last known):** Strong when Archive API is up; correctly refuses restricted items without open downloads.
- **Risks:** Rate limits; item rights variability (module filters for open text/EPUB/PDF).
- **Legal posture:** Preferred authorized source for public-domain / openly licensed texts.

#### MangaDex (`mangadex` / v1.0.0, retired)
- **Fixtures:** Pass (API search, details, chapters, at-home images).
- **Live (last known):** Healthy against official API; some popular titles are external-only or language-restricted for EN — tester retries candidates.
- **Risks:** API policy/rate limits; at-home server selection.
- **Publication status:** Retired pending direct iOS/WebKit runtime proof. It is not installable from the current index.

#### MangaKatana (`mangakatana` / v1.0.0)
- **Fixtures:** Pass.
- **Live (last known):** Intermittent; HTML scraping sensitive to markup/WAF.
- **Risks:** Soft blocks; selector drift. Track: **beta**.
- **Legal posture:** Aggregator; fail closed on challenges.

#### MGRead / LikeManga (`mgread` / v1.0.0)
- **Fixtures:** Pass.
- **Live (last known):** Variable; host may 403 bots without browser-like pagev2.
- **Risks:** Domain aliases (`likemanga.io`); bot mitigation. Track: **beta**.
- **Legal posture:** Aggregator; no CAPTCHA bypass.

### Single-series modules

These modules expose one series home as discovery/popular and scrape chapter lists/pages from series-dedicated sites.

| Module | Fixtures | Live (last known) | Notes |
|--------|----------|-------------------|-------|
| Black Clover Online | Pass | Intermittent | Host aliases include `blackclover.com.lv` |
| Kagurabachi | Pass | Intermittent | Site may 5xx; favicon often unavailable |
| The Beginning After The End | Pass | Intermittent | Lightweight series scraper |
| Solo Leveling | Pass | Intermittent | Same pattern as TBATE |
| Gachiakuta | Pass parser fixture; retired | Preview-only upstream page | Chapter 172 identifies itself as a preview post and exposes one preview image; do not install |
| Haikyuu | Pass | Intermittent | Image hosts under `qubn.us` |

**Common risks:** Theme/plugin updates, chapter URL patterns, aggressive anti-bot. **Track remains beta** until sustained live green in CI.

## Test matrix

| Layer | Command | Scope |
|-------|---------|--------|
| Unit + fixtures | `npm test` | All modules: fixture expected.json, validate, verify index hashes |
| App-shaped live probe | `npm run test:module` | Node `vm` walk: load → discovery/search → details → chapters → terminal (**not** full iOS install/WebKit/library) |
| Reports | `npm run test:module:report` | Writes `reports/module-test-latest.json` + `.html` |
| Live smoke | `npm run test:live` | Optional network smoke (`RUN_LIVE_TESTS=1`) |
| Hash finalize | `npm run finalize` | Regenerates icon/entry/manifest sha256 in manifests + index |

### Last known fixture gate

Run on this readiness pass: `npm test` after icon hash finalize — **must be green** before publishing index.

### Last known live (module tester)

Artifacts:

- `reports/module-test-latest.json`
- `reports/module-test-latest.html`

**2026-07-18 live full active-catalogue run:**

- All **10 active** modules passed `discoveryHome/search → details → chapters → terminal content`.
- Page-image modules additionally resolved and fetched the **first, middle, and final** image of the sampled chapter, checking HTTPS, declared host allow-list, response status, non-empty bytes, and image content type/magic.
- Gachiakuta was then retired after direct inspection showed the sampled upstream chapter was explicitly a preview post containing one preview image, not a full readable chapter.
- MangaDex also passed the live module run but remains retired in the public index until it receives direct iOS/WebKit runtime proof.

**Historical 2026-07-14 live sample:**

| Module | Result | Total ms | Notes |
|--------|--------|---------:|-------|
| mangadex | PASS | 1806 | discovery 476ms · details 129ms · chapters 941ms · images 256ms |
| weebcentral | PASS | 762 | discovery 393ms · details 135ms · chapters 182ms · images 44ms |

Fixture-mode app-shaped probe report: `npm run test:module:report:fixtures` exercises all 12 modules offline (Node `vm` only — not full iOS install/WebKit/library). When a full live run is not available in CI, treat unlisted modules as **unknown / intermittent** rather than green.

## Lifecycle notes

1. **Install path:** App loads GitHub `index.json` → user installs → loose `manifest.json` + `index.js` + `icon.png` staged under Application Support with sha256 checks.
2. **Runtime:** WebKit bridge (`fetchv2` / `pagev2`) with host allow-lists from each manifest.
3. **Uninstall:** Library manga rows and offline chapter downloads **must retain** stored metadata/URLs so entries survive module removal (source-missing UX).
4. **No silent defaults:** Empty library/sources until the user adds a repository and installs modules.

## Icon hash finalize

After any icon change:

```bash
node scripts/finalize-hashes.mjs
npm test
```

Icons are square **256×256 PNG**. Hub modules prefer site logos/favicons when publicly fetchable; single-series modules use consistent branded initials when covers/logos are unavailable without bypass.

## Recommended next health actions

1. Schedule weekly `npm run test:module:report -- --limit 12` (or full) and archive HTML under CI artifacts.
2. Promote beta hubs to stable only after 3 consecutive live greens.
3. Prefer MangaDex + Internet Archive in App Store marketing language (authorized / public API).
4. Re-scrape single-series hosts only when fixtures still pass and robots/ToS allow automated access patterns used by the app.
