"use strict";

(() => {
  const BASE_URL = "https://xkcd.com";
  const SERIES_ID = `${BASE_URL}/`;
  const SERIES_TITLE = "xkcd";
  const SERIES_DESCRIPTION = "Daily stick-figure webcomic by Randall Munroe.";
  const ARCHIVE_URL = `${BASE_URL}/archive/`;
  const SEARCH_PAGE_SIZE = 10;
  const ARCHIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const DEFAULT_HEADERS = {
    Accept: "application/json",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;

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
      throw new Error("xkcd requires the fetchv2 bridge.");
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
        lastError = new Error(`xkcd request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("xkcd returned an empty response.");
    }
    throw lastError || new Error("xkcd request failed.");
  }

  async function fetchComicJSON(url) {
    const body = await fetchDirect(url, { maxBytesHint: 1024 * 1024 });
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("xkcd returned an unparseable comic response.");
    }
    if (!data || typeof data !== "object" || typeof data.num !== "number" || data.num < 1) {
      throw new Error("xkcd comic response is missing a valid comic number.");
    }
    return data;
  }

  function latestComic() {
    return fetchComicJSON(`${BASE_URL}/info.0.json`);
  }

  function seriesItem(latest) {
    return {
      id: SERIES_ID,
      href: SERIES_ID,
      title: SERIES_TITLE,
      image: typeof latest.img === "string" && latest.img.startsWith("https://") ? latest.img : "",
    };
  }

  function normalizedComicNumber(value) {
    const input = String(value || "").trim();
    const match = input.match(/^(?:https:\/\/xkcd\.com)?\/?(\d+)\/?$/i);
    if (match) return Number(match[1]);
    throw new Error("Invalid xkcd comic identifier.");
  }

  const archiveCache = { fetchedAt: 0, comics: [] };

  async function fetchTitleArchive() {
    const now = Date.now();
    if (archiveCache.comics.length && now - archiveCache.fetchedAt < ARCHIVE_CACHE_TTL_MS) {
      return archiveCache.comics;
    }
    const body = await fetchDirect(ARCHIVE_URL, {
      maxBytesHint: 4 * 1024 * 1024,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const comics = [];
    const linkPattern = /<a\s+href="\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(body))) {
      const num = Number(match[1]);
      const title = stripHTML(match[2]);
      if (num >= 1 && title) comics.push({ num, title });
    }
    if (!comics.length) {
      throw new Error("xkcd archive returned no comic links.");
    }
    archiveCache.comics = comics;
    archiveCache.fetchedAt = now;
    return comics;
  }

  function searchTokens(query) {
    const raw = typeof query === "string"
      ? query
      : String((query && (query.text || query.query)) || "");
    return raw
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  async function searchResults(query, page = 1) {
    const tokens = searchTokens(query);
    if (!tokens.length) return { items: [seriesItem(await latestComic())], hasMore: false };
    if (tokens[0] === "__feed:popular" || tokens[0] === "__feed:latest") {
      return { items: [seriesItem(await latestComic())], hasMore: false };
    }
    // The series name or a single character is too vague for title matching;
    // surface the series itself.
    if (tokens.includes(SERIES_TITLE.toLowerCase()) || (tokens.length === 1 && tokens[0].length <= 1)) {
      return { items: [seriesItem(await latestComic())], hasMore: false };
    }
    const comics = await fetchTitleArchive();
    const matches = [];
    for (const comic of comics) {
      const haystack = `${comic.num} ${comic.title}`.toLowerCase();
      if (tokens.every((token) => haystack.includes(token))) matches.push(comic);
    }
    const requestedPage = Math.max(1, Number(page) || 1);
    const start = (requestedPage - 1) * SEARCH_PAGE_SIZE;
    const items = matches.slice(start, start + SEARCH_PAGE_SIZE).map((comic) => ({
      id: `${BASE_URL}/${comic.num}/`,
      href: `${BASE_URL}/${comic.num}/`,
      url: `${BASE_URL}/${comic.num}/`,
      title: comic.title,
      number: comic.num,
    }));
    return { items, hasMore: start + SEARCH_PAGE_SIZE < matches.length };
  }

  async function extractDetails() {
    const latest = await latestComic();
    const alt = stripHTML(latest.alt || "");
    return {
      id: SERIES_ID,
      href: SERIES_ID,
      url: SERIES_ID,
      title: SERIES_TITLE,
      description: `${SERIES_DESCRIPTION} Latest comic #${latest.num} "${latest.safe_title || latest.title || ""}": ${alt}`,
      image: seriesItem(latest).image,
      authors: ["Randall Munroe"],
      author: "Randall Munroe",
      genres: ["Comedy"],
      status: "Ongoing",
    };
  }

  async function extractChapters() {
    const latest = await latestComic();
    const chapters = [];
    for (let number = latest.num; number >= 1; number -= 1) {
      const href = `${BASE_URL}/${number}/`;
      chapters.push({
        id: href,
        href,
        title: `#${number}`,
        number,
        language: "en",
      });
    }
    return chapters;
  }

  async function extractImages(chapterID) {
    const number = normalizedComicNumber(chapterID);
    const data = await fetchComicJSON(`${BASE_URL}/${number}/info.0.json`);
    const url = String(data.img || "").trim();
    if (!url.startsWith("https://")) {
      throw new Error(`xkcd comic #${number} did not provide an HTTPS image.`);
    }
    return [{
      url,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*",
        Referer: `${BASE_URL}/`,
      },
    }];
  }

  async function discoveryHome() {
    return {
      sections: [
        { id: "latest", title: "Latest", items: [seriesItem(await latestComic())] },
      ],
    };
  }

  async function discoveryFeed(feedID) {
    const feed = String(feedID || "").toLowerCase() === "popular" ? "popular" : "latest";
    return searchResults(`__feed:${feed}`);
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
