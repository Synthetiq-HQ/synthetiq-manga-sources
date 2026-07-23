"use strict";

/**
 * Legacy stub retired in favor of `weebcentral-v2` (folder: modules/weebcentral).
 * Kept only so old installs fail with a clear message instead of empty lists.
 */
(() => {
  const MESSAGE =
    "This source is retired. Uninstall it and install “WeebCentral” (weebcentral-v2) instead.";

  async function searchResults() {
    throw new Error(MESSAGE);
  }
  async function extractTags() {
    return [];
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

  const handlers = {
    searchResults,
    extractTags,
    extractDetails,
    extractChapters,
    extractImages,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
