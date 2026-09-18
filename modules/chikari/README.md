# Chikari for Synthetiq Books

Version 1.0.0, beta, `pageImages`, English. Source: https://chikari.moe/.

This is the Books loose-file contract, not a Player ZIP. The local repository
`index.json` includes the manifest, script and official PNG icon with SHA-256
descriptors. No app rebuild or account is needed. Install through the main Books
catalogue: https://raw.githubusercontent.com/Synthetiq-HQ/synthetiq-manga-sources/main/index.json.

## Features

- Popular and Recently Added discovery sections, each with pagination.
- Title/alias search, cover images, description, authors and genres.
- Complete chapter pagination, ascending order, and decimal chapter numbers.
- Ordered HTTPS image descriptors with the source Referer header for the native
  reader/download manager.
- Comics only: manga, manhwa and manhua. The source's novels are not advertised
  as image chapters. Adult-marked records are excluded, including direct links.
- Only `chikari.moe` and `cdn.chikari.moe` are allowed. No credentials, account
  requests, analytics, challenge bypass, proxies or arbitrary-host fallback.
- HTTP failures, malformed data, empty/incomplete pagination and unexpected
  media hosts fail explicitly rather than reporting a successful empty source.

## Tests (2026-09-18)

Run from the source repository root:

```sh
node --test modules/chikari/test.mjs
node modules/chikari/live-check.mjs
node scripts/validate.mjs
node scripts/verify-repository.mjs
```

Verified:

- 7 deterministic tests passed: encoding/filtering, full chapter pagination,
  decimal numbering, stalled pagination, page order/headers, identity/host
  validation, ownership, HTTP failures, HTML challenges and response limits.
- Live popular page 1 and page 2: 36 results each, different leading identities.
- Live discovery: Popular 36, Recently Added 36.
- Search for Reincarnator: 7 results, including the exact title.
- One live title: 113 chapters returned (not just the site's initial preview).
- First chapter: 50 image descriptors; latest chapter: 20 descriptors.
- First image in each tested chapter: HTTP 200, 592290 and 140552 bytes.
- Repository validator and hash verification passed for 35 modules.

These are fixture and real HTTP checks, not a claim of iPhone/iPad installation,
native playback/read testing, provider permission or App Store approval.
The HTTP probe fetches two images to `/dev/null` and stores no chapter content.

After changing installable files, run `node modules/chikari/finalize.mjs` to
refresh only this module's hashes and catalogue entry. Other modules are left
unchanged. Then rerun validation.

## Remaining acceptance

Install from a test/published catalogue on Books, open Discover, search a title,
open the first and a later chapter, and download one chapter for offline reading.
Verify native rendering for tall WebP pages and that changing profiles does not
carry the selected source into another profile. Public distribution is separate
from technical compatibility; authorization has not been established here.
