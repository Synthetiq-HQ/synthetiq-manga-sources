"use strict";

/**
 * Retired - MangaBall now serves an interactive browser verification (Cloudflare)
 * that in-app requests cannot complete.
 * Kept only so old installs fail with a clear message instead of empty lists.
 */
(() => {
  const MESSAGE = "This source is retired. MangaBall requires a browser verification the app cannot complete, so it cannot return results.";

  async function searchResults() {
    throw new Error(MESSAGE);
  }
  async function extractDetails() {
    throw new Error(MESSAGE);
  }
  async function extractChapters() {
    throw new Error(MESSAGE);
  }
  async function extractImages() {
    throw new Error(MESSAGE);
  }
  async function discoveryHome() {
    throw new Error(MESSAGE);
  }
  async function discoveryFeed() {
    throw new Error(MESSAGE);
  }


  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    discoveryHome,
    discoveryFeed,

  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
