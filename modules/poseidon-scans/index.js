"use strict";

/**
 * Retired - Poseidon Scans has shut down; its domains redirect to a Discord
 * community.
 * Kept only so old installs fail with a clear message instead of empty lists.
 */
(() => {
  const MESSAGE = "This source is retired. Poseidon Scans has shut down and its domains redirect to a Discord community.";

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
