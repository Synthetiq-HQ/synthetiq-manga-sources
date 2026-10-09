[README.md](https://github.com/user-attachments/files/33213110/README.md)[Uploading RE# Metadata content safety filter

This utility is intentionally source-agnostic.

## Contract

A source adapter provides the category labels that its own metadata model
uses for categories that must not be exposed by the application.

The filter:

1. reads metadata only;
2. normalizes category labels;
3. rejects an item when any category matches a blocked category;
4. returns only allowed items;
5. must execute before details, chapter, and image extraction.

It does not fetch publication content, bypass challenges, bypass access controls,
or inspect chapter/image payloads.

## Example

```js
const allowed = filterAllowedItems(results, blockedCategories);
```

Do not put credentials, cookies, private metadata, or publication content in
fixtures or tests.
ADME.md…]()
