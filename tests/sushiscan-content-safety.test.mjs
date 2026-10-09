import assert from "node:assert/strict";
import test from "node:test";

import {
  filterAllowedItems,
  isContentAllowed,
} from "../lib/content-safety/index.js";

const BLOCKED = [
  "blocked-category",
  "restricted-category",
];

test("un contenu normal est accepté", () => {
  const item = {
    title: "Normal title",
    categories: ["Action", "Adventure"],
  };

  assert.equal(isContentAllowed(item, BLOCKED), true);
});

test("un contenu avec une catégorie bloquée est rejeté", () => {
  const item = {
    title: "Filtered title",
    categories: ["Action", "blocked-category"],
  };

  assert.equal(isContentAllowed(item, BLOCKED), false);
});

test("un contenu mixte est rejeté si une seule catégorie est bloquée", () => {
  const item = {
    title: "Mixed title",
    categories: ["Action", "Adventure", "restricted-category"],
  };

  assert.equal(isContentAllowed(item, BLOCKED), false);
});

test("les catégories sont comparées sans tenir compte de la casse ou des espaces", () => {
  const item = {
    title: "Normalized title",
    categories: ["  BLOCKED-CATEGORY  "],
  };

  assert.equal(isContentAllowed(item, BLOCKED), false);
});

test("les résultats refusés sont supprimés de la liste", () => {
  const items = [
    {
      title: "Allowed",
      categories: ["Action"],
    },
    {
      title: "Blocked",
      categories: ["blocked-category"],
    },
    {
      title: "Mixed",
      categories: ["Fantasy", "restricted-category"],
    },
  ];

  const result = filterAllowedItems(items, BLOCKED);

  assert.deepEqual(
    result.map((item) => item.title),
    ["Allowed"]
  );
});
