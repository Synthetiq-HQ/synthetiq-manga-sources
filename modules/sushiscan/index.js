"use strict";

import {
  filterAllowedItems,
} from "../../lib/content-safety/index.js";

const BLOCKED_CATEGORIES = [
  "blocked-category",
  "restricted-category",
];

function filterResults(results) {
  return filterAllowedItems(results, BLOCKED_CATEGORIES);
}

globalThis.SynthetiqModule = {
  searchResults(results) {
    return filterResults(results);
  },

  discoveryHome(results) {
    return filterResults(results);
  },

  discoveryFeed(results) {
    return filterResults(results);
  },
};
