# Repository Format

## Layout

```text
index.json
modules/<slug>/manifest.json
modules/<slug>/index.js
modules/<slug>/icon.png
modules/<slug>/fixtures/*
```

The repository is loose-file only. The app resolves every asset path relative
to `index.json`; ZIP files are not part of this format.

## Index

`index.json` uses `schemaVersion: 1`. Every module entry contains its stable
identity, version, language, content type, rating, release state, and two asset
descriptors:

- `manifest.path` and `manifest.sha256`
- `icon.path` and `icon.sha256`

An index entry must match the corresponding manifest for `id`, `familyID`,
`name`, `version`, `language`, `contentType`, `contentRating`, `releaseTrack`,
`status`, and icon descriptor.

## Manifest

Manifests use `contractVersion: 1`. Required fields are the module identity,
semantic version, minimum app version, content classification, capabilities,
HTTPS base and universal URLs, entry/icon descriptors, host allowlist, runtime
limits, and attribution.

Content types are:

- `pageImages`: search, details, chapters, and images are required.
- `text`: search, details, chapters, and text are required.
- `publication`: search, details, and resources are required. A publication may
  also expose text sections.

The app ignores unadvertised optional handlers. A module that calls `pagev2`
must declare the `interactivePage` capability.

## JavaScript Handlers

Handlers are exported on `globalThis.SynthetiqModule` and on `globalThis`.

```js
searchResults(query, page = 1)
extractDetails(id)
extractChapters(id)
extractImages(chapterId)
extractText(sectionId)
extractResources(itemId)
discoveryHome()
discoveryFeed(feedId, page = 1)
```

`searchResults` returns either an array or `{ items, hasMore }`. Each item must
contain `id` or `href` or `url`, plus `title`. Details must contain `title` and
an identifier. Chapters must contain an identifier; `number`, `releaseDate`,
and `language` are optional. Images are HTTPS strings or objects with an HTTPS
`url` and optional request `headers`.

Publication resources are objects with `format: "epub" | "pdf"`, an HTTPS
`url`, and optional `fileName`, `size`, and `headers`. Text is a string or an
object containing `content`, `text`, or `html`.

Discovery home uses this shape:

```json
{
  "sections": [
    { "id": "popular", "title": "Popular", "items": [] }
  ]
}
```

## Runtime Bridges

Direct requests use the positional bridge exposed by the app runtime:

```js
fetchv2(url, headers, method, body, options)
```

`options` may contain `followRedirects`, `maxBytesHint`, and `responseClass`.
The native bridge converts these arguments into its `ModuleHTTPRequest` value;
modules do not pass that Swift value as a JavaScript object.

The response exposes `status`, `ok`, `headers`, `finalUrl`, `body`,
`bodyDropped`, `bodyBytes`, `contentType`, `error`, `text()`, and `json()`.

Interactive requests use:

```js
pagev2({
  url,
  headers,
  timeoutMilliseconds,
  settleMilliseconds,
  includeHTML,
  captureResponseBodies,
  maxEntries,
  maxResponseCharacters,
  actionScript,
  returnScript,
  waitForSelector,
  waitForURLIncludes,
  waitForRequestURLIncludes,
  waitForResponseURLIncludes,
  waitForResponseBodyIncludes
})
```

`returnScript` is evaluated synchronously after navigation and settling. The
result is available as `snapshot.evaluatedData`.

## Hashes

The manifest hashes its entry script and icon. The index hashes the finalized
manifest and the same icon. Fixtures and docs are repository test evidence, not
installable assets, so they are not included in manifest descriptors.
