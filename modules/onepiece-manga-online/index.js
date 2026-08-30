"use strict";

(() => {
  const BASE_URL = "https://w76.onepiece-manga-online.net";
  const SERIES_URL = `${BASE_URL}/`;
  const SERIES_TITLE = "One Piece";
  const SERIES_SLUG = "one-piece";
  const SERIES_HOSTS = new Set([
    "w76.onepiece-manga-online.net",
    "w64.onepiece-manga-online.net",
    "onepiece-manga-online.net",
  ]);
  const IMAGE_HOSTS = new Set(["cdn.mangagoa.xyz"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: SERIES_URL,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  const HOME_CACHE_TTL_MS = 5 * 60 * 1000;
  let homeCache = { fetchedAt: 0, value: null };

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
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
    const quoted = String(tag || "").match(pattern);
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => (typeof value === "string" ? value : ""));
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
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

  function imageURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return page.includes("just a moment")
      || page.includes("cf-chl-")
      || page.includes("verify you are human")
      || page.includes("access denied")
      || page.includes("captcha");
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1000 * attempt);
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
        if (isChallengePage(body)) throw new Error(`${SERIES_TITLE} returned a challenge or access-denied page.`);
        return { body, finalUrl: response.finalUrl || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  async function loadHome(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && homeCache.value && now - homeCache.fetchedAt < HOME_CACHE_TTL_MS) {
      return homeCache.value;
    }
    const value = await fetchHTML(SERIES_URL);
    homeCache = { fetchedAt: now, value };
    return value;
  }

  function chapterURLParts(value) {
    const url = sourceURL(value, BASE_URL);
    if (!url) return null;
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/manga\/one-piece-chapter-([0-9]+(?:\.[0-9]+)?)\/?$/i);
    if (!match) return null;
    return { url, path: parsed.pathname.replace(/\/+$/, "/"), numberText: match[1] };
  }

  function parseChapterList(html, base = BASE_URL) {
    const chapters = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const match of String(html || "").matchAll(anchorPattern)) {
      const anchor = match[0];
      const href = attribute(anchor, "href");
      const parts = chapterURLParts(sourceURL(href, base));
      if (!parts || seen.has(parts.path.toLowerCase())) continue;
      const label = stripHTML(anchor.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, ""));
      const number = Number(parts.numberText);
      chapters.push({
        id: `${BASE_URL}${parts.path}`,
        href: `${BASE_URL}${parts.path}`,
        url: `${BASE_URL}${parts.path}`,
        title: label || `Chapter ${parts.numberText}`,
        number,
        language: "en",
      });
      seen.add(parts.path.toLowerCase());
    }
    chapters.sort((left, right) => right.number - left.number);
    return chapters;
  }

  function parseCover(html, base = BASE_URL) {
    const meta = String(html || "").match(/<meta\b[^>]*property=(['"])og:image\1[^>]*>/i)?.[0] || "";
    return imageOrSourceURL(attribute(meta, "content"), base, new Set(["onepiece-manga-online.net"]));
  }

  function imageOrSourceURL(value, base, hosts) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      // The source currently publishes its cover as an http URL inside an
      // HTTPS page. Upgrade only this known source host; never return HTTP.
      if (url.protocol === "http:" && hosts.has(url.hostname.toLowerCase())) url.protocol = "https:";
      if (url.protocol !== "https:" || !hosts.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function parseDescription(html) {
    const meta = String(html || "").match(/<meta\b[^>]*name=(['"])description\1[^>]*>/i)?.[0] || "";
    return stripHTML(attribute(meta, "content"));
  }

  function seriesItem(cover = "", description = "") {
    return {
      id: SERIES_URL,
      href: SERIES_URL,
      url: SERIES_URL,
      title: SERIES_TITLE,
      image: cover,
      description,
    };
  }

  function queryMatchesSeries(query) {
    const text = String(query || "").trim().toLowerCase();
    if (!text || text.startsWith("__feed:")) return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0].length < 2) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} manga online`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (requestedPage > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const home = await loadHome();
    return { items: [seriesItem(parseCover(home.body, home.finalUrl || BASE_URL), parseDescription(home.body))], hasMore: false };
  }

  async function extractDetails(id) {
    const requested = sourceURL(id, BASE_URL);
    if (!requested || new URL(requested).pathname !== "/") {
      throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    }
    const home = await loadHome();
    const description = parseDescription(home.body);
    return {
      ...seriesItem(parseCover(home.body, home.finalUrl || BASE_URL), description),
      status: "Ongoing",
      genres: ["Action", "Adventure", "Fantasy"],
    };
  }

  async function extractChapters(id) {
    const requested = sourceURL(id, BASE_URL);
    if (!requested || new URL(requested).pathname !== "/") {
      throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    }
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(1000 * attempt);
      const home = await loadHome(attempt > 1);
      chapters = parseChapterList(home.body, home.finalUrl || BASE_URL);
    }
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  function parseImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const classes = attribute(tag, "class");
      if (!/(^|\s)manga-image(?:\s|$)/i.test(classes)) continue;
      const url = imageURL(
        attribute(tag, "src")
          || attribute(tag, "data-src")
          || attribute(tag, "data-lazy-src")
          || attribute(tag, "data-original"),
        pageURL,
      );
      if (!url || seen.has(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: SERIES_URL,
        },
      });
      seen.add(url);
    }
    return pages;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.url);
    const pages = parseImages(page.body, page.finalUrl || chapter.url);
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
    return { sections: [{ id: "latest", title: "Latest", items: result.items }] };
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
