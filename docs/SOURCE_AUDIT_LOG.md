# Source Audit Log

**Product:** Synthetiq Books module repository  
**Audit date:** 2026-09-01
**Current queue item:** Attack on Titan single-series source (`https://w47.read-attackontitan-manga.com/`, queued; no module implemented)
**Queue overrides:** The owner temporarily moved Batcave to priority #1; it was deferred after ordinary HTTP returned a Cloudflare challenge and the browser sessions had no member access. AllManga was then audited: catalogue, details, and chapter metadata were reachable, but the reader redirected to `mkissa.to`, which returned the same Cloudflare challenge. The queue advanced to Asura Scans, then briefly to MangaXo; MangaXo was removed at the owner's request. KingOfShojo was checked next and rejected for adult/mature catalogue labels. Attack on Titan is now queued for URL-family and content review before implementation. A related-site inventory was then performed; twelve non-duplicate candidates are now queued behind Attack on Titan in fixed order. This queue does not create or publish modules.
**Publication state:** Comix, MangaBuddy, and MangaXo are removed from the active catalogue; their files/history are retained in Git history for recovery. Asura Scans beta is published at commit `ab56e9f`.

## Evidence labels

- **FIXTURE PASS** — deterministic offline module and repository tests passed.
- **LIVE PASS** — a bounded check through ordinary public HTTPS/browser behavior passed.
- **RUNTIME PASS** — the real Books bridge passed; not claimed by this Windows-only audit.
- **DEVICE PASS** — the installed iOS/iPad app passed; not claimed here.
- **BLOCKED** — ordinary access returned a challenge/error; no bypass was attempted.
- **REACHABLE / UNASSESSED** — ordinary access responded, but no module has been accepted yet.
- **LOCAL_COMPLETE** — an isolated module implementation and deterministic tests passed; publication is still pending.
- **LIVE_NODE_PASS** — a bounded live Node proof reached the source and terminal media; this is not iOS/device evidence.
- **REMOVED / CONTENT POLICY** — a module was removed from the active catalogue after owner review; it must not be treated as an available source.

## Content-suitability gate

Before implementing or publishing a new module, inspect the source's visible
genres, labels, ratings, and representative catalogue entries. Do not add
adult or sexualized sources. If a source is suggestive, unclassified, or lacks
a reliable safe exclusion path, stop and obtain content approval before any
module or index entry is created.

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
| 9 | MangaBuddy | REMOVED | Removed from the active catalogue after the owner rejected its adult/suggestive content; historical files retained for recovery. |
| 10 | QToon | SKIPPED | Live catalogue includes source-marked `UNCENSORED`, `Smut`, `Mature`, and `Ecchi` titles; no module published. |
| 11 | Specter Scans | SKIPPED | Public catalogue exposes an `Adult` genre, but cards do not carry reliable content tags for safe exclusion; no module published. |
| 12 | Mangago | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 13 | MangaFire | EXISTING | Existing module; no duplicate created. |
| 14 | AllManga | PARTIAL / DEFERRED | Public API exposed catalogue, details, and chapter metadata, but the reader redirected to `mkissa.to`, which returned HTTP 403 with `Cf-Mitigated: challenge`; no bypass or cookie extraction attempted. |
| 15 | MangaKakalot | PARTIAL / DEFERRED | Public response was HTTP 200 but contained challenge/captcha signals; no bypass attempted. |
| 16 | Asura | PUBLISHED_BETA / CURRENT | Public beta at commit `ab56e9f`; fixture, contract/hash, and bounded live quality proof passed 100% (79/79 checks) across six titles. Device/content-control testing remains. |
| 17 | Batcave | BLOCKED / DEFERRED | Owner moved this source to priority #1, but HTTPS, `www`, and HTTP returned HTTP 403 with `Cf-Mitigated: challenge`; the browser also showed members-only access without an existing login. No module was started and no bypass was attempted. |
| 18 | ReadComicsOnline | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 19 | MangaHub | BLOCKED | HTTP 403 challenge; no bypass attempted. |
| 20 | WeebCentral | EXISTING | Existing module; no duplicate created. |
| 21 | MangaKatana | EXISTING | Existing module; no duplicate created. |
| 22 | LikeManga | EXISTING | Covered by the existing MGRead module. |
| 23 | MangaXO | REMOVED / CONTENT POLICY | Briefly published at commit `025104a`, then removed at the owner's request. It is no longer in the active index; implementation evidence remains only as historical audit context. |
| 24 | AllManga (duplicate) | DUPLICATE | Same queue source as item 14. |
| 25 | KingOfShojo | REJECTED / CONTENT POLICY | Current public pages expose `Adult`, `Mature`, `Smut`, `Ecchi`, `Yaoi`, and `Manhwa Hot` labels plus an 18+/mature-content warning; no module started. |
| 26 | Attack on Titan single-series site | QUEUED / SAFETY + TECHNICAL REVIEW | Supplied URL is a third-party single-series host, not official Crunchyroll. Initial page shows public chapters and no adult label; rotating hosts, external CDN, and mature violence/horror require review before implementation. |
| 27 | Ichi the Witch | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable title-focused hub; process after Attack on Titan. No module or active index entry exists. |
| 28 | Sakamoto Days | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable title-focused hub; process after Ichi the Witch. No module or active index entry exists. |
| 29 | Blue Lock | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable through multiple title-focused hubs; process after Sakamoto Days. Extra catalogue on one hub requires title scoping. |
| 30 | One Punch Man | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable title-focused hub; process after Blue Lock. No module or active index entry exists. |
| 31 | Kingdom | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable title-focused hub; process after One Punch Man. War/violence review required. |
| 32 | Hunter x Hunter | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable title-focused hub; process after Kingdom. No module or active index entry exists. |
| 33 | Jujutsu Kaisen | QUEUED / SAFETY + TECHNICAL REVIEW | Three reachable title-focused variants; process after Hunter x Hunter. Layout and metadata differ between hosts. |
| 34 | Fairy Tail / Eden's Zero / Dead Rock | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable multi-series hub; process after Jujutsu Kaisen. Fan-service/violence review required. |
| 35 | Nanatsu no Taizai / Seven Deadly Sins | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable hub also exposes Four Horsemen; process after the Fairy Tail family. Fan-service/violence review required. |
| 36 | Tokyo Ghoul / Tokyo Ghoul:re | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable hub also exposes Choujin X; process after Seven Deadly Sins. Graphic horror/violence review required. |
| 37 | Chainsaw Man | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable hub also exposes related Fujimoto works; process after Tokyo Ghoul. Dark/violent themes require review. |
| 38 | Berserk | QUEUED / SAFETY + TECHNICAL REVIEW | Reachable numbered archive and reader pages; process last in this inventory batch. Mature/graphic-theme review required. |

## Attack on Titan URL-family reconnaissance

Source supplied by the owner: [w47.read-attackontitan-manga.com](https://w47.read-attackontitan-manga.com/).
This is not an official Crunchyroll URL. Official Crunchyroll Manga is a
separate subscription service and is not the source being queued here.

The supplied page is a single-series Attack on Titan catalogue with paths such
as `/attack-on-titan-manga` and `/manga/attack-on-titan-chapter-1/`. Its links
currently move between versioned hosts such as `w47`, `w40`, and `w46`, while
reader images are served from `cdn.mangagoa.xyz`. The page also links to the
broader Manga Goat network, whose visible home catalogue includes Attack on
Titan, One Piece, Blue Lock, Spy X Family, Black Clover, and other titles.
This is useful evidence for a shared layout, but it is not proof that every
show has identical paths or host behavior; each title must be discovered and
checked independently.

### Preliminary safety result

The supplied single-series page did not expose an `Adult` or `Smut` label, so
it is not rejected as an adult-only source at this stage. Attack on Titan is
still not child-safe: the official series listing carries content advisories
for nudity, profanity, and violence. The queue status therefore remains
`SAFETY + TECHNICAL REVIEW`; no module or active index entry has been created.

## Individual-title site inventory

The supplied Attack on Titan host is part of a larger network of title-focused
reading hubs. The network does not use one reliable domain formula: some roots
use `read<title>.com`, some use `read<title>manga.com`, and the live root often
redirects to a rotating `wN`/`wwN` host. A bounded ordinary-HTTPS check was
performed on the roots below, followed by inspection of chapter-shaped
navigation and a single chapter HTML page where available. Images were not
bulk-downloaded. A reachable root is not automatically safe or ready for a
module.

The Chainsaw Man hub's related-sites directory is the main discovery evidence:
it links to Ichi the Witch, Sakamoto Days, Kagurabachi, Kingdom, Solo Leveling,
Blue Lock, One Punch Man, Fairy Tail, Jujutsu Kaisen, Naruto, Berserk, and
other title hubs. The Blue Lock and Hunter x Hunter hubs also expose additional
series on their pages, so each future module must scope its title parser rather
than trusting the host name alone.

### Reachable title-focused hubs

| Title or hub | Observed entry URL(s) | Current result | Repo comparison | Safety gate / next action |
|---|---|---|---|---|
| Attack on Titan / Shingeki no Kyojin | `https://w47.read-attackontitan-manga.com/`; `https://readsnk.com/` | LIVE; both expose chapter lists, and the roots rotate to versioned hosts | Not in active index; Attack on Titan is already queue item #26 | Violence/horror review; remain queue #1; do not implement in this inventory pass |
| Chainsaw Man | `https://readchainsawman.com/` | LIVE; versioned root and chapter pages respond; the hub also carries Fujimoto-related works | Not in active index | Dark/violent themes; review before queue acceptance |
| Ichi the Witch | `https://readichithewitch.com/` | LIVE; versioned root exposes numbered chapters | Not in active index | No adult label observed in the bounded check; safety review still required |
| Sakamoto Days | `https://readsakadays.com/` | LIVE; versioned root exposes numbered and coloured chapters | Not in active index | No adult label observed in the bounded check; safety review still required |
| Kagurabachi | `https://readkagurabachimanga.com/` | LIVE; versioned root exposes chapter navigation | Active `kagurabachi` module already covers a different host | Duplicate source; do not queue until a separate-source reason is established |
| Kingdom | `https://readkingdom.com/` | LIVE; versioned root exposes numbered chapters and extra versions | Not in active index | War/violence review; candidate after gate |
| Solo Leveling / Ragnarok | `https://readsololeveling.org/` | LIVE; versioned root exposes Solo Leveling and Ragnarok chapters | Active `solo-leveling` module already exists on another host | Duplicate source; no new module until needed |
| Blue Lock | `https://bluelockread.com/`; `https://blue-lock-manga.com/`; `https://readbluelock-manga.com/` | LIVE; all three expose Blue Lock chapter navigation, with rotating hosts on the first two | Not in active index | No adult label observed in the bounded check; review the extra catalogue on `bluelockread.com` before queueing |
| Nanatsu no Taizai / Seven Deadly Sins | `https://read7deadlysins.com/` | LIVE; versioned root exposes Seven Deadly Sins and Four Horsemen chapters | Not in active index | Fan-service/violence review; candidate only after gate |
| Tokyo Ghoul / Tokyo Ghoul:re | `https://tokyoghoulre.com/` | LIVE; versioned root exposes Tokyo Ghoul, Tokyo Ghoul:re, and Choujin X links | Not in active index | Graphic horror/violence review; candidate only after gate |
| One Piece | `https://readonepiece.com/` | LIVE; versioned root exposes numbered and coloured chapters | Active `onepiece-manga-online` module already exists on a different host | Duplicate source; no new module until needed |
| One Punch Man | `https://readopm.com/` | LIVE; versioned root exposes chapter navigation and related series | Not in active index | No adult label observed in the bounded check; safety review still required |
| Fairy Tail / Eden's Zero / Dead Rock | `https://readfairytail.com/` | LIVE; versioned root exposes all three series | Not in active index | Fan-service/violence review; candidate only after gate |
| Jujutsu Kaisen | `https://readjujutsukaisen.com/`; `https://read-jjk.com/`; `https://readjujutsukaisen-manga.com/` | LIVE; all expose chapter-shaped pages, though the three layouts and metadata differ | Not in active index | Dark fantasy, death, and violence review; do not treat as safe-approved |
| Hunter x Hunter | `https://readhxh.com/` | LIVE; versioned root exposes Hunter x Hunter, coloured chapters, and related works | Not in active index | No adult label observed in the bounded check; safety review still required |
| Berserk | `https://readberserk.com/` | LIVE; root exposes a large numbered chapter archive and CDN-backed reader pages | Not in active index | Mature/graphic themes; hold for explicit content review |
| Black Clover | `https://readblack-clover.com/` | LIVE; versioned root exposes genres and a numbered chapter archive; the older linked `readblackclover.com` root was unavailable | Active `black-clover` module already exists on another host | Duplicate source; no new module until needed |

The live checks above are discovery evidence, not a quality certification. The
rotating hosts, extra series, advertisements, and different image CDNs mean a
shared parser can be a starting template, but each module still needs its own
title ownership checks, chapter ordering tests, image-host allow-list, and
device validation.

### Linked title names that are not currently separate hubs

The related-sites directory also names Oshi no Ko, JoJo's Bizarre Adventure,
The Promised Neverland, Tokyo Revengers, My Hero Academia, Kaguya-sama: Love
is War, Demon Slayer, Naruto, Boruto, Bleach, Dr. Stone, Dragon Ball Super,
and Mob Psycho 100. The checked links for these currently redirect to the
general [MangaBolt](https://mangabolt.com/) catalogue rather than remaining
separate title hubs, so they are not new individual-site module candidates.
`readbleachmanga.com` returned an origin `522`, and `readvinlandsaga.com` did
not return a current usable response. `readchainsaw-man-manga.com` returned
only a small `Loading...` shell, while the current usable Chainsaw Man hub is
`readchainsawman.com`.

### Future queue from this inventory

No code or `index.json` entry was created. The ordered future queue is #26
Attack on Titan, followed by #27 Ichi the Witch, #28 Sakamoto Days, #29 Blue
Lock, #30 One Punch Man, #31 Kingdom, #32 Hunter x Hunter, #33 Jujutsu
Kaisen, #34 Fairy Tail/Eden's Zero/Dead Rock, #35 Seven Deadly Sins, #36
Tokyo Ghoul, #37 Chainsaw Man, and #38 Berserk. Each remains `QUEUED / SAFETY
+ TECHNICAL REVIEW`, not `SAFE`, `PUBLISHED`, or `ACTIVE`, until its visible
content, reader behavior, and device behavior pass the existing gate.
Kagurabachi, Solo Leveling, One Piece, and Black Clover are recorded as
alternate hosts for modules already present in the repository and are not
duplicate queue entries.

## KingOfShojo safety check

Checked the [KingOfShojo homepage](https://kingofshojo.com/) and its current
[manga listing](https://kingofshojo.com/manga/?order=update&page=1) on
2026-09-01. The homepage displays an 18/mature-content warning and adult
category labels. The listing includes multiple entries tagged `Adult`,
`Mature`, and `Smut`, among other adult-oriented labels. The source fails the
content-suitability gate; no module or active index entry was created.

## MangaBuddy / Comizy module (historical release; removed from catalogue)

**Module:** `mangabuddy`
**Version:** `1.0.1`
**Track:** beta
**Type:** `pageImages`
**Source:** `https://mangabuddy.com/` (currently redirects to `https://comizy.io/`)
**Catalogue status:** Removed from `index.json` on 2026-09-01 at the owner's request because the source was too adult/suggestive for the app. The source files and historical tests remain in the repository so the removal is recoverable.

The module uses ordinary public `fetchv2` requests against Comizy's observed
search API, server-rendered discovery/title pages, and declared `cmzcdn.org`
reader images. It does not bypass challenges, authentication, tokens, or rate
limits. It filters source-marked adult titles, coalesces concurrent title-page
loads, caches successful HTML briefly, preserves chapter order, removes
omnibus rows when individual chapters exist, and rejects malformed or
off-host data.

### Evidence

- **UNIT PASS:** three MangaBuddy tests cover normal handlers, pagination,
  filters, retries, shared-load caching, malformed/challenge data, adult
  access, title ownership, and image-host validation.
- **FIXTURE PASS:** the app-shaped fixture tester passed MangaBuddy 1/1 and
  exercised search, discovery, details, chapters, and reader images.
- **LIVE PASS:** five titles passed: Chainsaw Man (379 chapters), One Piece
  (1,299), Naruto (748), Jujutsu Kaisen (477), and Solo Leveling (265).
  Fifteen sampled chapter readers returned ordered image lists and all sampled
  first-image requests returned HTTP 200.
- **CONTRACT PASS:** the full repository suite passed 38/38 tests, 28 source
  policies/manifests, and exact SHA-256 verification.
- **DEVICE PASS:** pending installation and verification in the Synthetiq
  Books iOS/iPad runtime.

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

## AllManga audit and Asura Scans queue advance

AllManga's JavaScript catalogue rendered normally in a browser session. Its
public API supplied search, discovery, details, and chapter metadata. Opening a
chapter redirected to the source-owned `mkissa.to` reader, where ordinary HTTPS
returned an HTTP 403 Cloudflare challenge. No login, cookie extraction, or
challenge bypass was attempted, so AllManga remains deferred rather than being
released with a broken reader.

Asura Scans is now the current published candidate. Its module uses the source's public
catalogue/search APIs, selected-series chapter manifest, chapter API, and
declared CDN page images. It rejects challenge responses, mismatched series,
locked chapters, malformed page manifests, and off-host media. The beta
manifest is marked `suggestive`, so device testing should confirm that the
app's content controls handle that rating as intended.

### Asura Scans evidence

- `FIXTURE_PASS`: deterministic tests cover search pagination, discovery,
  details, series-scoped chapter parsing, premium filtering, decimal ordering,
  restored CDN paths, locked-reader failure, challenge rejection, and host
  ownership guards.
- `LIVE_NODE_PASS`: six representative titles, five evenly spaced public
  chapters per title, every returned page URL, and first/middle/last image
  delivery passed 79/79 checks (100%).
- `PUBLIC_BETA`: released to `origin/main` in commit `ab56e9f` after the full
  repository validation passed.
- `IOS_RUNTIME_PASS` and `DEVICE_PASS`: not claimed; installation and the real
  Books/WebKit bridge still require the owner's iPad test.

## MangaXo implementation record (removed)

Source: [MangaXo](https://mangaxo.com/)

This module was removed from the active catalogue at the owner's request after
content review. It is not an available source for users; the following is
retained only to explain the historical implementation and removal decision.

The source exposes ordinary public HTML/AJAX flows for discovery, title
details, chapter lists, and ordered reader image manifests. The module keeps
all requests on the declared source or image hosts, preserves decimal chapter
numbers, deduplicates title-scoped results, and rejects malformed, empty,
off-host, or mismatched reader responses. It uses no credentials, cookies,
CAPTCHA handling, or challenge bypass.

### MangaXo evidence

- `FIXTURE_PASS`: deterministic tests cover discovery/search pagination,
  title ownership, English chapter parsing, decimal ordering, chapter/image
  manifest validation, empty-reader failure, and image-host restrictions.
- `LIVE_NODE_PASS`: six representative titles, five evenly spaced chapters per
  title, every returned page URL, and first/middle/last image delivery passed
  80/80 checks (100%).
- `IOS_RUNTIME_PASS` and `DEVICE_PASS`: not claimed; the owner's app/device
  installation remains the final acceptance step.
- The beta manifest is marked `suggestive`; the app's content controls should
  be checked before wider rollout.
- `PUBLICATION`: pushed to `synthetiq-manga-sources` `main` at commit
  `025104a`, then removed from the active catalogue at the owner's request.
