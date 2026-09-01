"use strict";

(() => {
  const BASE_URL = "https://readkingdom.com";
  const SERIES_URL = `${BASE_URL}/manga/kingdom/`;
  const SERIES_TITLE = "Kingdom";
  const SERIES_SLUG = "kingdom";
  const SOURCE_HOSTS = new Set([
    "readkingdom.com",
    "ww5.readkingdom.com",
    "ww6.readkingdom.com",
  ]);
  const IMAGE_HOSTS = new Set(["cdn.readkingdom.com"]);
  const COVER_HOSTS = new Set(["i.imgur.com"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  const HOME_CACHE_TTL_MS = 5 * 60 * 1000;
  let seriesCache = { at: 0, value: null };

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
      lt: "<",
      nbsp: " ",
      quot: '"',
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
    const quoted = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"),
    );
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"),
    );
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

  function sourceURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !SOURCE_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function coverURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function imageURL(value, base) {
    const input = String(value || "").trim();
    if (!input || /^data:/i.test(input)) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname.toLowerCase())) return "";
      if (!/^\/file\/mangap\//i.test(url.pathname)) return "";
      if (!/\.(?:jpe?g|png|webp|avif)(?:$|\?)/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "");
    return /<title[^>]*>\s*(?:just a moment|attention required|access denied|verify you are human)/i.test(page)
      || /cf-chl-(?:captcha|turnstile)/i.test(page)
      || /<form[^>]+(?:captcha|challenge)/i.test(page);
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    const requestedURL = sourceURL(url, BASE_URL);
    if (!requestedURL) throw new Error(`${SERIES_TITLE} request is outside the source host allowlist.`);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
      try {
        const response = await globalThis.fetchv2(
          requestedURL,
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
        if (isChallengePage(body)) throw new Error(`${SERIES_TITLE} returned an access challenge.`);
        return { body, finalUrl: response.finalUrl || requestedURL };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|empty response|exceeded|allowlist/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  async function loadSeriesPage(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && seriesCache.value && now - seriesCache.at < HOME_CACHE_TTL_MS) {
      return seriesCache.value;
    }
    const value = await fetchHTML(SERIES_URL, { maxBytesHint: MAX_HTML_BYTES });
    seriesCache = { at: now, value };
    return value;
  }

  function chapterURLParts(value, base = BASE_URL) {
    const url = sourceURL(value, base);
    if (!url) return null;
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /^\/chapter\/kingdom-chapter-([0-9]+(?:[.-][0-9]+)?)\/?$/i,
    );
    if (!match) return null;
    const rawNumber = match[1];
    const number = Number(rawNumber.replace(/-/g, "."));
    if (!Number.isFinite(number)) return null;
    const path = parsed.pathname.replace(/\/{2,}/g, "/") || "/";
    return {
      path,
      number,
      numberText: String(number),
      url: `${BASE_URL}${path}${parsed.search}`,
    };
  }

  function parseChapterList(html, base = BASE_URL) {
    const chaptersByPath = new Map();
    const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const match of String(html || "").matchAll(anchorPattern)) {
      const anchor = match[0];
      const parts = chapterURLParts(attribute(anchor, "href"), base);
      if (!parts) continue;
      const key = parts.path.replace(/\/+$/, "").toLowerCase() + new URL(parts.url).search;
      if (chaptersByPath.has(key)) continue;
      chaptersByPath.set(key, {
        id: parts.url,
        href: parts.url,
        url: parts.url,
        title: `Chapter ${parts.numberText}`,
        number: parts.number,
        releaseDate: null,
        language: "en",
      });
    }
    return [...chaptersByPath.values()].sort((left, right) => {
      const numberOrder = right.number - left.number;
      return numberOrder || right.id.localeCompare(left.id);
    });
  }

  function parseCover(html, base = BASE_URL) {
    const page = String(html || "");
    const metaTags = [...page.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
    for (const tag of metaTags) {
      const property = attribute(tag, "property").toLowerCase();
      const name = attribute(tag, "name").toLowerCase();
      if (property === "og:image" || name === "twitter:image") {
        const image = coverURL(attribute(tag, "content"), base);
        if (image) return image;
      }
    }
    for (const match of page.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      if (/\bjs-page\b/i.test(attribute(tag, "class"))) continue;
      const image = coverURL(
        attribute(tag, "src")
          || attribute(tag, "data-src")
          || attribute(tag, "data-lazy-src"),
        base,
      );
      if (image) return image;
    }
    return "";
  }

  function parseDescription(html) {
    const page = String(html || "");
    for (const match of page.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, "name").toLowerCase() === "description") {
        const description = stripHTML(attribute(tag, "content"));
        if (description) return description;
      }
    }
    return "";
  }

  function seriesIdentity(cover = "", description = "") {
    return {
      id: SERIES_URL,
      href: SERIES_URL,
      url: SERIES_URL,
      title: SERIES_TITLE,
      image: cover,
      description,
      authors: [],
      author: "",
      genres: [],
      status: "Ongoing",
    };
  }

  function queryText(query) {
    if (typeof query === "string") return query.trim();
    if (query && typeof query === "object") return String(query.text || "").trim();
    return "";
  }

  function queryMatchesSeries(query) {
    const text = queryText(query).toLowerCase();
    if (!text || text.startsWith("__feed:")) return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0].length < 2) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} manga historical`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  function isSeriesURL(value) {
    const url = sourceURL(value, BASE_URL);
    if (!url) return false;
    const parsed = new URL(url);
    return /^\/manga\/kingdom\/?$/i.test(parsed.pathname);
  }

  async function searchResults(query, page = 1) {
    if (Number(page) > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const series = await loadSeriesPage();
    const identity = seriesIdentity(
      parseCover(series.body, series.finalUrl || BASE_URL),
      parseDescription(series.body),
    );
    return {
      items: [{ id: identity.id, href: identity.href, title: identity.title, image: identity.image }],
      hasMore: false,
    };
  }

  async function extractDetails(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const series = await loadSeriesPage();
    return seriesIdentity(
      parseCover(series.body, series.finalUrl || BASE_URL),
      parseDescription(series.body),
    );
  }

  async function extractChapters(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
      const series = await loadSeriesPage(attempt > 1);
      chapters = parseChapterList(series.body, series.finalUrl || BASE_URL);
    }
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  function parseImagesHTML(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/\bjs-page\b/i.test(attribute(tag, "class"))) continue;
      const raw = attribute(tag, "data-src")
        || attribute(tag, "data-lazy-src")
        || attribute(tag, "data-original")
        || attribute(tag, "src");
      const url = imageURL(raw, pageURL);
      if (!url || seen.has(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: pageURL,
        },
      });
      seen.add(url);
    }
    return pages;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.url, { maxBytesHint: MAX_HTML_BYTES });
    const pages = parseImagesHTML(page.body, page.finalUrl || chapter.url);
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
