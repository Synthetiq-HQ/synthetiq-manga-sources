/**
 * Generic metadata-only content safety filter.
 */

function normalizeCategory(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

export function isContentAllowed(item, blockedCategories = []) {
  if (!item || typeof item !== "object") return false;

  const categories = Array.isArray(item.categories)
    ? item.categories
    : [];

  const blocked = new Set(
    blockedCategories
      .map(normalizeCategory)
      .filter(Boolean)
  );

  return !categories.some((category) =>
    blocked.has(normalizeCategory(category))
  );
}

export function filterAllowedItems(items, blockedCategories = []) {
  if (!Array.isArray(items)) return [];

  return items.filter((item) =>
    isContentAllowed(item, blockedCategories)
  );
}
