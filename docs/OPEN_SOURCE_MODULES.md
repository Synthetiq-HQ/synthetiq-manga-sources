# Open Source Modules — Publish Your Own Source

Synthetiq Books does **not** scrape the web inside the App Store binary.  
All catalogues live in **public module repositories** (loose files on GitHub).  
Anyone can publish a repository; users paste the `index.json` URL in **Settings → Extension Repositories**.

This document is the human-friendly guide. Technical contracts live in:

| Doc | Purpose |
|-----|---------|
| [FORMAT.md](./FORMAT.md) | `index.json` + `manifest.json` schema |
| [AUTHORING.md](./AUTHORING.md) | Parser workflow, fixtures, release check |
| [SECURITY.md](./SECURITY.md) | Host allowlists, limits, what never to do |

Official community catalogue (example):

```text
https://github.com/Synthetiq-HQ/synthetiq-manga-sources
```

Raw index (what the app fetches):

```text
https://raw.githubusercontent.com/Synthetiq-HQ/synthetiq-manga-sources/main/index.json
```

---

## What a module is

A module is a small package:

```text
modules/<slug>/
  manifest.json   # identity, hosts, limits, icon/script hashes
  index.js        # search / details / chapters / images handlers
  icon.png        # 256×256 PNG shown in Browse
  fixtures/       # deterministic HTML/JSON for tests
```

The app downloads those files, verifies SHA-256, and runs the script inside a **sandboxed WebKit** context with only `fetchv2` / `pagev2` bridges — not arbitrary native access.

---

## Legal & safety (read first)

1. **You are responsible** for the sites your module talks to and for your local laws.  
2. Prefer sources that allow personal/offline reading or that you operate yourself.  
3. Do **not** ship CAPTCHA/CF bypasses, credential stuffing, or paywall circumvention.  
4. Keep `allowedHosts` minimal — only hosts the module actually needs.  
5. Never embed API keys, cookies, or user secrets in the repo.  
6. Adult content must use the correct `contentRating`; the default app catalogue hides adult modules.

---

## Quick start (fork → install)

1. **Fork** `synthetiq-manga-sources` (or create an empty public GitHub repo).  
2. Copy `modules/haikyuu` (simple single-series) or `modules/weebcentral` (catalogue) as a template.  
3. Rename the folder + update `manifest.json` `id` / `familyID` / `name` / `baseURL` / `allowedHosts`.  
4. Implement handlers in `index.js` (see below).  
5. Add fixtures under `fixtures/` and expected outputs.  
6. Run:

```bash
npm test
node scripts/validate.mjs --skip-hashes   # while iterating
node scripts/finalize-hashes.mjs          # when script + icon are final
node scripts/validate.mjs
```

7. Commit + push to `main`.  
8. In the app: **Settings → Extension Repositories →** add  
   `https://raw.githubusercontent.com/<you>/<repo>/main/index.json`  
9. **Browse → Modules → Install**.

---

## Minimum JavaScript API

Export handlers on `globalThis.SynthetiqModule` (and optionally `globalThis`):

```js
// Required for page-image sources
async function searchResults(query, page = 1) { /* { items, hasNextPage } */ }
async function extractDetails(id) { /* manga object */ }
async function extractChapters(id) { /* Chapter[] */ }
async function extractImages(chapterId) { /* image URL strings or { url, headers } */ }

// Optional discovery (Home feed)
async function discoveryHome() { /* feeds */ }
async function discoveryFeed(feedId, page = 1) { /* page */ }
```

### Item shape (search / details)

```js
{
  id: "stable-id-or-url",
  title: "Title",
  href: "https://…",
  url: "https://…",
  image: "https://…/cover.jpg",
  description: "…",
  status: "Ongoing",
  author: "…",
  genres: ["Action"]
}
```

### Chapter shape

```js
{
  id: "https://…/chapter-1",
  title: "Chapter 1",
  number: 1,
  href: "https://…/chapter-1",
  url: "https://…/chapter-1",
  releaseDate: "2024-01-01",
  language: "en"
}
```

### Networking

- Prefer **`fetchv2(url, headers, method, body, options)`** for plain HTTPS JSON/HTML.  
- Use **`pagev2`** only when the site needs a real browser document (cookies, light JS). Declare `interactivePage` capability.  
- Always set a sensible `Referer` when CDNs require it.  
- Fail loudly on challenge pages (`throw new Error("…")`) — do not return empty success.

---

## Single-series “show” modules

If a site only hosts one title (e.g. a dedicated Haikyuu site):

1. `searchResults` can ignore the query and return that one series.  
2. `discoveryHome` should return one “Popular” feed with that series.  
3. Ship a real **cover `icon.png`** (256×256) so Browse doesn’t show a colored box.  
4. Keep chapter URLs stable so library progress survives parser tweaks.

---

## Icons

| Requirement | Value |
|-------------|--------|
| Format | PNG |
| Size | 256×256 recommended |
| Content | Recognizable cover or brand mark — **not** an empty solid color |
| Hash | Must match `manifest.icon.sha256` after `finalize-hashes.mjs` |

After changing `icon.png` or `index.js`, always re-run `finalize-hashes.mjs` and bump `version` (semver).

---

## Publishing your own catalogue

Your `index.json` lists every module entry (path + sha256). Users only need the **raw** HTTPS URL to that file.

Tips:

- Keep the repo public.  
- Use `main` (or a long-lived branch).  
- Prefer GitHub raw or a static host with correct `Content-Type`.  
- Retire broken modules with `"status": "retired"` instead of deleting history abruptly.

---

## Testing checklist before you ask people to install

- [ ] Search returns results (or single series)  
- [ ] Details show title + cover URL  
- [ ] Chapters list is complete (or paginates correctly)  
- [ ] At least two chapters open with ≥1 image each  
- [ ] Offline download of one chapter succeeds in the app  
- [ ] `allowedHosts` covers image CDN redirects  
- [ ] Fixtures + `validate.mjs` pass  
- [ ] Live smoke on a cold network path  

---

## App behavior that authors should know

- **Home “Popular”** uses the **active** installed source (Browse → Sources).  
- **Library / Downloads** open the title’s **own** `sourceID` even if another source is active on Home.  
- Uninstalling a module does **not** delete offline chapter files or library rows.  
- “Update All Sources” refreshes **catalogues**, not installed module files — users still tap **Update** per module when a new version is published.

---

## Contributing to Synthetiq-HQ/synthetiq-manga-sources

1. Open an issue describing the site + why it’s a good fit (stable HTML/API, low CF friction).  
2. PR with module folder + index entry + fixtures.  
3. Maintainers run validate + limited live smoke.  
4. Merged modules appear after users refresh catalogues and install/update.

---

## Roadmap of good module candidates

See [SOURCES_ROADMAP.md](./SOURCES_ROADMAP.md) for sites under evaluation (Flamecomics-class aggregators, Cubari-style JSON, official APIs only, etc.). Preference order:

1. Official/open APIs  
2. Stable public HTML without aggressive bot walls  
3. Interactive WebKit only when unavoidable  
4. Never: login walls, payment walls, or pure CAPTCHA sites
