# Module Authoring

## Workflow

1. Classify the source as direct HTTP, interactive/protected, or unsupported.
2. Define a stable module/family identity and legacy IDs before coding.
3. Add only the network hosts required by observed requests and redirects.
4. Implement exact app return shapes and fail on challenge/error pages.
5. Store sanitized deterministic fixtures, never live user data or secrets.
6. Test search, details, the complete chapter path, and terminal content.
7. Bump the semantic version for behavior or parser changes.
8. Run `node scripts/finalize-hashes.mjs` only after entry scripts and icons are final.
9. Run `node scripts/validate.mjs` and do bounded live smoke probes.

During parser iteration, `node scripts/validate.mjs --skip-hashes` runs fixture
tests before final hash generation.

## Fixture Rules

- Fixtures are UTF-8 and deterministic.
- Use invented titles and text instead of copying complete third-party works.
- Preserve the structural fields needed to exercise parsing and pagination.
- Include malformed, excluded, duplicate, or private entries when a safety
  decision depends on filtering them.
- Expected outputs are checked with exact deep equality.

## Source Notes

### WeebCentral

Use `fetchv2` for `/search/data`, series pages, `/full-chapter-list`, and the
chapter `/images` endpoint. The chapter endpoint is intentionally unpaginated;
return every parsed chapter and never apply a UI-sized limit in the module.
Search requests set `adult=False`.

### MangaFire

Use `pagev2` for the current `/api/...` flows so browser cookies and challenges
remain in the app-owned WebKit boundary. Chapter extraction follows every API
page and fails instead of returning a partial list. If a page response contains
a positive scramble offset, preserve `#scrambled_<offset>` on the image URL.

### Internet Archive

Use only official `advancedsearch.php`, `/metadata/{identifier}`,
`/download/{identifier}/{file}`, and `/services/img/{identifier}` endpoints.
Search results and item operations must pass the same recognized-open-license
gate. EPUB/PDF resources and text derivatives must be public and non-private.

## Release Check

The deterministic suite is necessary but not sufficient for a stable release.
Also verify a normal query, details, a short and long chapter list, at least two
chapter reads, redirects to every observed image/download host, and recovery
from a challenge, 403, 429, empty body, and oversized response.
