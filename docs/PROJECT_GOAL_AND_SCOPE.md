# Project Goal and Scope

_Last updated: 2026-09-01_  
_Status: MangaBuddy retired; Batcave and AllManga deferred, Asura Scans beta published for device testing_
_Implementation confidence: 92%_

## 1. Current Goal Summary

Validate the published Asura Scans beta on device and confirm its `suggestive` content rating is handled correctly after Batcave and AllManga were deferred for blocked reader access.

## 2. Primary Users

- Synthetiq Books readers using the iOS/iPad app.

## 3. Problem Being Solved

- The previous MangaBuddy/Comizy source was too adult/suggestive for the app and has been removed from the active catalogue.
- QToon and Specter Scans were evaluated and skipped because their live catalogues expose adult-marked content without a reliable safe exclusion path.
- Batcave was rechecked through ordinary HTTP and the available browser sessions; it returned a Cloudflare challenge and members-only sign-in, so it is deferred without a bypass.
- AllManga's catalogue, details, and chapter metadata were reachable, but its reader redirected to `mkissa.to`, which returned a Cloudflare challenge; it is deferred without a bypass.
- Asura Scans is the current candidate and has a local module with deterministic and bounded live evidence; device validation remains outstanding.

## 4. Desired Outcome

- Establish whether Asura Scans is reachable, policy-appropriate, and technically reliable through ordinary public access.
- Keep the source in beta until iOS/device behavior and content controls are confirmed.

## 5. MVP Definition

The smallest useful version is an Asura Scans module only if ordinary access exposes stable search/discovery, title, chapter, and reader data that passes deterministic and bounded live checks.

> The detailed MangaBuddy/Comix material below is retained as historical context; QToon and Specter Scans were skipped for content-policy reasons, Batcave and AllManga were deferred for blocked reader access, and the current queue scope is Asura Scans.

## 6. Confirmed Decisions

- [x] Module-only change
  - A: Do not change the private Books app for this fix.
  - Decision: Keep the work inside the public module repository.
  - Status: Confirmed by the existing module workflow.
- [x] Normal source access
  - A: Use ordinary public HTTPS and the app's normal browser bridge.
  - Decision: Do not call protected APIs directly or bypass challenges, tokens, or rate limits.
  - Status: Confirmed.
- [x] Publish workflow
  - A: Publish the corrected module after validation, then let the owner test it on device.
  - Decision: Release as a beta module with explicit test evidence.
  - Status: Confirmed by the owner's prior publication instruction.

## 7. MVP Features

- [ ] Fast title detail and chapter loading
  - Priority: Must
  - Notes: Use direct public APIs and short response caching; avoid duplicate requests and unnecessary browser work.
- [ ] Complete discovery continuation pages
  - Priority: Must
  - Notes: Do not trim a full source page down to six cards merely to avoid overlap.
- [ ] Regression and live browser evidence
  - Priority: Must
  - Notes: Cover page counts, chapter completion, caching/coalescing, and source-host validation.

## 8. Non-Goals

- [ ] Changes to the private Books app or its WebKit bridge.
- [ ] Direct use of Comix's encrypted/protected API from the module.
- [ ] CAPTCHA, Cloudflare, token, cookie, proxy, or rate-limit bypasses.
- [ ] Bulk downloading or content mirroring.

## 9. Deferred / Out of Scope

- [ ] Stable-track promotion
  - Reason: Requires broader multi-title/device acceptance testing.
  - Revisit: Later
- [ ] A statistical 20/30-title random-chapter certification run
  - Reason: This fix first needs to meet the immediate loading and pagination quality issue.
  - Revisit: Later

## 10. Open Questions

- [ ] Whether Asura Scans' public API and CDN paths remain stable, and whether its `suggestive` rating is acceptable for the app's content controls.
  - Why it matters: A changing API/CDN or unsuitable content rating would make the release unreliable or inappropriate.
  - Blocking: Device/content-policy review

## 11. Assumptions

- [ ] The source's public title page remains the supported browser path for chapter discovery.
  - Risk if wrong: A source-side frontend change could require a new parser.
  - Validation plan: Re-run ordinary live browser checks before each publication.

## 12. Technical Decisions

| Area | Decision | Status | Notes |
|---|---|---|---|
| Platform | Synthetiq Books module contract | Confirmed | No private app edits. |
| Storage | Bounded in-memory cache | Confirmed | Short TTL; coalesce duplicate in-flight loads. |
| Authentication | None | Confirmed | Use the source's public browser session. |
| APIs/Integrations | `fetchv2` for Asura's public APIs, series pages, and CDN resources | Confirmed | No direct protected API/decryption or browser challenge bypass. |
| Caching/Refresh | Five-minute title cache with bounded size | Confirmed | Avoid repeated detail/chapter work during navigation. |
| Deployment | Public `synthetiq-manga-sources` repository | Confirmed | Asura beta published at `ab56e9f`; device testing remains. |
| Testing | Fixtures, repository checks, and bounded live browser checks | Confirmed | Device pass remains separate. |
| Security/Privacy | Ordinary public requests only | Confirmed | No bypass or hidden credentials. |

## 13. Core User Workflow

1. Refresh the public module repository in Books.
2. Open Asura Scans and browse or search for a title.
3. Open a title and receive its description and public chapters.
4. Open a public chapter and receive ordered CDN page images.

## 14. Acceptance Criteria

- [ ] Discovery and search return the complete source page without artificial trimming.
- [ ] Chapter extraction preserves series ownership, numeric order, and public-access status.
- [ ] Reader extraction returns every declared page in order and rejects malformed/off-host media.
- [ ] Repository tests, source policy, manifest hashes, and repository verification pass.
- [ ] The release is pushed to the public repository and its immutable and live `main` index/manifest/code/icon hashes match.
- [ ] Device testing is reported separately from Windows/browser evidence.

## 15. Risks and Tradeoffs

| Risk | Impact | Decision | Mitigation |
|---|---|---|---|
| AllManga reader is protected behind a source-side challenge | Medium | Defer the source | Keep AllManga out of the active catalogue until a supported public reader path exists. |
| Asura API or CDN paths change | Medium | Keep endpoint and host guards strict | Fail clearly instead of returning partial or off-host chapters. |
| Source content rating is `suggestive` | Medium | Release as beta only | Confirm the app's content controls on device before wider rollout. |

## 16. Scope Change Log

| Date | Requested Change | Classification | Decision | Notes |
|---|---|---|---|---|
| 2026-09-01 | Make Comix chapter loading faster and fix the short homepage continuation | In scope | Implement now | User reported the current release still fails the quality bar. |
| 2026-09-01 | Move Batcave to queue priority #1 | In scope | Audit now | Recheck ordinary access first; do not bypass a 403/challenge. |
| 2026-09-01 | Batcave ordinary-access recheck returned a Cloudflare challenge | Blocked | No module started | HTTPS, `www`, and HTTP all returned 403; wait for a supported public path or defer. |
| 2026-09-01 | Defer Batcave after ordinary and browser access remained blocked | Useful but deferred | Continue with AllManga | No credentials or cookies were entered or extracted. |
| 2026-09-01 | AllManga reader redirected to a Cloudflare-protected `mkissa.to` page | Blocked | Defer AllManga and advance to Asura Scans | Catalogue and metadata worked; no bypass or cookie extraction attempted. |
| 2026-09-01 | Advance queue to Asura Scans | In scope | Validate and publish beta candidate | Existing isolated draft passed its bounded live proof; device/content review remains. |

## 17. Implementation Readiness Checklist

- [x] Goal is clear.
- [x] Primary users are clear.
- [x] MVP features are listed.
- [x] Non-goals are listed.
- [x] Core user workflow is described.
- [x] Integrations/APIs are listed.
- [x] Platform/deployment target is known.
- [x] Constraints are known.
- [x] Acceptance criteria are defined.
- [x] Major risks/assumptions are documented.
- [x] Existing user workflow confirms the baseline.

## 18. Baseline Confirmation

Status: Confirmed

Confirmed by user on: 2026-09-01, through the ongoing Comix module fix and publish workflow.
