# Sources Roadmap — Expanding the Module Catalogue

**Date:** 2026-07-17  
**Status:** Planning + prioritization (not a promise of ship dates)

## Already shipping (public index)

| Module | Type | Notes |
|--------|------|--------|
| WeebCentral | Multi-title | Primary reliable aggregator for EN reading |
| MangaFire | Multi-title | Interactive/`pagev2`; higher maintenance |
| MangaKatana | Multi-title | HTML scrape |
| MGRead | Multi-title | HTML scrape |
| Internet Archive | Publications | Official APIs only |
| Solo Leveling, Haikyuu, Black Clover, Kagurabachi, TBATE, Gachiakuta | Single-series | Dedicated sites; real cover icons |
| MangaDex | Multi-title | **Retired** (cover/chapter reliability) |

## Batch 1 — High value, usually scrape-friendly

Evaluate with a 30‑minute spike each: home, search, details, chapters, images, CF difficulty.

| Candidate | Why | Risk |
|-----------|-----|------|
| Flame Comics (or current domain) | Popular EN catalogue; often in Tachiyomi ecos | Domain changes; CF |
| Asura-class mirrors (only if stable + legal comfort) | Fast releases | Mirrors die; aggressive ads |
| Mangapill / similar list UIs | Predictable HTML | Quality variance |
| Comick-style APIs (if public & ToS-ok) | Structured data | API auth / ToS |
| Cubari / proxy JSON lists | User-curated lists | Not a full catalogue |
| Bato-style (if allowedHosts + complexity OK) | Large library | Complexity, CF |

## Batch 2 — Official / cleaner APIs

| Candidate | Why | Risk |
|-----------|-----|------|
| MangaPlus (if policy allows official reader APIs) | Legal clarity | Region locks; image crypto |
| Webtoon / Tapas public previews only | Legal | Not full offline manga |
| Publisher RSS / public chapter lists | Clean | Sparse |

## Batch 3 — Community single-series

Any stable “read-TITLE.com” style site can become a module in <1 day using the Haikyuu template:

1. Copy `modules/haikyuu`  
2. Swap base URL + cover icon  
3. Adjust chapter/image selectors  
4. Fixtures + hashes + version bump  

## Rejection criteria (do not module)

- Hard Cloudflare/CAPTCHA on every request  
- Requires account login for every chapter  
- Paywall / DRM page images  
- Pure ad-redirect interstitial chains  
- Sites that only work with desktop cookie farms  

## Process for adding one module

1. Spike live endpoints (document URLs).  
2. Draft `allowedHosts`.  
3. Implement `index.js` + fixtures.  
4. `validate.mjs` + live smoke.  
5. PR to sources repo; retire if domain dies.  

## App-side support needed for scale

- Faster module update UX (batch update)  
- Per-source health badge from last live probe  
- Optional community repo pinning in docs (never silent install)
