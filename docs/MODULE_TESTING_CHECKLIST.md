# Module Testing Checklist

This repository distinguishes deterministic parser evidence from live-source and
physical-device evidence. A passing fixture test, an HTTP 200, or a successful
installation alone does not prove that a module is ready for users.

## Required Before Publishing A Module Update

1. **Package and manifest**
   - Run `node --check modules/<slug>/index.js`.
   - Run `npm run finalize` only after the source change is final.
   - Run `node scripts/validate.mjs` and `node scripts/verify-repository.mjs`.
   - Confirm index version, manifest version, entry hash and manifest hash match.

2. **Deterministic contract tests**
   - Add fixtures for search, details, chapters and terminal content.
   - Include malformed responses, empty lists, duplicate identifiers and expected
     pagination boundaries.
   - For any multi-series HTML source, add unrelated lookalike title/chapter
     links outside the selected title’s section. The parser must return only
     entries owned by the selected source identity.
   - Register the module in `tests/source-test-policy.json`. New entries fail the
     contract audit until they have a declared chapter-ownership scope.
   - Run `npm run test:contracts` and the focused module test.

3. **Live evidence, deliberately limited**
   - Use `node scripts/module-tester.mjs <slug> --query <known-title> --expect-title <expected-title> --limit 3 --pages 2 --report`.
     `--expect-title` is required for a release check: a non-empty result is not
     sufficient when a site can return fuzzy or unrelated search matches.
   - Test a short title, a long-running title and a title with decimal/versioned
     chapters where that source has them.
   - Verify selected title, chapter count/identity, first and last terminal
     content, and direct page/text delivery. Do not download bulk media.
   - Record a source as `BLOCKED` or `PARTIAL` when a host rate-limits, presents
     a challenge, or the Node bridge cannot reproduce the app runtime.

4. **App/runtime evidence**
   - Install/update the source through the app’s real queue.
   - Verify search, details, chapters, terminal content and update/rollback on a
     simulator or physical device as applicable.
   - Test source activation/restoration separately from parser correctness.

## Evidence Labels

- `FIXTURE PASS`: deterministic parser behavior only.
- `LIVE PASS`: live request and sampled terminal content succeeded at that time.
- `RUNTIME PASS`: the app runtime completed the same flow.
- `DEVICE PASS`: a physical device completed the flow.
- `PARTIAL` / `BLOCKED`: preserve the specific failure; never rewrite it as ready.

## Why The Ownership Gate Exists

Some sites render related titles, recommendations or alternate editions beside a
chapter list. A document-wide “chapter-looking link” regex can therefore return
valid URLs for the wrong title, causing sudden chapter-number jumps. Multi-series
DOM parsers must bind output to the selected series URL or stable source ID.
