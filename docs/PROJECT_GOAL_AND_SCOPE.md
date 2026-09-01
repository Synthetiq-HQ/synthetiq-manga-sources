# Project Goal and Scope

_Last updated: 2026-09-01_  
_Status: MangaBuddy 1.0.1 beta published; device testing pending_
_Implementation confidence: 92%_

## 1. Current Goal Summary

Release the MangaBuddy/Comizy module with reliable search, discovery, title details, ordered chapters, and reader images in Synthetiq Books.

## 2. Primary Users

- Synthetiq Books readers using the iOS/iPad app.

## 3. Problem Being Solved

- The next queue source needs a reliable module before wider user testing.
- The source redirects MangaBuddy to Comizy, so the module must follow the current public endpoint while keeping the queue identity.

## 4. Desired Outcome

- Return complete, ordered, source-owned content with bounded retries, short-lived caching, and clear failures for unsafe or malformed responses.
- Keep the public release beta until device testing and broader quality sampling are complete.

## 5. MVP Definition

The smallest useful version is a MangaBuddy/Comizy page-image module that passes deterministic tests, repository validation, and a bounded live quality proof before publication.

> The detailed Comix-specific material below is retained as historical context; the current release scope is MangaBuddy/Comizy.

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
  - Notes: Remove fixed waits, avoid duplicate concurrent requests, and use the smallest reliable browser interaction.
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

- [ ] Whether the remaining cold-start time is caused by the app's pagev2/WebKit startup cost or Comix client hydration.
  - Why it matters: The module can remove its own overhead, but only the installed app can prove bridge/device latency.
  - Blocking: No

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
| APIs/Integrations | `fetchv2` for public HTML; `pagev2` for browser-owned UI | Confirmed | No direct protected API/decryption. |
| Caching/Refresh | Five-minute title cache with bounded size | Confirmed | Avoid repeated detail/chapter work during navigation. |
| Deployment | Public `synthetiq-manga-sources` repository | Confirmed | Release beta after tests and hash verification. |
| Testing | Fixtures, repository checks, and bounded live browser checks | Confirmed | Device pass remains separate. |
| Security/Privacy | Ordinary public requests only | Confirmed | No bypass or hidden credentials. |

## 13. Core User Workflow

1. Refresh the public module repository in Books.
2. Open Comix and browse or search for a title.
3. Open a title and receive its description and chapters without avoidable module delay.
4. Continue the homepage feed and receive a full useful next page.
5. Read a chapter through the source-owned reader page.

## 14. Acceptance Criteria

- [ ] The popular continuation does not return an artificially trimmed six-card page when the source supplies a full page.
- [ ] Chapter extraction has no unnecessary fixed per-page delay and safely completes the observed title pagination.
- [ ] Repeated title detail/chapter requests within the cache window do not repeat the expensive browser work.
- [ ] Repository tests, source policy, manifest hashes, and repository verification pass.
- [ ] The release is pushed to the public repository and its immutable and live `main` index/manifest/code/icon hashes match.
- [ ] Device testing is reported separately from Windows/browser evidence.

## 15. Risks and Tradeoffs

| Risk | Impact | Decision | Mitigation |
|---|---|---|---|
| Comix client hydration or WebKit startup remains slow | Medium | Optimize module-side work first | Measure source HTML, browser action, and device separately. |
| Source pagination markup changes | Medium | Keep browser-owned parsing | Fail clearly instead of returning partial chapters. |
| Home feed and browse ordering differ | Low | Use a full continuation page | Prefer useful page size over a six-card trimmed page; monitor duplicates. |

## 16. Scope Change Log

| Date | Requested Change | Classification | Decision | Notes |
|---|---|---|---|---|
| 2026-09-01 | Make Comix chapter loading faster and fix the short homepage continuation | In scope | Implement now | User reported the current release still fails the quality bar. |

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
