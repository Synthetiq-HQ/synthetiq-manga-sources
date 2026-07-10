# Security Model

## Trust Boundary

Module JavaScript is executable content. The app constrains it with a WebKit
runtime, strict handler allowlist, timeout and response limits, ephemeral
cookies, HTTPS-only networking, public-address DNS checks, and manifest host
allowlists. Modules must not attempt to weaken or bypass those controls.

Repository hashes provide byte-integrity checks after download. This index is
not signed, so hashes do not establish publisher authenticity if the index
itself is replaced. Production distribution should use the app's
`signedRepositoriesOnly` policy and a verified repository signature.

## Network Rules

- HTTPS only; no local, private, link-local, or user-supplied hosts.
- Never set `Host`, `Content-Length`, proxy authorization, or hop-by-hop headers.
- Validate IDs before inserting them into paths or queries.
- Follow redirects only through the app executor so every hop is revalidated.
- Keep allowlists narrow. Wildcards match subdomains, not the base domain.
- Do not embed API keys, account cookies, credentials, analytics, or telemetry.

`fetchv2` is for deterministic direct HTTP. `pagev2` is reserved for sources
that need browser execution or browser-owned session state. MangaFire uses
`pagev2` and returns an error when browser JSON is unavailable; it does not
pretend a challenge page is valid data.

## Content Controls

WeebCentral requests `adult=False`. MangaFire sends the observed excluded-genre
IDs and drops explicitly excluded records. These controls reduce exposure but
do not replace app-level content policy or source review, so both modules are
rated `suggestive`, not `safe`.

The Internet Archive module is deliberately underinclusive. It accepts only
text items with a recognized Creative Commons license URL, CC0/Public Domain
Mark, or an unambiguous public-domain/Creative-Commons rights statement. It
rejects dark, private, restricted, unknown-license, and `all rights reserved`
records. Files are rechecked from official item metadata before any text or
publication URL is returned. Rights eligibility is not a content-safety
classification, so the module is rated `unknown`.

## Parser And Resource Rules

- No `eval`, dynamic code download, script injection, filesystem access, or
  process execution in module code.
- Treat HTML and JSON as untrusted input; never execute strings from responses.
- Deduplicate chapters and preserve source ordering.
- Reject invalid or non-HTTPS image/resource URLs.
- Text extraction is capped at 4 MiB. App response limits remain authoritative.
- MangaFire scramble offsets are preserved as URL markers. The app's native
  image pipeline is responsible for any pixel descrambling required by a future
  response shape.

Report security issues privately to the repository owner. Do not include live
credentials, private item metadata, or copyrighted fixture payloads in a report.
