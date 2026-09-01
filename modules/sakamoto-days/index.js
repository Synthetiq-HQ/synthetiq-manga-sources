"use strict";

(() => {
  const BASE_URL = "https://ww2.readsakadays.com";
  const SERIES_PATH = "/manga/sakamoto-days/";
  const SERIES_URL = BASE_URL + SERIES_PATH;
  const SERIES_TITLE = "Sakamoto Days";
  const SERIES_SLUG = "sakamoto-days";
  const COVER_ASSET_URL = "https://raw.githubusercontent.com/Synthetiq-HQ/synthetiq-manga-sources/main/modules/sakamoto-days/icon.png";
  const SERIES_HOSTS = new Set([
    "readsakadays.com",
    "www.readsakadays.com",
    "ww1.readsakadays.com",
    "ww2.readsakadays.com",
  ]);
  const IMAGE_HOST = "cdn.readsakadays.com";
  const COVER_HOST = "i.imgur.com";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: BASE_URL + "/",
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
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const quoted = String(tag || "").match(
      new RegExp("\\b" + name + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1", "i"),
    );
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp("\\b" + name + "\\s*=\\s*([^\\s>]+)", "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function sourceURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !SERIES_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function coverURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== COVER_HOST) return "";
      if (!/\.(?:jpg|jpeg|png|webp|avif)(?:$|\?)/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function imageURL(value, base = SERIES_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== IMAGE_HOST) return "";
      if (!/^\/file\/mangap\//i.test(url.pathname)) return "";
      if (!/\.(?:jpg|jpeg|png|webp|avif)(?:$|\?)/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return /<title[^>]*>\s*(?:just a moment|access denied|attention required)/i.test(page)
      || page.includes("cf-chl-")
      || page.includes("challenge-platform")
      || page.includes("verify you are human")
      || page.includes("checking your browser");
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      return typeof value === "string" ? value : "";
    }
    return typeof response.body === "string" ? response.body : "";
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
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
        const finalUrl = sourceURL(response.finalUrl || url, url);
        if (!finalUrl) throw new Error(`${SERIES_TITLE} redirected to an unsupported host.`);
        return { body, finalUrl };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded|unsupported host/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  async function loadSeries(forceRefresh = false) {
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

  function normalizePath(pathname) {
    const value = String(pathname || "/");
    return value.endsWith("/") ? value : `${value}/`;
  }

  function isSeriesID(id) {
    const requested = sourceURL(id, BASE_URL);
    if (!requested) return false;
    const pathname = normalizePath(new URL(requested).pathname);
    return pathname === "/" || pathname === SERIES_PATH;
  }

  function chapterURLParts(value, base = BASE_URL) {
    const url = sourceURL(value, base);
    if (!url) return null;
    const parsed = new URL(url);
    const pathname = normalizePath(parsed.pathname);
    const match = pathname.match(/^\/chapter\/sakamoto-days-chapter-([0-9]+(?:\.[0-9]+)?)\/$/i);
    if (!match) return null;
    const numberText = match[1];
    const number = Number(numberText);
    if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
    return {
      url,
      number,
      numberText,
      key: String(number),
    };
  }

  function parseCover(html, base) {
    return COVER_ASSET_URL;
  }

  function parseDescription(html) {
    const labeled = String(html || "").match(
      />\s*Description\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i,
    );
    const synopsis = labeled ? stripHTML(labeled[1]) : "";
    if (synopsis) return synopsis.slice(0, 2000);

    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, "property").toLowerCase() !== "og:description") continue;
      const description = stripHTML(attribute(tag, "content"));
      if (description) return description.slice(0, 2000);
    }
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, "name").toLowerCase() !== "description") continue;
      const description = stripHTML(attribute(tag, "content"));
      if (description) return description.slice(0, 2000);
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

  function queryText(query) {
    if (query && typeof query === "object") return String(query.text || "").trim().toLowerCase();
    return String(query || "").trim().toLowerCase();
  }

  function queryMatchesSeries(query) {
    const text = queryText(query);
    if (!text || text.startsWith("__feed:")) return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0].length < 2) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} sakamoto manga`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  function parseChapterList(html, base) {
    const chapters = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const parts = chapterURLParts(attribute(match[0], "href"), base || BASE_URL);
      if (!parts || seen.has(parts.key)) continue;
      const canonicalURL = `${BASE_URL}/chapter/sakamoto-days-chapter-${parts.numberText}/`;
      chapters.push({
        id: canonicalURL,
        href: canonicalURL,
        url: canonicalURL,
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

  function parseImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/(^|\s)js-page(?:\s|$)/i.test(attribute(tag, "class"))) continue;
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

  async function searchResults(query, page = 1) {
    if (Number(page) > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const detail = await loadSeries(false);
    const description = parseDescription(detail.body);
    return {
      items: [seriesItem(parseCover(detail.body, detail.finalUrl || BASE_URL), description)],
      hasMore: false,
    };
  }

  async function extractDetails(id) {
    if (!isSeriesID(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const detail = await loadSeries(false);
    const description = parseDescription(detail.body);
    return {
      ...seriesItem(parseCover(detail.body, detail.finalUrl || BASE_URL), description),
      status: "Ongoing",
      authors: [],
      author: "",
      genres: ["Action", "Comedy", "Shounen"],
    };
  }

  async function extractChapters(id) {
    if (!isSeriesID(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
      const detail = await loadSeries(attempt > 1);
      chapters = parseChapterList(detail.body, detail.finalUrl || BASE_URL);
    }
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id, BASE_URL);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.url, { headers: { Referer: chapter.url } });
    const pageURL = sourceURL(page.finalUrl || chapter.url, chapter.url) || chapter.url;
    const pages = parseImages(page.body, pageURL);
    if (!pages.length) {
      if (/coming\s+soon|not\s+available|pending/i.test(page.body)) {
        throw new Error(`${SERIES_TITLE} chapter ${chapter.numberText} is not available yet.`);
      }
      throw new Error(`${SERIES_TITLE} chapter ${chapter.numberText} returned no readable page images.`);
    }
    return pages;
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:latest", 1);
    return {
      sections: [
        { id: "latest", title: SERIES_TITLE, items: result.items },
      ],
    };
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
