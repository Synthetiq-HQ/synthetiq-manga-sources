"use strict";

(() => {
  const BASE_URL = "https://readopm.com";
  const SERIES_URL = `${BASE_URL}/manga/one-punch-man/`;
  const SERIES_TITLE = "One Punch Man";
  const SERIES_SLUG = "one-punch-man";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MAX_HTML_BYTES = 8 * 1024 * 1024;
  const SERIES_CACHE_TTL_MS = 5 * 60 * 1000;
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
      mdash: "—",
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
        .replace(/<!--[\s\S]*?-->/g, " ")
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
    const match = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, "i"),
    );
    if (!match) return "";
    return decodeEntities((match[2] || match[3] || "").trim());
  }

  function isReadOPMHost(host) {
    const normalized = String(host || "").toLowerCase();
    return normalized === "readopm.com" || normalized.endsWith(".readopm.com");
  }

  function sourceURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      if (url.username || url.password || !isReadOPMHost(url.hostname)) return "";
      url.protocol = "https:";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function sourceAssetURL(value, base) {
    const normalized = sourceURL(value, base || BASE_URL);
    if (!normalized) return "";
    const url = new URL(normalized);
    if (!/\/wp-content\/uploads\//i.test(url.pathname)) return "";
    if (/keep-calm|logo|icon|sprite|favicon|placeholder|adservice/i.test(url.pathname)) return "";
    return normalized;
  }

  function readerImageURL(value, base) {
    const input = String(value || "").trim();
    if (!input || input.startsWith("data:")) return "";
    try {
      const url = new URL(input, base || SERIES_URL);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "cdn.readopm.com") return "";
      if (!/^\/file\//i.test(url.pathname)) return "";
      if (!/\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => (typeof value === "string" ? value : ""));
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return /<title[^>]*>\s*(just a moment|access denied|attention required)/i.test(page)
      || page.includes("cf-chl-")
      || page.includes("verify you are human")
      || page.includes("checking your browser");
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    const requestedURL = sourceURL(url, BASE_URL);
    if (!requestedURL) throw new Error(`${SERIES_TITLE} rejected an unsafe source URL.`);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(900 * (attempt - 1));
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
        if (isChallengePage(body)) {
          throw new Error(`${SERIES_TITLE} returned a challenge or access-denied page.`);
        }
        const finalURL = sourceURL(response.finalUrl || requestedURL, requestedURL);
        if (!finalURL) throw new Error(`${SERIES_TITLE} redirected outside its declared hosts.`);
        return { body, finalUrl: finalURL };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded|unsafe source|outside its declared/i.test(lastError.message)) {
          break;
        }
      }
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
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
      const property = attribute(tag, "property").toLowerCase();
      if (property !== "og:image" && property !== "twitter:image") continue;
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
      const property = attribute(tag, "property").toLowerCase();
      if (name === "description" || property === "og:description") {
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
    const text = String(query || "").trim().toLowerCase();
    if (!text || text.startsWith("__feed:")) return true;
    const haystack = `${SERIES_TITLE} ${SERIES_SLUG} opm onepunch one punch`.toLowerCase();
    return text.split(/\s+/).filter(Boolean).every((token) => token.length < 2 || haystack.includes(token));
  }

  function chapterURLParts(value, base = BASE_URL) {
    const url = sourceURL(value, base);
    if (!url) return null;
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/?$/, "/");
    const match = path.match(/^\/chapter\/one-punch-man-chapter-([0-9][0-9a-z.-]*)\/$/i);
    if (!match) return null;
    const initialNumber = match[1].match(/^\d+/)?.[0] || "";
    const number = Number(initialNumber);
    if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
    return {
      path,
      pathToken: match[1],
      pathNumber: number,
      url,
      canonicalURL: `${BASE_URL}${path}${parsed.search}`,
    };
  }

  function fallbackNumber(parts, rowText) {
    if (/bonus\s+chapter/i.test(rowText)) {
      const match = parts.pathToken.match(/^\d+-([0-9])(?:-|$)/);
      if (match) return Number(`${parts.pathNumber}.${match[1]}`);
    }
    return parts.pathNumber;
  }

  function chapterLabel(rowText, parts) {
    const clean = stripHTML(rowText);
    const match = clean.match(/\bchapter\s+([0-9]+(?:\.[0-9]+)?)/i);
    if (match) {
      const number = Number(match[1]);
      if (!Number.isFinite(number) || number < 0 || number > 10000) return null;
      let suffix = "";
      if (/new\s+revision/i.test(clean)) suffix = " (New Revision)";
      else if (/\brevised\b/i.test(clean)) suffix = " (Revised)";
      else if (/\bomake\b/i.test(clean)) suffix = " (Omake)";
      else if (/\bextra\b/i.test(clean)) suffix = " (Extra)";
      return { number, title: `${SERIES_TITLE} Chapter ${match[1].replace(/^0+(?=\d)/, "")}${suffix}` };
    }

    const number = fallbackNumber(parts, clean);
    if (!Number.isFinite(number)) return null;
    const bonus = clean.match(/bonus\s+chapter\s*:\s*([^,]+?)(?=\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}|\s+Read\b|$)/i);
    if (bonus) return { number, title: `${SERIES_TITLE} Bonus Chapter: ${bonus[1].trim()}` };
    return { number, title: `${SERIES_TITLE} Chapter ${number}` };
  }

  function parseChapterList(html, base) {
    const candidates = [];
    for (const match of String(html || "").matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const row = match[0];
      const anchor = row.match(/<a\b[^>]*href\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))[^>]*>/i);
      if (!anchor) continue;
      candidates.push({
        href: decodeEntities(anchor[2] || anchor[3] || ""),
        text: stripHTML(row),
      });
    }

    if (!candidates.length) {
      for (const match of String(html || "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
        const anchor = match[0];
        candidates.push({ href: attribute(anchor, "href"), text: stripHTML(anchor) });
      }
    }

    const chapters = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const parts = chapterURLParts(candidate.href, base || BASE_URL);
      if (!parts || seen.has(parts.canonicalURL)) continue;
      const label = chapterLabel(candidate.text, parts);
      if (!label) continue;
      chapters.push({
        id: parts.canonicalURL,
        href: parts.canonicalURL,
        url: parts.canonicalURL,
        title: label.title,
        number: label.number,
        language: "en",
      });
      seen.add(parts.canonicalURL);
    }

    chapters.sort((left, right) => {
      if (right.number !== left.number) return right.number - left.number;
      const titleOrder = left.title.localeCompare(right.title);
      return titleOrder || left.url.localeCompare(right.url);
    });
    return chapters;
  }

  function parseImages(html, pageURL) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const classes = attribute(tag, "class");
      if (!/(^|\s)pages__img(?:\s|$)/i.test(classes)) continue;
      const candidates = [
        attribute(tag, "data-src"),
        attribute(tag, "data-lazy-src"),
        attribute(tag, "data-original"),
        attribute(tag, "src"),
      ];
      let url = "";
      for (const candidate of candidates) {
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

  function isSeriesURL(id) {
    const url = sourceURL(id, BASE_URL);
    if (!url) return false;
    return new URL(url).pathname.replace(/\/{2,}/g, "/").replace(/\/?$/, "/") === "/manga/one-punch-man/";
  }

  async function loadSeries(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && seriesCache.value && now - seriesCache.fetchedAt < SERIES_CACHE_TTL_MS) {
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

  async function searchResults(query, page = 1) {
    if (Number(page) > 1 || !queryMatchesSeries(query)) return { items: [], hasMore: false };
    const series = await loadSeries(false);
    const item = seriesItem(parseCover(series.body, series.finalUrl || BASE_URL), parseDescription(series.body));
    return { items: [item], hasMore: false };
  }

  async function extractDetails(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    const series = await loadSeries(false);
    return {
      ...seriesItem(parseCover(series.body, series.finalUrl || BASE_URL), parseDescription(series.body)),
      status: "Ongoing",
      genres: ["Action", "Comedy", "Shounen", "Supernatural"],
    };
  }

  async function extractChapters(id) {
    if (!isSeriesURL(id)) throw new Error(`Invalid ${SERIES_TITLE} series identifier.`);
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(900 * (attempt - 1));
      const series = await loadSeries(attempt > 1);
      chapters = parseChapterList(series.body, series.finalUrl || BASE_URL);
    }
    if (!chapters.length) throw new Error(`${SERIES_TITLE} returned no owned chapter links.`);
    return chapters;
  }

  async function extractImages(id) {
    const chapter = chapterURLParts(id, BASE_URL);
    if (!chapter) throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    const page = await fetchHTML(chapter.canonicalURL, {
      headers: { Referer: chapter.canonicalURL },
      maxBytesHint: MAX_HTML_BYTES,
    });
    const pageURL = sourceURL(page.finalUrl || chapter.canonicalURL, chapter.canonicalURL) || chapter.canonicalURL;
    const pages = parseImages(page.body, pageURL);
    if (!pages.length) throw new Error(`${SERIES_TITLE} chapter returned no readable page images.`);
    return pages;
  }

  async function discoveryHome() {
    const search = await searchResults("__feed:popular", 1);
    return {
      sections: [
        { id: "popular", title: SERIES_TITLE, items: search.items },
        { id: "latest", title: "Latest", items: search.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    return searchResults(`__feed:${String(feedID || "popular").toLowerCase()}`, page);
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
