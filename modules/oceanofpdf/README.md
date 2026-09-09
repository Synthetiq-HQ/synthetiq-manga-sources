# OceanofPDF for Books

Beta module, version 1.0.0, prepared for the owner's explicitly requested public
device-testing release. Native device verification remains pending.

## Supported

- Publication mode: PDF and EPUB resources, not image chapters or audio.
- Search and next-page search.
- Recently Added discovery with covers and pagination.
- Book title, author, genres, cover and summary.
- Exact-edition PDF/EPUB resolution from that book's download forms.

No Books app code was changed. The module uses the existing `publication`,
`pagev2` and `fetchv2` contracts. Devices need a Books build supporting these
contracts; the legacy minimumAppVersion field alone is not device certification.

## Request Flow And Safety

The site's homepage is a search landing page. Discovery intentionally uses
`/recently-added/`, rather than attempting to parse books from `/`.

Metadata is read from the normal browser DOM through `pagev2`. Initial browser
verification may delay or block access. No CAPTCHA solver, cookie export or
verification bypass is included. Same-document metadata requests are coalesced
and cached for two minutes, with a bounded 20-entry cache.

Resources are resolved by posting the exact selected book's server and filename
fields to `/Fetching_Resource.php`. That response contains advertising scripts
as well as a signed file URL. The module does not execute those response scripts,
follow advertising links, or fabricate signatures. It reads only literal HTTPS
URLs on observed `fs3.oceanofpdf.com` and `fs4.oceanofpdf.com` file hosts, matching
the requested filename and requiring a non-expired signed URL.

New or unknown file hosts fail closed and need a verified module update. Signed
URLs are generated afresh for each resource request; they are not fixture data.
Failed, wrong-file, expired, redirected or truncated responses are errors, not
empty successful publications. PDF/EPUB resolution is all-or-error for a title.

The module does not establish redistribution rights or App Store approval for
the site's catalogue. Those are separate release decisions. No publication
contents are included in test fixtures.

## Verification

Focused automated fixtures:

```sh
node --test tests/oceanofpdf.test.mjs
```

The test is also included in `npm test`. Fixtures use invented book metadata and
fake signed URLs. They cover identities, pagination, blank searches, unsafe URLs,
form encoding, PDF/EPUB, wrong-file responses, expiry, unknown hosts, redirects,
HTTP/challenge failures, cache behavior and request coalescing.

Optional browser-bridge live probe, from the repository root:

```sh
"$PLAYWRIGHT_CLI" -s=books-ocean open https://oceanofpdf.com/ --headed
RUN_LIVE_TESTS=1 node scripts/live-oceanofpdf-check.mjs
```

Set `PLAYWRIGHT_CLI` to the local Playwright CLI wrapper first. Let normal browser
verification finish. `FETCH_SOURCE_ICON=1` additionally retrieves the observed
official 192px PNG favicon; its PNG signature is checked before saving.

Observed on 2026-09-09:

- Actual module handlers, with Chromium-backed bridges: Recently Added pages
  one/two returned 7/7 items; Pride and Prejudice search pages returned 7/6 items.
- Details returned titles and covers for Pride and Prejudice and Frankenstein.
- PDF link for Pride and Prejudice: HTTP 200 HEAD, 2,315,405 bytes.
- PDF/EPUB links for Frankenstein: HTTP 200 HEAD, 1,689,802 / 976,046 bytes.
- Header requests did not download complete publication contents.
- One earlier resource resolution failed; a repeated probe succeeded. Site
  availability and verification are not guaranteed. This is not a claim that
  every catalogue title works.

Remaining gates: actual iPhone/iPad WKWebView verification, native PDF/EPUB open,
offline downloads and signed-link renewal after expiry. Browser and fixture
results do not substitute for those checks. No device-ready certification yet.
