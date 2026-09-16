# Audio Download Issue Log

This log records download behavior that may belong to the Books app rather
than an individual source module.

## 2026-09-16 — progress display can stall near 67%

- **Affected sources:** Golden Audiobooks and Hot Audiobooks.
- **Observed behavior:** The download continues or completes, but the visible
  percentage can remain at approximately 67% until the user pauses/cancels,
  navigates to another app page, or returns to the download view.
- **Module/source checks:** Direct public MP3 URLs returned valid audio
  responses. Byte-range requests returned `206` with correct
  `Content-Range` values, and sampled downloads completed without a missing
  final byte range.
- **Assessment:** Not reproduced as a source URL, track-list, or module
  extraction failure. Current status is **OPEN — app-side downloader/progress
  investigation**.
- **Next diagnostics:** Log the expected byte count, received byte count,
  response status (`200` versus `206`), `Content-Length`, `Content-Range`,
  resume offset, progress callback updates, and the finalization callback.
