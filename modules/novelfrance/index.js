"use strict";

/**
 * Retired - NovelFrance has shut down; its site redirects to its Discord
 * community.
 * Kept only so old installs fail with a clear message instead of empty lists.
 */
(() => {
  const MESSAGE = "This source is retired. NovelFrance has shut down and its site redirects to a Discord community.";

  async function searchResults() {
    throw new Error(MESSAGE);
  }
  async function extractDetails() {
    throw new Error(MESSAGE);
  }
  async function extractChapters() {
    throw new Error(MESSAGE);
  }
  async function extractText() {
    throw new Error(MESSAGE);
  }
  async function discoveryFeed() {
    throw new Error(MESSAGE);
  }
  async function discoveryHome() {
    throw new Error(MESSAGE);
  }


  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractText,
    discoveryFeed,
    discoveryHome,

  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
