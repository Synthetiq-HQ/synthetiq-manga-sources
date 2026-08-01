# DeepSeek Module Workspace

This folder gives an AI coding agent the context needed to create or repair
**Synthetiq Books modules only**. It is intentionally separate from the iOS
app source. Do not edit the Books app from this repository.

## Start Here

1. Read `DEEPSEEK_MODULE_AGENT_PROMPT.md` in this folder.
2. Read the linked authoritative repository documents in this order:
   - `../docs/OPEN_SOURCE_MODULES.md`
   - `../docs/FORMAT.md`
   - `../docs/AUTHORING.md`
   - `../docs/MODULE_TESTING_CHECKLIST.md`
   - `../docs/SECURITY.md`
3. Inspect a suitable existing module before implementation:
   - `../modules/haikyuu/` for a simple fixed-series image module.
   - `../modules/weebcentral/` for a full catalogue image module.
   - `../modules/internet-archive/` for a publication/text-resource module.
   - `../modules/novelfire/` for a text catalogue module.
4. Create or change only repository module assets and their tests/docs.

## Repository Contract

The Synthetiq Books iOS app reads this public loose-file format:

```text
index.json
modules/<slug>/manifest.json
modules/<slug>/index.js
modules/<slug>/icon.png
modules/<slug>/fixtures/*
```

There are no installable module ZIP files in this repository. The app obtains
the raw `index.json`, then downloads the listed manifest, entry script and
icon. All declared SHA-256 values must match after every release change.

## Commands

Run commands from the repository root, not from this folder:

```bash
cd "/Users/khubaibshakh/Documents/Synthetiq Manga/Synthetiq Manga Sources"

# Fast parser iteration before hashes are final.
node --check modules/<slug>/index.js
node scripts/validate.mjs --skip-hashes

# Complete deterministic and repository validation.
npm test

# Regenerate entry/icon/manifest hashes only after code and icon are final.
npm run finalize
npm test

# Focused app-shaped test and report.
node scripts/module-tester.mjs <slug> --fixtures --report
node scripts/module-tester.mjs <slug> --query "Known Title" \
  --expect-title "Expected Title" --limit 3 --pages 2 --report
```

Live tests are evidence, not a promise that the source is ready. Report
fixture, live, runtime and device evidence separately. A rate limit, challenge,
or upstream failure must be recorded as `PARTIAL` or `BLOCKED`, never as a pass.

## Scope Guard

- Do not modify `/Users/khubaibshakh/Documents/Synthetiq Manga/Synthetiq Manga App`.
- Do not add native Swift, Android, server, bypass, proxy, login, payment,
  CAPTCHA/Cloudflare bypass, credentials, API keys, cookies, or secrets.
- Do not bulk-download books, manga, chapters, or images.
- Use only HTTPS hosts that are genuinely needed and declare them in
  `allowedHosts`.
- Never weaken the existing tests, host checks, integrity hashes or
  chapter-ownership rules to make a module appear to pass.
