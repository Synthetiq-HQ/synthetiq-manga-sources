# Testing Synthetiq Books Sources

This is the canonical testing guide for Synthetiq Books source repositories.
It is written for module authors and coding agents working from a fork of this
repository.

## Evidence Levels

Use the narrowest truthful result:

| Result | Meaning |
| --- | --- |
| `CONTRACT_PASS` | Repository shape, manifests, hashes, and static rules pass. |
| `FIXTURE_PASS` | Deterministic fixtures exercise the declared handlers successfully. |
| `LIVE_NODE_PASS` | The bounded Node probe reached the live source and terminal content. |
| `IOS_RUNTIME_PASS` | The installed module passed through the app's WebKit runtime. |
| `PARTIAL` | Some required stages passed and at least one failed or was unavailable. |
| `FAIL` | A required stage failed. |

A fixture result is not live evidence. A Node result does not prove WebKit,
`pagev2`, installation, downloads, or reader behaviour. Never label a source
ready solely because it returned HTTP 200.

## Requirements

- Node.js 20 or newer
- npm
- A clone or fork containing `index.json`, `modules/`, `scripts/`, and `tests/`
- Xcode only when running the optional iOS WebKit certification stage

```sh
git clone https://github.com/YOUR-ACCOUNT/YOUR-SOURCE-REPOSITORY.git
cd YOUR-SOURCE-REPOSITORY
npm install
```

The current repository has no production npm dependencies. `npm install` is
still safe to run so future test-only dependencies can be pinned normally.

## 1. Deterministic Repository Gate

Run this before every commit:

```sh
npm test
```

It checks fixture behaviour, repository JSON, PNG assets, path safety,
manifest/index agreement, hashes, forbidden ZIP files, and report generation.
It must not contact live source websites.

During parser iteration, validate fixture behaviour before regenerating hashes:

```sh
node scripts/validate.mjs --skip-hashes
```

When JavaScript and icon bytes are final:

```sh
node scripts/finalize-hashes.mjs
npm test
```

Do not mutate files under an existing semantic version. Bump the module version
before finalizing changed bytes.

## 2. Test One Module With Fixtures

Use the module folder slug, not a display name:

```sh
npm run test:module:fixtures -- weebcentral
```

Generate machine-readable and human-readable reports:

```sh
npm run test:module:report:fixtures -- weebcentral
```

Reports are written beneath `reports/`. Generated reports are evidence
artifacts, not source files and should only be committed when a release process
explicitly requires them.

## 3. Bounded Live Probe

Live tests contact the website declared by the module. Run them only when you
are authorised to access that source and understand its terms and request
limits.

```sh
npm run test:module -- weebcentral \
  --query "meaningful title" \
  --limit 3 \
  --pages 3
```

For supported niche filters:

```sh
npm run test:module -- weebcentral \
  --query "a" \
  --include-tags "Comedy,Drama" \
  --exclude-tags "Horror" \
  --status "Ongoing" \
  --pages 5
```

The MangaBuddy/Comizy module also has a bounded five-title quality proof:

```sh
npm run test:mangabuddy:live
```

It checks the newest, middle, and oldest readable chapters for Chainsaw Man,
One Piece, Naruto, Jujutsu Kaisen, and Solo Leveling, while downloading only
one page image from each sampled chapter.

The probe walks discovery or search, details, complete chapters or sections,
and terminal images, text, EPUB, or PDF resources. It validates response shape,
stable identities, pagination, host rules, and sampled terminal delivery.

This remains `LIVE_NODE_PASS`, not `IOS_RUNTIME_PASS`.

## 4. Certification Matrix

The release certifier combines fixtures, live probes, and the app's iOS WebKit
tests:

```sh
npm run certify:flagships:fixtures
npm run certify:flagships:live
npm run certify:flagships:ios
npm run certify:flagships
```

One module can be selected directly:

```sh
node scripts/source-certifier.mjs --module weebcentral-v2 --mode all
```

Modes are `fixtures`, `live`, `ios`, and `all`. Protected modules using
`pagev2` require iOS evidence; an HTTP substitute cannot certify browser-owned
cookies or challenge handling.

The latest report is written to `reports/certification-latest.json`.

## 5. AI Agent MCP

Coding agents that support local MCP servers can use the command-allowlisted
certifier included in this repository:

```json
{
  "mcpServers": {
    "synthetiq-books-source-certifier": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/YOUR-REPOSITORY/scripts/module-certifier-mcp.mjs"
      ]
    }
  }
}
```

Available tools:

- `list_modules`
- `certify_module`
- `certify_flagships`
- `latest_report`

The server accepts only known modules, modes, and commands. It does not expose
arbitrary shell execution or arbitrary filesystem paths.

## Required Handoff Report

Every module handoff must state:

1. Module ID, family ID, and semantic version.
2. Files changed.
3. Exact commands run.
4. Each evidence level actually achieved.
5. Search, discovery, details, chapter/section, and terminal-content results.
6. Known failures, blocked stages, and external source limitations.
7. Whether hashes were finalized.
8. Whether the module was installed and tested in the iOS WebKit runtime.

If live or iOS testing was unavailable, say so explicitly. Do not replace
missing evidence with a claim that the module is ready.

## Failure Interpretation

| Failure | Required response |
| --- | --- |
| Manifest or hash mismatch | Fix repository metadata and rerun `npm test`. |
| Empty search or discovery | Inspect the real response body and parser; HTTP 200 is insufficient. |
| Partial chapter list | Follow source pagination and preserve every stable section identity. |
| HTML returned as an image/resource | Reject the response and report the challenge or parser failure. |
| 403, 429, challenge, or login page | Fail honestly; do not add bypasses or stolen cookies. |
| Node passes but iOS fails | Treat iOS as authoritative for WebKit bridge behaviour. |
| Source no longer exists | Mark the module blocked or retired without deleting user data. |

## Security Rules

- Never commit credentials, account cookies, tokens, private item metadata, or
  complete copyrighted publications as fixtures.
- Use invented or minimal sanitized fixture content.
- Keep `allowedHosts` to observed HTTPS hosts only.
- Do not use `eval`, `new Function`, downloaded scripts, telemetry, filesystem
  access, process execution, CAPTCHA bypasses, or paywall circumvention.
- Test only sources and content you are authorised to access.

See [FORMAT.md](./FORMAT.md), [AUTHORING.md](./AUTHORING.md), and
[SECURITY.md](./SECURITY.md) for the complete repository contract.
