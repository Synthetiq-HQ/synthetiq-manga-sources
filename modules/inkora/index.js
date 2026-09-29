"use strict";

(() => {
  // Inkora — English manga & manhwa catalogue served by the spacely.tech
  // reading platform. The site front-end (inkora.spacely.tech) is a Next.js
  // shell; every catalogue request the app makes goes to the platform's
  // public JSON API on api.spacely.tech:
  //   /manhwa/inkora/search            free-text search
  //   /manhwa/inkora/advanced-search   browse + discovery feeds (sort param)
  //   /manhwa/index/info/<id>          details + the site's own chapter list
  //   /manhwa/index/read/<chapterId>   ordered page images
  // Chapter identifiers are the platform's own chapter ids (mb-…/mk-…/ks-…
  // prefixes); reader pages are served through the platform image proxy, so
  // no reader-side CDN hosts are contacted directly.
  const API_URL = "https://api.spacely.tech";
  const WEBSITE_URL = "https://inkora.spacely.tech";
  const SEARCH_PATH = "/manhwa/inkora/search";
  const ADVANCED_PATH = "/manhwa/inkora/advanced-search";
  const INFO_PATH = "/manhwa/index/info";
  const READ_PATH = "/manhwa/index/read";
  const FEED_SECTIONS = [
    { id: "popular", title: "Popular", sort: "views_7d" },
    { id: "latest", title: "Recently Updated", sort: "latest" },
  ];
  const PAGE_SIZE = 30;
  const LIST_BYTE_HINT = 4 * 1024 * 1024;
  const DETAILS_BYTE_HINT = 16 * 1024 * 1024;
  const READ_BYTE_HINT = 2 * 1024 * 1024;
  const MIN_SEARCH_LENGTH = 3;
  const MAX_CHAPTERS = 2000;
  const DEFAULT_HEADERS = {
    Accept: "application/json",
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const SERIES_ID_PATTERN = /^al-[a-z0-9][a-z0-9-]{1,48}$/i;
  const SERIES_URL_PATTERN = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*spacely\.tech\/manhwa\/(al-[a-z0-9-]+)(?:[/?#].*)?$/i;
  const CHAPTER_ID_PATTERN = /^[a-z]{2,8}-[A-Za-z0-9][A-Za-z0-9-]{2,170}$/;
  const CHAPTER_URL_PATTERN = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*spacely\.tech\/manhwa\/al-[a-z0-9-]+\/read\/([a-z]{2,8}-[A-Za-z0-9][A-Za-z0-9-]{2,170})(?:[/?#].*)?$/i;

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

  function nonEmpty(value) {
    const text = String(value == null ? "" : value).trim();
    return text;
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
      throw new Error("Inkora requires the fetchv2 bridge.");
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
            responseClass: "json",
          },
        );
      } catch (error) {
        // Bridge/network failures (timeouts, aborted sockets) are transient.
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      const status = Number(response.status || 0);
      if (response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Inkora request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("Inkora returned an empty response.");
    }
    throw lastError || new Error("Inkora request failed.");
  }

  async function fetchJSON(url, maxBytesHint) {
    const body = await fetchDirect(url, { maxBytesHint: maxBytesHint || LIST_BYTE_HINT });
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("Inkora returned an unparseable JSON response.");
    }
    if (!data || typeof data !== "object") {
      throw new Error("Inkora returned an unexpected JSON payload.");
    }
    return data;
  }

  function buildParams(pairs) {
    const parts = [];
    for (const pair of pairs) {
      if (!Array.isArray(pair)) continue;
      const key = pair[0];
      const value = pair[1];
      if (key === undefined || key === null || value === null || value === undefined || value === "") continue;
      parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
    return parts.join("&");
  }

  function httpHost(value) {
    const match = String(value || "").match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i);
    return match ? match[1].toLowerCase() : "";
  }

  function httpPath(value) {
    const match = String(value || "").match(/^https:\/\/[^/?#]+(\/[^?#]*)?/i);
    return match && match[1] ? match[1] : "";
  }

  function isAllowedImageHost(value) {
    const host = httpHost(value);
    return host === "s4.anilist.co" || host === "api.spacely.tech";
  }

  function imageURL(value) {
    const raw = nonEmpty(value);
    if (!raw || !/^https:\/\//i.test(raw) || !isAllowedImageHost(raw)) return "";
    return raw;
  }

  function isAllowedPageImage(value) {
    const host = httpHost(value);
    if (host !== "api.spacely.tech") return false;
    return httpPath(value).startsWith("/manhwa/");
  }

  function normalizeSeriesID(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) throw new Error("Invalid Inkora series identifier.");
    if (/^https?:\/\//i.test(raw)) {
      const match = raw.match(SERIES_URL_PATTERN);
      if (!match) throw new Error("Invalid Inkora series identifier.");
      return match[1].toLowerCase();
    }
    if (!SERIES_ID_PATTERN.test(raw)) {
      throw new Error("Invalid Inkora series identifier.");
    }
    return raw.toLowerCase();
  }

  function normalizeChapterID(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) throw new Error("Invalid Inkora chapter identifier.");
    if (/^https?:\/\//i.test(raw)) {
      const match = raw.match(CHAPTER_URL_PATTERN);
      if (!match) throw new Error("Invalid Inkora chapter identifier.");
      return match[1];
    }
    if (!CHAPTER_ID_PATTERN.test(raw)) {
      throw new Error("Invalid Inkora chapter identifier.");
    }
    return raw;
  }

  function searchQuery(input) {
    if (typeof input === "string") return input.trim();
    if (input && typeof input === "object") {
      return String(input.text || input.query || "").trim();
    }
    return "";
  }

  function genreLabel(value) {
    const raw = nonEmpty(value);
    if (!raw) return "";
    return raw
      .replace(/_/g, " ")
      .split(/\s+/)
      .map((word) => word.split("-").map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join("-"))
      .join(" ")
      .trim();
  }

  function genreNames(values) {
    const list = Array.isArray(values) ? values : [];
    const names = [];
    const seen = new Set();
    for (const value of list) {
      const raw = nonEmpty(value);
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(genreLabel(raw));
    }
    return names;
  }

  function statusLabel(raw) {
    const value = nonEmpty(raw);
    if (!value) return "";
    const mapped = {
      ongoing: "Ongoing",
      completed: "Completed",
      hiatus: "Hiatus",
      cancelled: "Cancelled",
      canceled: "Cancelled",
    };
    return mapped[value.toLowerCase()] || value.charAt(0).toUpperCase() + value.slice(1);
  }

  function resultSummary(item) {
    const id = nonEmpty(item && item.id);
    if (!SERIES_ID_PATTERN.test(id)) return null;
    const href = `${WEBSITE_URL}/manhwa/${id}`;
    return {
      id,
      href,
      url: href,
      title: nonEmpty(item.title) || "Inkora title",
      image: imageURL(item.image),
    };
  }

  function summarizeResults(payload) {
    const results = Array.isArray(payload.results) ? payload.results : [];
    const items = [];
    for (const result of results) {
      const summary = resultSummary(result);
      if (summary) items.push(summary);
    }
    return { items, hasMore: payload.hasNextPage === true };
  }

  async function searchResults(query, page = 1) {
    const text = searchQuery(query);
    const pageNumber = Math.max(1, Number(page) || 1);
    if (/^__feed:/i.test(text)) {
      return discoveryFeed(text.slice("__feed:".length), pageNumber);
    }
    if (text && text.length < MIN_SEARCH_LENGTH) {
      // The platform answers short queries with an empty envelope; resolve
      // them locally instead of spending a request.
      return { items: [], hasMore: false };
    }
    const pairs = text
      ? [["q", text], ["page", pageNumber], ["per_page", PAGE_SIZE]]
      : [["page", pageNumber], ["per_page", PAGE_SIZE], ["sort", FEED_SECTIONS[0].sort], ["order", "desc"]];
    const path = text ? SEARCH_PATH : ADVANCED_PATH;
    const payload = await fetchJSON(`${API_URL}${path}?${buildParams(pairs)}`, LIST_BYTE_HINT);
    return summarizeResults(payload);
  }

  async function fetchInfo(seriesID) {
    const id = normalizeSeriesID(seriesID);
    const payload = await fetchJSON(
      `${API_URL}${INFO_PATH}/${encodeURIComponent(id)}`,
      DETAILS_BYTE_HINT,
    );
    if (nonEmpty(payload.id).toLowerCase() !== id) {
      throw new Error("Inkora returned details for a different title.");
    }
    return payload;
  }

  async function extractDetails(seriesID) {
    const payload = await fetchInfo(seriesID);
    const id = normalizeSeriesID(payload.id);
    const href = `${WEBSITE_URL}/manhwa/${id}`;
    const authors = [];
    const seenAuthors = new Set();
    for (const value of [].concat(payload.authors || [], payload.artists || [])) {
      const name = nonEmpty(value);
      const key = name.toLowerCase();
      if (!name || seenAuthors.has(key)) continue;
      seenAuthors.add(key);
      authors.push(name);
    }
    return {
      id,
      href,
      url: href,
      title: nonEmpty(payload.title) || "Inkora title",
      description: stripHTML(payload.description || payload.synopsis || ""),
      image: imageURL(payload.image),
      authors,
      author: authors[0] || "",
      genres: genreNames(payload.genres),
      status: statusLabel(payload.status),
    };
  }

  async function extractChapters(seriesID) {
    const payload = await fetchInfo(seriesID);
    const id = normalizeSeriesID(payload.id);
    const raw = Array.isArray(payload.chapters) ? payload.chapters : [];
    if (raw.length > MAX_CHAPTERS) {
      throw new Error("Inkora returned too many chapters.");
    }
    const seen = new Set();
    const output = [];
    for (let index = 0; index < raw.length; index += 1) {
      const chapter = raw[index] || {};
      const chapterID = nonEmpty(chapter.id);
      if (!chapterID || !CHAPTER_ID_PATTERN.test(chapterID) || seen.has(chapterID)) continue;
      seen.add(chapterID);
      const parsedNumber = Number(chapter.chapterNumber);
      const number = chapter.chapterNumber == null || !Number.isFinite(parsedNumber) ? null : parsedNumber;
      const readerURL = `${WEBSITE_URL}/manhwa/${id}/read/${chapterID}`;
      output.push({
        id: chapterID,
        href: readerURL,
        url: readerURL,
        title: nonEmpty(chapter.title) || (number !== null ? `Chapter ${number}` : "Chapter"),
        number,
        releaseDate: nonEmpty(chapter.releaseDate) || null,
        language: "en",
        _order: index,
      });
    }
    if (!output.length) {
      throw new Error("Inkora returned no chapters for this title.");
    }
    output.sort((left, right) => {
      if (left.number === null && right.number !== null) return 1;
      if (left.number !== null && right.number === null) return -1;
      if (left.number !== null && right.number !== null && left.number !== right.number) {
        return right.number - left.number;
      }
      return left._order - right._order;
    });
    return output.map(({ _order, ...chapter }) => chapter);
  }

  async function extractImages(chapterID) {
    const id = normalizeChapterID(chapterID);
    const payload = await fetchJSON(
      `${API_URL}${READ_PATH}/${encodeURIComponent(id)}`,
      READ_BYTE_HINT,
    );
    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    const ordered = pages
      .slice()
      .sort((left, right) => Number(left && left.page || 0) - Number(right && right.page || 0));
    const output = [];
    for (const page of ordered) {
      const url = nonEmpty(page && page.img);
      if (!url || !isAllowedPageImage(url)) continue;
      output.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
        },
      });
    }
    if (!output.length) {
      if (pages.length) {
        throw new Error("Inkora returned an unexpected chapter image host.");
      }
      throw new Error("Inkora returned no readable page images for this chapter.");
    }
    return output;
  }

  async function discoveryFeed(feedID, page = 1) {
    const id = nonEmpty(feedID).toLowerCase();
    const section = FEED_SECTIONS.find((candidate) => candidate.id === id);
    if (!section) return { items: [], hasMore: false };
    const pageNumber = Math.max(1, Number(page) || 1);
    const pairs = [
      ["page", pageNumber],
      ["per_page", PAGE_SIZE],
      ["sort", section.sort],
      ["order", "desc"],
    ];
    const payload = await fetchJSON(`${API_URL}${ADVANCED_PATH}?${buildParams(pairs)}`, LIST_BYTE_HINT);
    return summarizeResults(payload);
  }

  async function discoveryHome() {
    const sections = [];
    for (const section of FEED_SECTIONS) {
      const { items } = await discoveryFeed(section.id, 1);
      sections.push({ id: section.id, title: section.title, items });
    }
    return { sections };
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
