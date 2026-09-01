"use strict";

(() => {
  const BASE_URL = "https://readichithewitch.com";
  const CANONICAL_HOST = "ww2.readichithewitch.com";
  const SERIES_URL = `https://${CANONICAL_HOST}/manga/ichi-the-witch/`;
  const SERIES_TITLE = "Ichi the Witch";
  const SERIES_SLUG = "ichi-the-witch";
  const COVER_ASSET_URL = "https://raw.githubusercontent.com/Synthetiq-HQ/synthetiq-manga-sources/main/modules/ichi-the-witch/icon.png";
  const SOURCE_HOSTS = new Set([
    "readichithewitch.com",
    "www.readichithewitch.com",
    CANONICAL_HOST,
  ]);
  const COVER_HOSTS = new Set(["i.imgur.com"]);
  const READER_IMAGE_HOST = "cdn.readichithewitch.com";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 2;
  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  let seriesCache = { fetchedAt: 0, value: null, promise: null };

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      hellip: "…",
      ldquo: "“",
      lt: "<",
      nbsp: " ",
      ndash: "–",
      quot: '"',
      rdquo: "”",
      rsquo: "’",
    };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(
      String(value || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const pattern = new RegExp("\\b" + name + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1", "i");
    const quoted = String(tag || "").match(pattern);
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp("\\b" + name + "\\s*=\\s*([^\\s>]+)", "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  function normalizeHTTP(value) {
    return String(value || "").trim().replace(/^http:/i, "https:");
  }

  function sourceURL(value, base = BASE_URL) {
    const input = normalizeHTTP(value);
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !SOURCE_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function coverURL(value, base = SERIES_URL) {
    const input = normalizeHTTP(value);
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname.toLowerCase())) return "";
      if (!/\.(?:jpe?g|png|webp|avif)(?:$|\?)/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function readerImageURL(value, base = SERIES_URL) {
    const input = normalizeHTTP(value).replace(/\s+/g, "");
    if (!input || /^data:/i.test(input)) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== READER_IMAGE_HOST) return "";
      if (!/^\/file\/mangap\//i.test(url.pathname)) return "";
      if (!/\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return /<title[^>]*>\s*(?:just a moment|attention required|access denied)/i.test(page)
      || page.includes("cf-chl-")
      || page.includes("verify you are human")
      || page.includes("checking your browser")
      || page.includes("challenge-platform");
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(500 * attempt);
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          "GET",
          null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || MAX_HTML_BYTES,
            responseClass: "html",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`${SERIES_TITLE} request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        if (response.bodyDropped) {
          throw new Error(`${SERIES_TITLE} response exceeded the app size limit.`);
        }
        const body = await responseText(response);
        if (!body.trim()) throw new Error(`${SERIES_TITLE} returned an empty response.`);
        if (isChallengePage(body)) {
          throw new Error(`${SERIES_TITLE} returned a challenge or access-denied page.`);
        }
        return { body, finalUrl: sourceURL(response.finalUrl || url, url) || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  async function loadSeriesPage(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && seriesCache.value && now - seriesCache.fetchedAt < CACHE_TTL_MS) {
      return seriesCache.value;
    }
    if (!forceRefresh && seriesCache.promise) return seriesCache.promise;

    const promise = fetchHTML(SERIES_URL).then((value) => {
      seriesCache = { fetchedAt: Date.now(), value, promise: null };
      return value;
    }).catch((error) => {
      seriesCache.promise = null;
      throw error;
    });
    seriesCache.promise = promise;
    return promise;
  }

  function isSeriesURL(value) {
    const url = sourceURL(value, BASE_URL);
    if (!url) return false;
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "/").toLowerCase() === "/manga/ichi-the-witch/";
  }

  function chapterURLParts(value, base = SERIES_URL) {
    const url = sourceURL(value, base);
    if (!url) return null;
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/chapter\/ichi-the-witch-chapter-([0-9]+(?:[.-][0-9]+)?)\/?$/i);
    if (!match) return null;
    const numberText = match[1].replace(/-/g, ".");
    const number = Number(numberText);
    if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
    return {
      number,
      numberText,
      path: `/chapter/ichi-the-witch-chapter-${match[1].toLowerCase()}/`,
      url: `https://${CANONICAL_HOST}/chapter/ichi-the-witch-chapter-${match[1].toLowerCase()}/`,
      key: String(number),
    };
  }

  function parseMeta(html, key, attributeName) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, attributeName).toLowerCase() !== key.toLowerCase()) continue;
      const content = stripHTML(attribute(tag, "content"));
      if (content) return content;
    }
    return "";
  }

  function parseCover(html, base) {
    return COVER_ASSET_URL;
  }

  function parseDescription(html) {
    const marker = String(html || "").match(
      /<div\b[^>]*>\s*Description\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (marker) {
      const description = stripHTML(marker[1]);
      if (description) return description.slice(0, 2000);
    }
    return parseMeta(html, "description", "name") || parseMeta(html, "og:description", "property");
  }

  function seriesItem(page) {
    const body = page?.body || "";
    const base = page?.finalUrl || SERIES_URL;
    return {
      id: SERIES_URL,
      href: SERIES_URL,
      url: SERIES_URL,
      title: SERIES_TITLE,
      image: parseCover(body, base),
      description: parseDescription(body),
    };
  }

  function queryMatchesSeries(query) {
    const text = String(query || "").trim().toLowerCase();
    if (!text || text.startsWith("__feed:")) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} madan no ichi`.toLowerCase();
    return text.split(/\s+/).filter(Boolean).every((token) => token.length < 2 || haystack.includes(token));
  }

  function parseChapterList(html, base) {
    const chapters = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const href = attribute(match[0], "href");
      const parts = chapterURLParts(href, base || SERIES_URL);
      if (!parts || seen.has(parts.key)) continue;
      chapters.push({
        id: parts.url,
        href: parts.url,
        url: parts.url,
        title: `${SERIES_TITLE} Chapter ${parts.numberText}`,
        number: parts.number,
        language: "en",
      });
      seen.add(parts.key);
    }
    chapters.sort((left, right) => {
      if (right.number !== left.number) return right.number - left.number;
      return left.url.localeCompare(right.url);
    });
    return chapters;
  }

  function imageAttributeCandidates(tag) {
    const values = [];
    for (const name of ["data-src", "data-lazy-src", "data-original", "src"]) {
      const value = attribute(tag, name);
      if (value) values.push(value);
    }
    return values;
  }

  function parseReaderImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      let url = "";
      for (const candidate of imageAttributeCandidates(match[0])) {
        url = readerImageURL(candidate, pageURL || SERIES_URL);
        if (url) break;
      }
      if (!url || seen.has(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: pageURL || SERIES_URL,
        },
      });
      seen.add(url);
    }
    return pages;
  }

  async function searchResults(query, page = 1) {
    if (Number(page) > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const listing = await loadSeriesPage(false);
    return { items: [seriesItem(listing)], hasMore: false };
  }

  async function extractDetails(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const listing = await loadSeriesPage(false);
    const item = seriesItem(listing);
    return {
      ...item,
      status: "Ongoing",
      genres: [],
    };
  }

  async function extractChapters(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const listing = await loadSeriesPage(false);
    const chapters = parseChapterList(listing.body, listing.finalUrl || SERIES_URL);
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id, SERIES_URL);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.url, { headers: { Referer: chapter.url } });
    const pageURL = sourceURL(page.finalUrl || chapter.url, chapter.url) || chapter.url;
    const pages = parseReaderImages(page.body, pageURL);
    if (!pages.length) {
      throw new Error(`${SERIES_TITLE} chapter ${chapter.numberText} returned no readable page images.`);
    }
    return pages;
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:latest", 1);
    return { sections: [{ id: "latest", title: SERIES_TITLE, items: result.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "latest").toLowerCase();
    if (feed !== "latest" && feed !== "popular") return { items: [], hasMore: false };
    return searchResults(`__feed:${feed}`, page);
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
