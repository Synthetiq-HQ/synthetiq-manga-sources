# Project Goal and Scope

_Last updated: 2026-09-01_  
_Status: MangaBuddy, Comix, and MangaXo removed; Batcave and AllManga deferred; KingOfShojo rejected by the content gate; Asura Scans and Attack on Titan betas are published for testing; Ichi the Witch is next; the remaining title-site candidates stay queued in order_
_Implementation confidence: 92%_

## 1. Current Goal Summary

Validate the published Attack on Titan single-series beta, then work through the newly inventoried title-focused sites one at a time starting with Ichi the Witch. Determine whether their URL families support a reusable module pattern, and apply the content-suitability gate before each implementation after Batcave and AllManga were deferred for blocked reader access.

## 2. Primary Users

- Synthetiq Books readers using the iOS/iPad app.

## 3. Problem Being Solved

- The previous MangaBuddy/Comizy source was too adult/suggestive for the app and has been removed from the active catalogue.
- QToon and Specter Scans were evaluated and skipped because their live catalogues expose adult-marked content without a reliable safe exclusion path.
- Batcave was rechecked through ordinary HTTP and the available browser sessions; it returned a Cloudflare challenge and members-only sign-in, so it is deferred without a bypass.
- AllManga's catalogue, details, and chapter metadata were reachable, but its reader redirected to `mkissa.to`, which returned a Cloudflare challenge; it is deferred without a bypass.
- Asura Scans has been published as a beta with deterministic and bounded live evidence; device validation remains outstanding.
- MangaXo was briefly published as a beta at commit `025104a`, then removed from the active catalogue at the owner's request; its `suggestive` rating is now a content-review lesson for future candidates.
- KingOfShojo's current public homepage and catalogue expose adult/mature content labels and warnings, so it fails the content gate and no module will be created.
- The supplied Attack on Titan URL is a third-party single-series site, not an official Crunchyroll URL; its published beta handles rotating versioned page hosts and two observed reader CDNs.
- The supplied Attack on Titan page has no visible Adult or Smut label, but the series includes violence/horror and the official listing carries nudity, profanity, and violence advisories; the module is therefore marked `suggestive` and remains beta-only pending device content-control testing.
- The title-site inventory found several reachable hubs for Ichi the Witch, Sakamoto Days, Blue Lock, One Punch Man, Kingdom, Hunter x Hunter, Jujutsu Kaisen, Fairy Tail, Seven Deadly Sins, Tokyo Ghoul, Chainsaw Man, and Berserk. Several other named links now redirect to MangaBolt or are unavailable, and duplicate hosts already exist for Kagurabachi, Solo Leveling, One Piece, and Black Clover.

## 4. Desired Outcome

- Confirm that the published Attack on Titan beta is technically reusable, policy-appropriate for beta testing, and reliable through ordinary public access.
- Preserve the title-site inventory and process its 12 non-duplicate candidates in queue order, with Ichi the Witch next; discovery does not create an active module.
- Confirm that the published Asura Scans beta remains reachable, policy-appropriate, and technically reliable in the Books app.
- Keep both title-focused sources in beta until iOS/device behavior and content controls are confirmed.

## 5. MVP Definition

The current candidate is the published Attack on Titan beta. The next candidate is Ichi the Witch only if its ordinary access exposes stable title, chapter, and reader data, its host family can be handled safely, and its content review is acceptable.

> The detailed MangaBuddy/Comix material below is retained as historical context; QToon, Specter Scans, MangaXo, and KingOfShojo were skipped or removed for content-policy reasons, Batcave and AllManga were deferred for blocked reader access, and Asura Scans and Attack on Titan remain published as betas. The current queue scope is Ichi the Witch next, followed by the inventoried title hubs and the pre-add content gate.

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
- [x] Content suitability gate
  - A: Review a candidate source's visible genres, labels, ratings, and sample catalogue before implementing or publishing it.
  - Decision: Do not add adult or sexualized modules. Skip sources without a reliable safe exclusion path; treat `suggestive` or unclassified sources as review-required before publication.
  - Status: Confirmed by the owner's request.

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

- [ ] Whether the published Attack on Titan host family and both observed image CDNs remain stable, whether its beta content classification works in the app, and whether later title-site themes are acceptable for the app's content controls.
  - Why it matters: A changing host/CDN or unsuitable content rating would make the release unreliable or inappropriate.
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
| APIs/Integrations | `fetchv2` for the queued source's public HTML and declared image resources | Confirmed | No direct protected API/decryption or browser challenge bypass. |
| Caching/Refresh | Five-minute title cache with bounded size | Confirmed | Avoid repeated detail/chapter work during navigation. |
| Deployment | Public `synthetiq-manga-sources` repository | Confirmed | Asura beta published at `ab56e9f`; Attack on Titan beta is active in `index.json` at commit `2992536` for owner testing. |
| Testing | Fixtures, repository checks, and bounded live browser checks | Confirmed | Device pass remains separate. |
| Security/Privacy | Ordinary public requests only | Confirmed | No bypass or hidden credentials. |

## 13. Core User Workflow

1. Refresh the public module repository in Books.
2. If the candidate passes review, open Attack on Titan and browse its title/chapter data.
3. Open a title and receive its description and public chapters.
4. Open a public chapter and receive ordered CDN page images.

## 14. Acceptance Criteria

- [x] Discovery and search return the complete source page without artificial trimming.
- [x] Chapter extraction preserves series ownership, numeric order, and public-access status.
- [x] Reader extraction returns every declared page in order and rejects malformed/off-host media.
- [x] Repository tests, source policy, manifest hashes, and repository verification pass.
- [x] The beta release is pushed to the public repository and its immutable and live `main` index/manifest/code/icon hashes match.
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
| 2026-09-01 | Advance queue to MangaXo | In scope | Evaluate candidate | Existing isolated draft passed its bounded live proof; content suitability still required review. |
| 2026-09-01 | Publish MangaXo beta | In scope | Hand off for Books/iPad testing | Public release commit `025104a`; fixture, contract/hash, and bounded live checks passed. |
| 2026-09-01 | Remove MangaXo beta | Reversed / content policy | Remove from active catalogue | Owner requested removal; do not add adult or sexualized modules without a prior suitability gate. |
| 2026-09-01 | Add pre-add content suitability gate | In scope | Apply before every future module | Review genres, labels, ratings, and sample titles before implementation or publication. |
| 2026-09-01 | Safety-check KingOfShojo | Rejected / content policy | Do not implement | Current public pages expose `Adult`, `Mature`, `Smut`, `Ecchi`, `Yaoi`, and `Manhwa Hot` labels plus an 18+/mature-content warning. |
| 2026-09-01 | Queue Attack on Titan single-series source | In scope | Audit URL family and content suitability before implementation | Supplied URL is third-party rather than official Crunchyroll; rotating hosts and external CDN require discovery and bounded testing. |
| 2026-09-01 | Implement and publish Attack on Titan beta | In scope | Release for owner/device testing and advance queue to Ichi the Witch | Public commit `2992536`; fixture, contract/hash, and bounded live checks passed; five spaced chapters and both observed reader CDNs returned valid image deliveries. |
| 2026-09-01 | Inventory title-focused sites linked by the Manga Goat network | In scope | Record reachable, duplicate, redirected, and unavailable sources; keep Attack on Titan first | No module code or active index entry was created; non-duplicate candidates remain safety and technical review items. |
| 2026-09-01 | Queue the 12 non-duplicate title-site candidates | In scope | Process Ichi the Witch through Berserk one at a time after Attack on Titan | Fixed order recorded in `docs/SOURCE_AUDIT_LOG.md`; duplicate, redirected, parked, and unavailable sources remain out of the module queue. |

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
