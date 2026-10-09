import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAllowedItems,
  isContentAllowed,
} from "./index.js";

const blocked = ["blocked-category", "restricted-category"];

test("allows an item with no blocked category", () => {
  assert.equal(
    isContentAllowed(
      { title: "Normal work", categories: ["Action", "Adventure"] },
      blocked
    ),
    true
  );
});

test("rejects an item with a blocked category", () => {
  assert.equal(
    isContentAllowed(
      { title: "Filtered work", categories: ["Action", "blocked-category"] },
      blocked
    ),
    false
  );
});

test("rejects mixed categories when one category is blocked", () => {
  assert.equal(
    isContentAllowed(
      { title: "Mixed work", categories: ["Action", "restricted-category"] },
      blocked
    ),
    false
  );
});

test("normalizes category labels", () => {
  assert.equal(
    isContentAllowed(
      { title: "Normalized work", categories: ["  BLOCKED-CATEGORY  "] },
      blocked
    ),
    false
  );
});

test("filters invalid items out instead of exposing them", () => {
  const items = [
    { title: "Allowed", categories: ["Action"] },
    { title: "Blocked", categories: ["blocked-category"] },
    null,
    { title: "No categories", categories: [] },
  ];

  assert.deepEqual(
    filterAllowedItems(items, blocked).map((item) => item.title),
    ["Allowed", "No categories"]
  );
});
