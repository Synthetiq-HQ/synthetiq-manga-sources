"use strict";

(() => {
  const MODE = "scans";
  const BASE_URL = "https://archive.org";
  const SEARCH_ROWS = 50;
  const MAX_PAGES = 5000;
  const DEFAULT_HEADERS = {
    Accept: "application/json,text/plain;q=0.9,*/*;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const metadataCache = new Map();
  const scanSetCache = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function firstValue(value) {
    if (Array.isArray(value)) return value.length ? value[0] : "";
    return value == null ? "" : value;
  }

  function stringList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    const item = String(value || "").trim();
    return item ? [item] : [];
  }

  function normalizedList(value) {
    return stringList(value).map((item) => item.toLowerCase());
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(
      stringList(value).join("\n\n")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Internet Archive requires the fetchv2 bridge.");
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          { followRedirects: true, maxBytesHint: options.maxBytesHint || null, responseClass: options.responseClass || "json" },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Internet Archive request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) throw new Error(`Internet Archive response was dropped: ${response.dropReason || "size policy"}.`);
      return response;
    }
    throw lastError || new Error("Internet Archive request failed.");
  }

  async function fetchJSON(url, maxBytesHint = 4 * 1024 * 1024) {
    const response = await fetchDirect(url, { maxBytesHint, responseClass: "json" });
    if (typeof response.json === "function") {
      try {
        return await response.json();
      } catch (_) {
        // Fall through to the defensive body parser.
      }
    }
    try {
      return JSON.parse(await responseText(response));
    } catch (_) {
      throw new Error("Internet Archive returned invalid JSON.");
    }
  }

  function flagIsTrue(value) {
    if (value === true || value === 1) return true;
    return ["true", "1", "yes"].includes(String(value || "").toLowerCase());
  }

  function hasRecognizedOpenLicense(metadata) {
    const licenses = normalizedList(metadata && metadata.licenseurl);
    if (licenses.some((license) => (
      /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses\/(?:publicdomain\/?|(?:by|by-sa|by-nd|by-nc|by-nc-sa|by-nc-nd)\/[0-9.]+)|publicdomain\/(?:zero|mark)\/[0-9.]+)\/?$/.test(license)
      || /^https?:\/\/(?:www\.)?gnu\.org\/licenses\//.test(license)
      || /^https?:\/\/(?:www\.)?opensource\.org\/(?:license|licenses)\//.test(license)
      || /^https?:\/\/(?:www\.)?usa\.gov\/government-works\/?$/.test(license)
    ))) return true;
    const rights = String(firstValue(metadata && metadata.rights) || "").trim().toLowerCase();
    if (/all rights reserved|copyrighted|permission required/.test(rights)) return false;
    const copyrightStatus = String(
      firstValue(metadata && (metadata["possible-copyright-status"] || metadata.possibleCopyrightStatus)) || "",
    )
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (copyrightStatus === "not_in_copyright" || copyrightStatus === "public_domain") return true;
    if (!rights) return false;
    return /\bpublic domain\b|creative commons|\bcc0\b|\bcc[- ]by(?:[- ](?:nc|nd|sa))*\b/.test(rights);
  }

  function isOpenRecord(record) {
    const metadata = record && record.metadata ? record.metadata : record;
    if (!metadata || String(metadata.mediatype || "").toLowerCase() !== "texts") return false;
    if (flagIsTrue(record && record.is_dark)) return false;
    if (flagIsTrue(metadata["access-restricted-item"]) || flagIsTrue(metadata.accessRestrictedItem)) return false;
    if (flagIsTrue(metadata.private) || flagIsTrue(metadata.noindex)) return false;
    return hasRecognizedOpenLicense(metadata);
  }

  function normalizeIdentifier(value) {
    const input = String(value || "").trim();
    const URLMatch = input.match(/^https:\/\/(?:www\.)?archive\.org\/(?:details|metadata)\/([^/?#]+)/i)
      || input.match(/^https:\/\/(?:www\.)?archive\.org\/download\/([^/?#]+)/i);
    const identifier = URLMatch ? decodeURIComponent(URLMatch[1]) : input;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(identifier)) throw new Error("Invalid Internet Archive identifier.");
    return identifier;
  }

  function downloadReference(value) {
    const input = String(value || "").trim();
    const match = input.match(/^https:\/\/(?:www\.)?archive\.org\/download\/([^/?#]+)\/(.+)$/i);
    if (!match) return { identifier: normalizeIdentifier(input), fileName: null };
    const rawFileName = match[2].split(/[?#]/, 1)[0];
    const fileName = rawFileName.split("/").map((part) => decodeURIComponent(part)).join("/");
    if (!fileName || fileName.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid Internet Archive file path.");
    return { identifier: normalizeIdentifier(decodeURIComponent(match[1])), fileName };
  }

  function encodedFileName(value) {
    return String(value).split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  function downloadURL(identifier, fileName) {
    return `${BASE_URL}/download/${encodeURIComponent(identifier)}/${encodedFileName(fileName)}`;
  }

  function publicFile(file) {
    return Boolean(file && file.name && !flagIsTrue(file.private)
      && !flagIsTrue(file["access-restricted-item"])
      && !flagIsTrue(file.restricted)
      && !flagIsTrue(file.encrypted));
  }

  function fileFormat(file) {
    return normalizedList(file && file.format);
  }

  function recordFormats(record) {
    return normalizedList(record && record.format);
  }

  function supportsMode(item) {
    const formats = recordFormats(item);
    return formats.includes("single page processed jp2 zip")
      && (formats.includes("page numbers json") || formats.includes("scandata"));
  }

  async function metadataFor(identifier) {
    const id = normalizeIdentifier(identifier);
    if (metadataCache.has(id)) return metadataCache.get(id);
    const record = await fetchJSON(`${BASE_URL}/metadata/${encodeURIComponent(id)}?extended_err=1`, 12 * 1024 * 1024);
    if (!record || record.error || !record.metadata) throw new Error(`Internet Archive metadata is unavailable for ${id}.`);
    if (!isOpenRecord(record)) throw new Error("Internet Archive item is not explicitly open, licensed, and downloadable.");
    if (metadataCache.size >= 12) metadataCache.delete(metadataCache.keys().next().value);
    metadataCache.set(id, record);
    return record;
  }

  function openSearchClause(query) {
    const text = String(query || "").trim().slice(0, 200);
    const open = '(licenseurl:* OR rights:"Public Domain" OR rights:"Creative Commons" OR rights:CC0 OR possible-copyright-status:"NOT_IN_COPYRIGHT" OR possible-copyright-status:"PUBLIC_DOMAIN")';
    const format = '((format:"Page Numbers JSON" AND format:"Single Page Processed JP2 ZIP") OR (format:"Scandata" AND format:"Single Page Processed JP2 ZIP"))';
    if (!text || text.startsWith("__feed:")) return `mediatype:texts AND -access-restricted-item:true AND ${open} AND ${format}`;
    const phrase = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `mediatype:texts AND -access-restricted-item:true AND ${open} AND ${format} AND (title:"${phrase}" OR creator:"${phrase}")`;
  }

  function advancedSearchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const params = [["q", openSearchClause(query)]];
    ["identifier", "title", "description", "creator", "licenseurl", "rights", "possible-copyright-status", "language", "publicdate", "subject", "downloads", "mediatype", "format"].forEach((field) => params.push(["fl[]", field]));
    params.push(["rows", String(SEARCH_ROWS)], ["page", String(currentPage)], ["output", "json"], ["sort[]", query === "__feed:latest" ? "publicdate desc" : "downloads desc"]);
    return `${BASE_URL}/advancedsearch.php?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
  }

  function searchItem(item) {
    if (!item || !isOpenRecord(item) || !supportsMode(item)) return null;
    const identifier = String(item.identifier || "");
    const title = String(firstValue(item.title) || identifier).trim();
    if (!identifier || !title) return null;
    const href = `${BASE_URL}/details/${encodeURIComponent(identifier)}`;
    return { id: identifier, href, url: href, title, image: `${BASE_URL}/services/img/${encodeURIComponent(identifier)}`, description: stripHTML(item.description), author: stringList(item.creator).join(", "), genres: stringList(item.subject).slice(0, 20), status: "Completed" };
  }

  async function searchResults(query, page = 1) {
    const payload = await fetchJSON(advancedSearchURL(query, page));
    const response = payload && payload.response ? payload.response : {};
    const documents = Array.isArray(response.docs) ? response.docs : [];
    const items = documents.map(searchItem).filter(Boolean);
    const start = Number(response.start) || 0;
    const total = Number(response.numFound) || 0;
    return { items, hasMore: start + documents.length < total };
  }

  async function extractDetails(id) {
    const identifier = normalizeIdentifier(id);
    const record = await metadataFor(identifier);
    const metadata = record.metadata;
    return { id: identifier, href: `${BASE_URL}/details/${encodeURIComponent(identifier)}`, url: `${BASE_URL}/details/${encodeURIComponent(identifier)}`, title: String(firstValue(metadata.title) || identifier), description: stripHTML(metadata.description), image: `${BASE_URL}/services/img/${encodeURIComponent(identifier)}`, author: stringList(metadata.creator).join(", "), authors: stringList(metadata.creator), genres: stringList(metadata.subject).slice(0, 50), status: "Completed", licenseURL: String(firstValue(metadata.licenseurl) || "") };
  }

  function sameName(left, right) {
    return String(left || "").toLowerCase() === String(right || "").toLowerCase();
  }

  function findFile(files, name) {
    return files.find((file) => sameName(file && file.name, name)) || null;
  }

  function baseFor(name, suffix) {
    const value = String(name || "");
    return value.toLowerCase().endsWith(suffix.toLowerCase()) ? value.slice(0, -suffix.length) : "";
  }

  function scanSetDescriptors(record) {
    const files = (Array.isArray(record && record.files) ? record.files : []).filter(publicFile);
    const sets = [];
    const usedBases = new Set();
    const zipFor = (base) => findFile(files, `${base}_jp2.zip`);

    for (const file of files) {
      const name = String(file.name || "");
      const base = baseFor(name, "_scandata.xml");
      if (!base || !fileFormat(file).includes("scandata")) continue;
      const zip = zipFor(base);
      if (!zip) continue;
      sets.push({ sourceFile: name, zipFile: String(zip.name), base, sourceKind: "scandata", count: null, archiveFileCount: Number(zip.filecount) || 0 });
      usedBases.add(base.toLowerCase());
    }

    for (const file of files) {
      const name = String(file.name || "");
      const base = baseFor(name, "_page_numbers.json");
      if (!base || usedBases.has(base.toLowerCase()) || !fileFormat(file).includes("page numbers json")) continue;
      const zip = zipFor(base);
      if (!zip) continue;
      sets.push({ sourceFile: name, zipFile: String(zip.name), base, sourceKind: "pageNumbers", count: null, archiveFileCount: Number(zip.filecount) || 0 });
      usedBases.add(base.toLowerCase());
    }

    if (!sets.length) {
      const declared = Number(firstValue(record && record.metadata && record.metadata.imagecount));
      const directJP2 = files.filter((file) => /_jp2\/.*\.jp2$/i.test(String(file && file.name || ""))).length;
      const count = Number.isFinite(declared) && declared > 0 ? declared : directJP2;
      if (count > 0 && pageServer(record)) sets.push({ sourceFile: null, zipFile: null, base: null, sourceKind: "item", count });
    }
    return sets;
  }

  async function countForScanSet(record, set) {
    if (Number.isFinite(set.count) && set.count > 0) return Math.min(set.count, MAX_PAGES);
    if (set.sourceKind === "item") return Math.min(Number(set.count) || 0, MAX_PAGES);
    // Archive's page_numbers.json can describe only labelled leaves, while
    // the JP2 ZIP filecount describes the actual image files. Prefer the
    // latter so the generated reader paths cover the complete scan.
    if (Number.isFinite(set.archiveFileCount) && set.archiveFileCount > 0) {
      set.count = set.archiveFileCount;
      return Math.min(set.count, MAX_PAGES);
    }
    const identifier = String(firstValue(record && record.metadata && record.metadata.identifier) || "");
    if (!identifier || !set.sourceFile) return 0;
    if (set.sourceKind === "pageNumbers") {
      const payload = await fetchJSON(downloadURL(identifier, set.sourceFile), 2 * 1024 * 1024);
      const count = Array.isArray(payload && payload.pages) ? payload.pages.length : 0;
      set.count = count;
      return Math.min(count, MAX_PAGES);
    }
    const response = await fetchDirect(downloadURL(identifier, set.sourceFile), { maxBytesHint: 2 * 1024 * 1024, responseClass: "text" });
    const body = await responseText(response);
    const declared = Number(body.match(/<leafCount>\s*(\d+)\s*<\/leafCount>/i)?.[1] || 0);
    const leaves = [...body.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["']/gi)].map((match) => Number(match[1]));
    const count = declared > 0 ? declared : (leaves.length ? Math.max(...leaves) + 1 : 0);
    set.count = count;
    return Math.min(count, MAX_PAGES);
  }

  async function scanSets(record) {
    const identifier = String(firstValue(record && record.metadata && record.metadata.identifier) || "");
    if (identifier && scanSetCache.has(identifier)) return scanSetCache.get(identifier);
    const descriptors = scanSetDescriptors(record);
    const output = new Array(descriptors.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < descriptors.length) {
        const index = nextIndex;
        nextIndex += 1;
        const descriptor = descriptors[index];
        try {
          const count = await countForScanSet(record, descriptor);
          if (count > 0) output[index] = { ...descriptor, count };
        } catch (_) {
          // One unavailable scan set must not hide other readable sets in a collection.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, descriptors.length) }, () => worker()));
    const readable = output.filter(Boolean);
    if (identifier && readable.length) {
      if (scanSetCache.size >= 12) scanSetCache.delete(scanSetCache.keys().next().value);
      scanSetCache.set(identifier, readable);
    }
    return readable;
  }

  function readableScanTitle(base, identifier) {
    const title = String(base || identifier).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return title || "Book";
  }

  function scanReference(identifier, set) {
    return set.sourceFile ? downloadURL(identifier, set.sourceFile) : `${BASE_URL}/details/${encodeURIComponent(identifier)}`;
  }

  async function extractChapters(id) {
    const identifier = normalizeIdentifier(id);
    const record = await metadataFor(identifier);
    const metadata = record.metadata;
    const sets = await scanSets(record);
    return sets.map((set, index) => {
      const reference = scanReference(identifier, set);
      return { id: reference, href: reference, url: reference, title: sets.length === 1 ? `Full book (${set.count} pages)` : `${readableScanTitle(set.base, identifier)} (${set.count} pages)`, number: index + 1, releaseDate: String(firstValue(metadata.publicdate) || "") || null, language: String(firstValue(metadata.language) || "und") };
    });
  }

  function archiveServer(record) {
    const server = String(record && (record.server || record.d1) || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!/^(?:[A-Za-z0-9-]+\.)*archive\.org$/i.test(server)) return "";
    return server;
  }

  function pageServer(record) {
    const server = archiveServer(record);
    const dir = String(record && record.dir || "").trim();
    return server && dir.startsWith("/") ? { server, dir } : null;
  }

  function pageNumber(index, count) {
    const oneBasedIndex = Math.max(1, Number(index) + 1);
    return String(oneBasedIndex).padStart(Math.max(4, String(Math.max(1, count)).length), "0");
  }

  function imageURL(record, identifier, set, index) {
    const host = pageServer(record);
    if (!host) throw new Error("Internet Archive item has no page image server.");
    const url = new URL(`https://${host.server}/BookReader/BookReaderImages.php`);
    url.searchParams.set("id", identifier);
    url.searchParams.set("scale", "4");
    url.searchParams.set("rotate", "0");
    if (set.sourceKind === "item") {
      url.searchParams.set("itemPath", host.dir);
      url.searchParams.set("server", host.server);
      url.searchParams.set("page", `n${index}`);
    } else {
      url.searchParams.set("zip", `${host.dir}/${set.zipFile}`);
      url.searchParams.set("file", `${set.base}_jp2/${set.base}_${pageNumber(index, set.count)}.jp2`);
    }
    return url.toString();
  }

  async function extractImages(id) {
    const requested = downloadReference(id);
    const record = await metadataFor(requested.identifier);
    const sets = await scanSets(record);
    const set = requested.fileName
      ? sets.find((candidate) => sameName(candidate.sourceFile, requested.fileName))
      : sets[0];
    if (!set) throw new Error("Internet Archive item has no readable page-image set.");
    const pages = [];
    for (let index = 0; index < set.count; index += 1) pages.push({ url: imageURL(record, requested.identifier, set, index) });
    return pages;
  }

  async function discoveryHome() {
    const popular = await searchResults("__feed:popular", 1);
    const latest = await searchResults("__feed:latest", 1);
    return { sections: [{ id: "popular", title: "Popular Internet Archive Scans", items: popular.items }, { id: "latest", title: "Recently added Internet Archive Scans", items: latest.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
    return searchResults(`__feed:${feed}`, page);
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
