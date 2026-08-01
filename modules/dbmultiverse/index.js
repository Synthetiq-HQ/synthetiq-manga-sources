"use strict";

(() => {
  const BASE_URL = "https://www.dragonball-multiverse.com";
  const HOME_URL = `${BASE_URL}/en/accueil.html`;
  const SERIES_TITLE = "Dragon Ball Multiverse";
  const SERIES_DESCRIPTION =
    "An online fan webcomic by Salagir: a multiverse tournament gathers the warriors of every Dragon Ball universe.";
  const SEARCH_TOKENS = new Set(["dragon", "ball", "dragonball", "multiverse", "dbm"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const LATEST_CACHE_TTL = 60_000;
  let latestCache = { at: 0, value: null };

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
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
    const match = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
    );
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
      const value = String(raw || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.body === "string") return response.body;
    if (typeof response.data === "string") return response.data;
    if (typeof response.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          headers,
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || null,
            responseClass: options.responseClass || "html",
          },
        );
      } catch (error) {
        // Bridge/network failures (timeouts, aborted sockets) are transient.
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response.status || 0);
      if (response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`${SERIES_TITLE} request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) {
        throw new Error(`${SERIES_TITLE} response was dropped: ${response.dropReason || "size policy"}.`);
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error(`${SERIES_TITLE} returned an empty response.`);
    }
    throw lastError || new Error(`${SERIES_TITLE} request failed.`);
  }

  function absoluteURL(value) {
    const input = String(value || "").trim().replace(/&amp;/g, "&");
    if (!input) return "";
    if (input.startsWith("https://")) return input.split("#")[0];
    if (input.startsWith("//")) return `https:${input}`.split("#")[0];
    if (input.startsWith("/")) return `${BASE_URL}${input}`.split("#")[0];
    return `${BASE_URL}/${input}`.split("#")[0];
  }

  function pageURL(number) {
    return `${BASE_URL}/en/page-${number}.html`;
  }

  function normalizedPageURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/\/en\/page-(\d+)\.html/i);
    if (match) return pageURL(Number(match[1]));
    if (/^\d+$/.test(input)) return pageURL(Number(input));
    throw new Error(`Invalid ${SERIES_TITLE} page identifier.`);
  }

  // Highest /en/page-<n>.html link on the news page is the latest comic page.
  function parseLatestPageNumber(html) {
    let latest = 0;
    for (const match of String(html || "").matchAll(/\/en\/page-(\d+)\.html/gi)) {
      const number = Number(match[1]);
      if (number > latest) latest = number;
    }
    return latest;
  }

  // The comic page image is the first content <img>: on regular pages it sits
  // inside #balloonsimg (alt="[DBM PAGE IMAGE]") served from /image.php; on
  // fan-art special pages (page-1000, page-2000, ...) the /imgs/pages_<n>/
  // gallery is the content. Anything else under /imgs/ (icons, avatars,
  // promos, favicon) is chrome and must be skipped.
  function parsePageImage(html) {
    const source = String(html || "");
    const balloons = source.match(/<div\b[^>]*id=(["'])balloonsimg\1[^>]*>([\s\S]*?)<\/div>/i)
      || source.match(/<div\b[^>]*id=(["'])balloonsimg\1[^>]*>([\s\S]*)/i);
    if (balloons) {
      const tag = balloons[2].match(/<img\b[^>]*>/i);
      const url = tag ? absoluteURL(attribute(tag[0], "src")) : "";
      if (url.startsWith("https://")) return url;
    }
    const marked = source.match(/<img\b(?=[^>]*alt=(["'])\[DBM PAGE IMAGE\]\1)[^>]*>/i);
    if (marked) {
      const url = absoluteURL(attribute(marked[0], "src"));
      if (url.startsWith("https://")) return url;
    }
    const pattern = /<img\b[^>]*>/gi;
    let match;
    let fallback = "";
    while ((match = pattern.exec(source)) !== null) {
      const url = absoluteURL(attribute(match[0], "src"));
      if (!url.startsWith("https://") || !url.includes("/imgs/")) continue;
      if (/\/imgs\/pages/i.test(url)) return url;
      if (!fallback && !/favicon|\/imgs\/ico\/|\/imgs\/avatars\/|\/imgs\/promos\//i.test(url)) {
        fallback = url;
      }
    }
    return fallback;
  }

  async function latestInfo(forceRefresh = false) {
    if (!forceRefresh && latestCache.value && Date.now() - latestCache.at < LATEST_CACHE_TTL) {
      return latestCache.value;
    }
    const home = await fetchDirect(HOME_URL, { maxBytesHint: 2 * 1024 * 1024 });
    const number = parseLatestPageNumber(home);
    if (!number) {
      throw new Error(`${SERIES_TITLE} news page listed no comic pages.`);
    }
    const page = await fetchDirect(pageURL(number), { maxBytesHint: 2 * 1024 * 1024 });
    const image = parsePageImage(page);
    if (!image) {
      throw new Error(`${SERIES_TITLE} latest page exposed no readable image.`);
    }
    const value = { number, image };
    latestCache = { at: Date.now(), value };
    return value;
  }

  function seriesItem(image) {
    return {
      id: HOME_URL,
      href: HOME_URL,
      title: SERIES_TITLE,
      image,
    };
  }

  function matchesQuery(query) {
    let raw = typeof query === "string" ? query : String(query?.text || query?.query || "");
    raw = raw.trim().toLowerCase();
    if (!raw || raw === "__feed:popular" || raw === "__feed:latest") return true;
    const tokens = raw.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => SEARCH_TOKENS.has(token));
  }

  async function searchResults(query, page = 1) {
    if (Number(page) > 1 || !matchesQuery(query)) {
      return { items: [], hasMore: false };
    }
    const latest = await latestInfo();
    return { items: [seriesItem(latest.image)], hasMore: false };
  }

  async function extractDetails(id) {
    const latest = await latestInfo();
    return {
      id: HOME_URL,
      href: HOME_URL,
      url: HOME_URL,
      title: SERIES_TITLE,
      description: SERIES_DESCRIPTION,
      image: latest.image,
      authors: ["Salagir"],
      author: "Salagir",
      genres: [],
      status: "Ongoing",
    };
  }

  async function extractChapters(id) {
    const home = await fetchDirect(HOME_URL, { maxBytesHint: 2 * 1024 * 1024 });
    const latest = parseLatestPageNumber(home);
    if (!latest) {
      throw new Error(`${SERIES_TITLE} news page listed no comic pages.`);
    }
    const chapters = [];
    for (let number = latest; number >= 1; number -= 1) {
      const href = pageURL(number);
      chapters.push({
        id: href,
        href,
        url: href,
        title: `Page ${number}`,
        number,
        language: "en",
      });
    }
    return chapters;
  }

  async function extractImages(id) {
    const url = normalizedPageURL(id);
    const html = await fetchDirect(url, { maxBytesHint: 2 * 1024 * 1024 });
    const image = parsePageImage(html);
    if (!image) {
      throw new Error(`${SERIES_TITLE} page returned no readable page image.`);
    }
    return [{
      url: image,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*",
        Referer: `${BASE_URL}/`,
      },
    }];
  }

  async function discoveryHome() {
    const latest = await latestInfo();
    return {
      sections: [
        { id: "latest", title: "Latest", items: [seriesItem(latest.image)] },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "popular" ? "popular" : "latest";
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
