"use strict";

(() => {
  const BASE_URL = "https://archive.org";
  const SEARCH_ROWS = 50;
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const DEFAULT_HEADERS = {
    Accept: "application/json,text/plain;q=0.9,*/*;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const metadataCache = new Map();

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
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("Internet Archive requires the fetchv2 bridge.");
    }
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
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || null,
            responseClass: options.responseClass || "json",
          },
        );
      } catch (error) {
        // Bridge/network failures (timeouts, aborted sockets) are transient.
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Internet Archive request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) {
        throw new Error(`Internet Archive response was dropped: ${response.dropReason || "size policy"}.`);
      }
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
    const body = await responseText(response);
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error("Internet Archive returned invalid JSON.");
    }
  }

  function flagIsTrue(value) {
    if (value === true || value === 1) return true;
    return ["true", "1", "yes"].includes(String(value || "").toLowerCase());
  }

  function hasRecognizedOpenLicense(metadata) {
    const licenseURL = String(firstValue(metadata && metadata.licenseurl) || "").trim();
    const normalizedLicense = licenseURL.toLowerCase();
    if (/^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses\/(?:by|by-sa|by-nd|by-nc|by-nc-sa|by-nc-nd)|publicdomain\/(?:zero|mark))\/[0-9.]+\/?$/.test(normalizedLicense)) return true;
    if (/^https?:\/\/(?:www\.)?gnu\.org\/licenses\//.test(normalizedLicense)) return true;
    if (/^https?:\/\/(?:www\.)?opensource\.org\/(?:license|licenses)\//.test(normalizedLicense)) return true;
    if (/^https?:\/\/(?:www\.)?usa\.gov\/government-works\/?$/.test(normalizedLicense)) return true;

    const rights = String(firstValue(metadata && metadata.rights) || "").trim().toLowerCase();
    if (!rights || /not (?:in )?(?:the )?public domain|all rights reserved|copyrighted/.test(rights)) return false;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(identifier)) {
      throw new Error("Invalid Internet Archive identifier.");
    }
    return identifier;
  }

  function downloadReference(value) {
    const input = String(value || "").trim();
    const match = input.match(/^https:\/\/(?:www\.)?archive\.org\/download\/([^/?#]+)\/(.+?)(?:[?#].*)?$/i);
    if (!match) return { identifier: normalizeIdentifier(input), fileName: null };
    const fileName = match[2].split("/").map((part) => decodeURIComponent(part)).join("/");
    if (!fileName || fileName.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid Internet Archive file path.");
    }
    return { identifier: normalizeIdentifier(decodeURIComponent(match[1])), fileName };
  }

  function encodedFileName(value) {
    return String(value).split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  function downloadURL(identifier, fileName) {
    return `${BASE_URL}/download/${encodeURIComponent(identifier)}/${encodedFileName(fileName)}`;
  }

  async function metadataFor(identifier) {
    const id = normalizeIdentifier(identifier);
    if (metadataCache.has(id)) return metadataCache.get(id);
    const record = await fetchJSON(`${BASE_URL}/metadata/${encodeURIComponent(id)}?extended_err=1`, 12 * 1024 * 1024);
    if (!record || record.error || !record.metadata) {
      throw new Error(`Internet Archive metadata is unavailable for ${id}.`);
    }
    if (!isOpenRecord(record)) {
      throw new Error("Internet Archive item is not explicitly open, licensed, and downloadable.");
    }
    if (metadataCache.size >= 8) metadataCache.delete(metadataCache.keys().next().value);
    metadataCache.set(id, record);
    return record;
  }

  function openSearchClause(query) {
    const text = String(query || "").trim().slice(0, 200);
    const open = '(licenseurl:* OR rights:"Public Domain" OR rights:"Creative Commons" OR rights:CC0)';
    if (!text || text.startsWith("__feed:")) return `mediatype:texts AND -access-restricted-item:true AND ${open}`;
    const phrase = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `mediatype:texts AND -access-restricted-item:true AND ${open} AND (title:"${phrase}" OR creator:"${phrase}")`;
  }

  function advancedSearchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const params = [["q", openSearchClause(query)]];
    [
      "identifier", "title", "description", "creator", "licenseurl", "rights",
      "language", "publicdate", "subject", "downloads", "mediatype",
    ].forEach((field) => params.push(["fl[]", field]));
    params.push(["rows", String(SEARCH_ROWS)]);
    params.push(["page", String(currentPage)]);
    params.push(["output", "json"]);
    const sort = query === "__feed:latest" ? "publicdate desc" : "downloads desc";
    params.push(["sort[]", sort]);
    return `${BASE_URL}/advancedsearch.php?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
  }

  function searchItem(item) {
    if (!item || !isOpenRecord(item)) return null;
    const identifier = String(item.identifier || "");
    const title = String(firstValue(item.title) || identifier).trim();
    if (!identifier || !title) return null;
    const href = `${BASE_URL}/details/${encodeURIComponent(identifier)}`;
    return {
      id: identifier,
      href,
      url: href,
      title,
      image: `${BASE_URL}/services/img/${encodeURIComponent(identifier)}`,
      description: stripHTML(item.description),
      author: stringList(item.creator).join(", "),
      genres: stringList(item.subject).slice(0, 20),
      status: "Completed",
    };
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
    return {
      id: identifier,
      href: `${BASE_URL}/details/${encodeURIComponent(identifier)}`,
      url: `${BASE_URL}/details/${encodeURIComponent(identifier)}`,
      title: String(firstValue(metadata.title) || identifier),
      description: stripHTML(metadata.description),
      image: `${BASE_URL}/services/img/${encodeURIComponent(identifier)}`,
      author: stringList(metadata.creator).join(", "),
      authors: stringList(metadata.creator),
      genres: stringList(metadata.subject).slice(0, 50),
      status: "Completed",
      licenseURL: String(firstValue(metadata.licenseurl) || ""),
    };
  }

  function publicFile(file) {
    return file && file.name && !flagIsTrue(file.private) && !flagIsTrue(file["access-restricted-item"]);
  }

  function textFiles(record) {
    return (Array.isArray(record.files) ? record.files : [])
      .filter(publicFile)
      .filter((file) => {
        const format = String(file.format || "").toLowerCase();
        const name = String(file.name || "").toLowerCase();
        const size = Number(file.size || 0);
        return size > 0 && size <= MAX_TEXT_BYTES && name.endsWith(".txt")
          && (format === "djvutxt" || format === "full text" || format === "text");
      })
      .sort((left, right) => {
        const leftRank = /_djvu\.txt$/i.test(left.name) ? 0 : 1;
        const rightRank = /_djvu\.txt$/i.test(right.name) ? 0 : 1;
        return leftRank - rightRank || String(left.name).localeCompare(String(right.name));
      });
  }

  function publicationFiles(record) {
    return (Array.isArray(record.files) ? record.files : [])
      .filter(publicFile)
      .map((file) => {
        const name = String(file.name || "");
        const formatName = String(file.format || "").toLowerCase();
        let format = null;
        if (name.toLowerCase().endsWith(".epub") && formatName.includes("epub")) format = "epub";
        if (name.toLowerCase().endsWith(".pdf") && formatName.includes("pdf")) format = "pdf";
        return format ? { file, format } : null;
      })
      .filter(Boolean);
  }

  async function extractChapters(id) {
    const identifier = normalizeIdentifier(id);
    const record = await metadataFor(identifier);
    const metadata = record.metadata;
    return textFiles(record).map((file, index) => {
      const href = downloadURL(identifier, file.name);
      return {
        id: href,
        href,
        url: href,
        title: textFiles(record).length === 1 ? "Full text" : `Full text: ${file.name}`,
        number: index + 1,
        releaseDate: String(firstValue(metadata.publicdate) || "") || null,
        language: String(firstValue(metadata.language) || "und"),
      };
    });
  }

  async function extractText(reference) {
    const requested = downloadReference(reference);
    const record = await metadataFor(requested.identifier);
    const candidates = textFiles(record);
    const selected = requested.fileName
      ? candidates.find((file) => file.name === requested.fileName)
      : candidates[0];
    if (!selected) throw new Error("Internet Archive item has no eligible openly downloadable text file.");
    const response = await fetchDirect(downloadURL(requested.identifier, selected.name), {
      headers: { Accept: "text/plain,*/*;q=0.5" },
      maxBytesHint: MAX_TEXT_BYTES,
      responseClass: "text",
    });
    const text = await responseText(response);
    if (!text) throw new Error("Internet Archive text file was empty.");
    return text;
  }

  async function extractResources(id) {
    const identifier = normalizeIdentifier(id);
    const record = await metadataFor(identifier);
    return publicationFiles(record).map(({ file, format }) => ({
      format,
      url: downloadURL(identifier, file.name),
      fileName: String(file.name),
      size: Number(file.size || 0) || null,
      headers: { Referer: `${BASE_URL}/details/${encodeURIComponent(identifier)}` },
    }));
  }

  async function discoveryHome() {
    const popular = await searchResults("__feed:popular", 1);
    const latest = await searchResults("__feed:latest", 1);
    return {
      sections: [
        { id: "popular", title: "Popular open texts", items: popular.items },
        { id: "latest", title: "Recently added open texts", items: latest.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
    return searchResults(`__feed:${feed}`, page);
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractText,
    extractResources,
    discoveryHome,
    discoveryFeed,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
