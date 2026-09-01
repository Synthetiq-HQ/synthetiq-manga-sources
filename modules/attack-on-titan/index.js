"use strict";

(() => {
  const BASE_URL = "https://w47.read-attackontitan-manga.com";
  const SERIES_URL = BASE_URL + "/";
  const SERIES_TITLE = "Attack on Titan";
  const SERIES_SLUG = "attack-on-titan";
  const SERIES_HOSTS = new Set([
    "w47.read-attackontitan-manga.com",
    "w40.read-attackontitan-manga.com",
    "w46.read-attackontitan-manga.com",
    "read-attackontitan-manga.com",
    "www.read-attackontitan-manga.com",
  ]);
  const IMAGE_HOSTS = new Set(["cdn.mangagoa.xyz", "cdn.readkakegurui.com"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: SERIES_URL,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 2;
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  const HOME_CACHE_TTL_MS = 5 * 60 * 1000;
  let homeCache = { fetchedAt: 0, value: null, promise: null };

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
    const pattern = new RegExp("\\b" + name + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1", "i");
    const quoted = String(tag || "").match(pattern);
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp("\\b" + name + "\\s*=\\s*([^\\s>]+)", "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => (typeof value === "string" ? value : ""));
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function sourceURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:" || !SERIES_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function sourceAssetURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base || BASE_URL);
      if (url.protocol !== "https:" || !SERIES_HOSTS.has(url.hostname.toLowerCase())) return "";
      if (!/\/wp-content\/uploads\//i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function imageURL(value, base) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base || SERIES_URL);
      if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname.toLowerCase())) return "";
      return url.toString().split("#")[0];
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
      throw new Error(SERIES_TITLE + " requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(requestOptions.headers || {}) },
          "GET",
          null,
          {
            followRedirects: true,
            maxBytesHint: requestOptions.maxBytesHint || MAX_HTML_BYTES,
            responseClass: "html",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(SERIES_TITLE + " request failed with HTTP " + (status || "error") + ".");
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        if (response.bodyDropped) {
          throw new Error(SERIES_TITLE + " response exceeded the app size limit.");
        }
        const body = await responseText(response);
        if (!body.trim()) throw new Error(SERIES_TITLE + " returned an empty response.");
        if (isChallengePage(body)) {
          throw new Error(SERIES_TITLE + " returned a challenge or access-denied page.");
        }
        return { body, finalUrl: response.finalUrl || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error(SERIES_TITLE + " request failed.");
  }

  async function loadHome(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && homeCache.value && now - homeCache.fetchedAt < HOME_CACHE_TTL_MS) {
      return homeCache.value;
    }
    if (!forceRefresh && homeCache.promise) return homeCache.promise;

    const promise = fetchHTML(SERIES_URL).then((value) => {
      homeCache = { fetchedAt: Date.now(), value, promise: null };
      return value;
    }).catch((error) => {
      homeCache.promise = null;
      throw error;
    });
    homeCache.promise = promise;
    return promise;
  }

  function chapterURLParts(value, base) {
    const url = sourceURL(value, base || BASE_URL);
    if (!url) return null;
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /^\/manga\/(attack-on-titan|shingeki-no-kyojin)(?:-colored)?-chapter-([0-9]+(?:\.[0-9]+)?)(?:-([0-9]+))?\/?$/i,
    );
    if (!match) return null;
    const numberText = match[3] ? match[2] + "." + match[3] : match[2];
    const number = Number(numberText);
    if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
    return {
      url,
      path: parsed.pathname.replace(/\/+$/, "/"),
      number,
      numberText,
      key: String(number),
    };
  }

  function parseChapterList(html, base) {
    const chapters = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const match of String(html || "").matchAll(anchorPattern)) {
      const href = attribute(match[0], "href");
      const parts = chapterURLParts(href, base || BASE_URL);
      if (!parts || seen.has(parts.key)) continue;
      const canonicalURL = BASE_URL + parts.path;
      chapters.push({
        id: canonicalURL,
        href: canonicalURL,
        url: canonicalURL,
        title: SERIES_TITLE + " Chapter " + parts.numberText,
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

  function srcsetCandidates(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function parseCover(html, base) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, "property").toLowerCase() !== "og:image") continue;
      const cover = sourceAssetURL(attribute(tag, "content"), base || BASE_URL);
      if (cover) return cover;
    }

    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const candidates = [
        attribute(tag, "data-lazy-src"),
        attribute(tag, "data-src"),
        attribute(tag, "data-original"),
        attribute(tag, "src"),
        ...srcsetCandidates(attribute(tag, "data-lazy-srcset")),
        ...srcsetCandidates(attribute(tag, "srcset")),
      ];
      for (const candidate of candidates) {
        const cover = sourceAssetURL(candidate, base || BASE_URL);
        if (cover) return cover;
      }
    }
    return "";
  }

  function parseDescription(html) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      const name = attribute(tag, "name").toLowerCase();
      if (name === "description") {
        const description = stripHTML(attribute(tag, "content"));
        if (description) return description;
      }
    }
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, "property").toLowerCase() !== "og:description") continue;
      const description = stripHTML(attribute(tag, "content"));
      if (description) return description;
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
    const text = String(query || "").trim().toLowerCase();
    if (!text || text.startsWith("__feed:")) return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0].length < 2) return true;
    const haystack = (
      SERIES_TITLE + " " + SERIES_SLUG + " shingeki no kyojin shingeki-no-kyojin aot manga"
    ).toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  }

  async function searchResults(query, page) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (requestedPage > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const home = await loadHome(false);
    return {
      items: [seriesItem(parseCover(home.body, home.finalUrl || BASE_URL), parseDescription(home.body))],
      hasMore: false,
    };
  }

  function isSeriesID(id) {
    const requested = sourceURL(id, BASE_URL);
    return Boolean(requested && new URL(requested).pathname === "/");
  }

  async function extractDetails(id) {
    if (!isSeriesID(id)) throw new Error("Invalid " + SERIES_TITLE + " series identifier.");
    const home = await loadHome(false);
    const description = parseDescription(home.body);
    return {
      ...seriesItem(parseCover(home.body, home.finalUrl || BASE_URL), description),
      status: "Completed",
      genres: ["Action", "Drama", "Fantasy", "Shounen"],
    };
  }

  async function extractChapters(id) {
    if (!isSeriesID(id)) throw new Error("Invalid " + SERIES_TITLE + " series identifier.");
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(700 * attempt);
      const home = await loadHome(attempt > 1);
      chapters = parseChapterList(home.body, home.finalUrl || BASE_URL);
    }
    if (!chapters.length) throw new Error(SERIES_TITLE + " returned no owned chapter links.");
    return chapters;
  }

  function parseImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const classes = attribute(tag, "class");
      if (!/(^|\s)(wp-manga-chapter-img|manga-image|aligncenter)(\s|$)/i.test(classes)) continue;
      const candidates = [
        attribute(tag, "data-lazy-src"),
        attribute(tag, "data-src"),
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

  async function extractImages(id) {
    const chapter = chapterURLParts(id, BASE_URL);
    if (!chapter) throw new Error("Invalid " + SERIES_TITLE + " chapter identifier.");
    const page = await fetchHTML(chapter.url, { headers: { Referer: chapter.url } });
    const pageURL = sourceURL(page.finalUrl || chapter.url, chapter.url) || chapter.url;
    const pages = parseImages(page.body, pageURL);
    if (!pages.length) {
      if (/coming\s+soon|not\s+available|pending/i.test(page.body)) {
        throw new Error(SERIES_TITLE + " chapter " + chapter.numberText + " is not available yet.");
      }
      throw new Error(SERIES_TITLE + " chapter " + chapter.numberText + " returned no readable page images.");
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
    return searchResults("__feed:" + feed, page || 1);
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
