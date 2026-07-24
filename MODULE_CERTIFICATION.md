# Module Certification

`module-tester.mjs` is a bounded Node probe. It now treats discovery and the
requested search as separate required contracts, checks stable pagination,
verifies filter semantics against title details, opens the first and last
chapter, and samples the first, middle, and final image from each chapter.

The release gate is `source-certifier.mjs`. It combines fixtures, live Node
proofs, and the app's real iOS WebKit runtime. MangaFire cannot be certified by
an HTTP-only Node substitute because its `pagev2` flow requires WKWebView.

```sh
npm run certify:flagships:fixtures
npm run certify:flagships:live
node scripts/source-certifier.mjs --module atsu --mode all
node scripts/source-certifier.mjs --module mangafire-v2 --mode ios
```

The latest JSON evidence is written to
`reports/certification-latest.json`. A skipped Node check that requires iOS does
not count as a pass unless the iOS WebKit test also passes.

## Coverage

- repository fixture and manifest integrity
- discovery sections
- five-page stable Popular pagination
- named-title search
- details and source ownership
- complete chapter parsing
- first and last chapter page resolution
- bounded live image delivery checks
- include/exclude/status niche semantics where supported
- real WKWebView `fetchv2` and `pagev2` execution through the iOS test target

The matrix lives at `certification/flagship-matrix.json`. Add a source and
representative titles there before calling it flagship-ready.

## AI Agent MCP

The repository includes a local, command-allowlisted MCP server. It does not
accept arbitrary shell commands or paths.

```json
{
  "mcpServers": {
    "synthetiq-manga-certifier": {
      "command": "node",
      "args": [
        "/Volumes/ZX20/Projects/Documents/Synthetiq Manga/Synthetiq Manga Sources/scripts/module-certifier-mcp.mjs"
      ]
    }
  }
}
```

Exposed tools:

- `list_modules`
- `certify_module`
- `certify_flagships`
- `latest_report`

Do not label a source Ready from fixture evidence alone. A protected module
requires the iOS mode, and release evidence requires the full mode.
