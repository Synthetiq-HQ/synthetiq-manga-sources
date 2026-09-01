"use strict";

(() => {
  const BASE_URL = "https://bluelockread.com";
  const SERIES_URL = `${BASE_URL}/manga/blue-lock/`;
  const SERIES_TITLE = "Blue Lock";
  const SERIES_SLUG = "blue-lock";
  const COVER_ASSET_URL = "https://raw.githubusercontent.com/Synthetiq-HQ/synthetiq-manga-sources/main/modules/blue-lock/icon.png";
  const IMAGE_HOST = "cdn.bluelockread.com";
  const COVER_HOST = "i.imgur.com";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 2;
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
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
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = String(tag || "").match(
      new RegExp("\\b" + escaped + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1", "i"),
    );
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(
      new RegExp("\\b" + escaped + "\\s*=\\s*([^\\s>]+)", "i"),
    );
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => (typeof value === "string" ? value : ""));
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function isSeriesHost(host) {
    const normalized = String(host || "").toLowerCase();
    return normalized === "bluelockread.com"
      || normalized === "www.bluelockread.com"
      || /^(?:w|ww)\d+\.bluelockread\.com$/i.test(normalized);
  }

  function safeURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:") return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function sourceURL(value, base) {
    const url = safeURL(value, base || BASE_URL);
    if (!url) return "";
    try {
      return isSeriesHost(new URL(url).hostname) ? url : "";
    } catch (_) {
      return "";
    }
  }

  function coverURL(value, base) {
    const url = safeURL(value, base || SERIES_URL);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== COVER_HOST) return "";
      if (/favicon|logo|sprite|icon/i.test(parsed.pathname)) return "";
      return parsed.toString();
    } catch (_) {
      return "";
    }
  }

  function imageURL(value, base) {
    const url = safeURL(value, base || SERIES_URL);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== IMAGE_HOST) return "";
      if (!/^\/file\/mangap\//i.test(parsed.pathname)) return "";
      if (!/\.(?:jpe?g|png|webp|avif)$/i.test(parsed.pathname)) return "";
      return parsed.toString();
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return /<title[^>]*>\s*(just a moment|access denied|attention required)/i.test(page)
      || page.includes("cf-chl-")
      || page.includes("verify you are human")
      || page.includes("checking your browser");
  }

  async function fetchHTML(url, options) {
    const requestOptions = options || {};
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(requestOptions.headers || {}) },
          requestOptions.method || "GET",
          requestOptions.body === undefined ? null : requestOptions.body,
          {
            followRedirects: true,
            maxBytesHint: requestOptions.maxBytesHint || MAX_HTML_BYTES,
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
        return { body, finalUrl: response.finalUrl || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|size limit/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  async function loadSeriesPage(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && seriesCache.value && now - seriesCache.fetchedAt < CACHE_TTL_MS) {
      return seriesCache.value;
    }
    if (!forceRefresh && seriesCache.promise) return seriesCache.promise;

    const promise = fetchHTML(SERIES_URL, { maxBytesHint: MAX_HTML_BYTES })
      .then((value) => {
        seriesCache = { fetchedAt: Date.now(), value, promise: null };
        return value;
      })
      .catch((error) => {
        seriesCache.promise = null;
        throw error;
      });
    seriesCache.promise = promise;
    return promise;
  }

  function parseCover(html, base) {
    return COVER_ASSET_URL;
  }

  function parseDescription(html) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      const property = attribute(tag, "property").toLowerCase();
      const name = attribute(tag, "name").toLowerCase();
      if (property === "og:description" || name === "description") {
        const description = stripHTML(attribute(tag, "content"));
        if (description) return description;
      }
    }
    return "";
  }

  function seriesItem(cover, description) {
    return {
      id: SERIES_URL,
      href: SERIES_URL,
      url: SERIES_URL,
      title: SERIES_TITLE,
      image: cover || "",
      description: description || "",
    };
  }

  function queryMatchesSeries(query) {
    const raw = String(query || "").trim();
    if (!raw || raw.toLowerCase().startsWith("__feed:")) return true;
    const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} bluelock manga read`.toLowerCase();
    return normalized.split(/\s+/).every((token) => token.length < 2 || haystack.includes(token));
  }

  function seriesID(value) {
    const url = sourceURL(value, BASE_URL);
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return /^\/manga\/blue-lock\/?$/i.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function chapterURLParts(value, base) {
    const url = sourceURL(value, base || BASE_URL);
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return null;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch (_) {
      pathname = parsed.pathname;
    }
    const match = pathname.match(/^\/chapter\/blue-lock-chapter-(\d+(?:\.\d+)?)\/?$/i);
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
    const canonicalPath = pathname.replace(/\/+$/, "/");
    const canonicalURL = `${parsed.origin}${canonicalPath}`;
    return {
      url: canonicalURL,
      number,
      numberText: String(number),
      key: String(number),
    };
  }

  function parseChapterList(html, base) {
    const chapters = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const parts = chapterURLParts(attribute(match[0], "href"), base || BASE_URL);
      if (!parts || seen.has(parts.key)) continue;
      chapters.push({
        id: parts.url,
        href: parts.url,
        url: parts.url,
        title: `${SERIES_TITLE} Chapter ${parts.numberText}`,
        number: parts.number,
        releaseDate: null,
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

  function parseImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const classes = attribute(tag, "class");
      if (!/(^|\s)js-page(\s|$)/i.test(classes)) continue;
      const candidates = [
        attribute(tag, "data-src"),
        attribute(tag, "data-lazy-src"),
        attribute(tag, "data-original"),
        attribute(tag, "src"),
      ];
      let url = "";
      for (const candidate of candidates) {
        url = imageURL(candidate, pageURL || SERIES_URL);
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

  async function searchResults(query, page) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (requestedPage > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const series = await loadSeriesPage(false);
    const base = series.finalUrl || SERIES_URL;
    return {
      items: [seriesItem(parseCover(series.body, base), parseDescription(series.body))],
      hasMore: false,
    };
  }

  async function extractDetails(id) {
    if (!seriesID(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const series = await loadSeriesPage(false);
    const base = series.finalUrl || SERIES_URL;
    return {
      ...seriesItem(parseCover(series.body, base), parseDescription(series.body)),
      status: "Ongoing",
      genres: ["Action", "Sports", "Shounen"],
    };
  }

  async function extractChapters(id) {
    if (!seriesID(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      const series = await loadSeriesPage(attempt > 1);
      chapters = parseChapterList(series.body, series.finalUrl || SERIES_URL);
    }
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id, BASE_URL);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.url, {
      headers: { Referer: chapter.url },
      maxBytesHint: MAX_HTML_BYTES,
    });
    const pageURL = sourceURL(page.finalUrl || chapter.url, chapter.url) || chapter.url;
    const pages = parseImages(page.body, pageURL);
    if (!pages.length) {
      if (/coming\s+soon|not\s+available|no\s+pages/i.test(page.body)) {
        throw new Error(`${SERIES_TITLE} chapter ${chapter.numberText} is not available yet.`);
      }
      throw new Error(`${SERIES_TITLE} chapter ${chapter.numberText} returned no readable page images.`);
    }
    return pages;
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:latest", 1);
    return { sections: [{ id: "latest", title: "Latest", items: result.items }] };
  }

  async function discoveryFeed(feedID, page) {
    const feed = String(feedID || "latest").toLowerCase();
    if (feed !== "latest" && feed !== "popular") return { items: [], hasMore: false };
    return searchResults(`__feed:${feed}`, page || 1);
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
