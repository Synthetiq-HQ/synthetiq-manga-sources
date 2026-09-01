"use strict";

(() => {
  // MangaBuddy currently redirects to Comizy. Keep the queue/source identity
  // as MangaBuddy, but use the current final host for stable requests.
  const BASE_URL = "https://comizy.io";
  const API_URL = "https://api.comizy.io";
  const PAGE_SIZE = 24;
  const MAX_ATTEMPTS = 3;
  const MAX_CHAPTERS = 5000;
  const MAX_PAGES = 1000;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const CACHE_TTL_MS = 300_000;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const API_HEADERS = {
    Accept: "application/json,text/plain,*/*",
    Referer: `${BASE_URL}/`,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: `${BASE_URL}/`,
  };

  const htmlCache = new Map();
  const htmlLoads = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function nonEmpty(value) {
    const text = String(value ?? "").trim();
    return text || "";
  }

  function isAdult(item) {
    const value = item && (item.is_adult ?? item.isAdult);
    return value === true || value === 1 || String(value).toLowerCase() === "true";
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.body === "string") return Promise.resolve(response.body);
    if (typeof response.text === "function") return response.text();
    return Promise.resolve("");
  }

  function parseJSON(value) {
    if (value && typeof value === "object") return value;
    const text = nonEmpty(value);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function challengeBody(value) {
    return /just a moment|cf-chl-|verify you are human|access denied|captcha/i.test(String(value || ""));
  }

  async function request(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("MangaBuddy requires the fetchv2 bridge.");
    }
    const method = options.method || "GET";
    const headers = options.kind === "json" ? API_HEADERS : DEFAULT_HEADERS;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...headers, ...(options.headers || {}) },
          method,
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || 16 * 1024 * 1024,
            responseClass: options.kind === "json" ? "json" : "html",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.error || response.ok === false || (status && (status < 200 || status >= 300))) {
          const message = response && response.error
            ? String(response.error)
            : `MangaBuddy request failed with HTTP ${status || "error"}.`;
          lastError = new Error(message);
          if (status && !RETRYABLE_STATUS.has(status)) throw lastError;
          continue;
        }
        if (response.bodyDropped) {
          throw new Error(`MangaBuddy response was dropped: ${response.dropReason || "size policy"}.`);
        }
        const body = await responseText(response);
        if (!body) throw new Error("MangaBuddy returned an empty response.");
        if (challengeBody(body)) throw new Error("MangaBuddy returned a challenge page.");
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_ATTEMPTS || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("MangaBuddy request failed.");
  }

  async function cachedHTML(url) {
    const cached = htmlCache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;
    const pending = htmlLoads.get(url);
    if (pending) return pending;

    const load = (async () => {
      const body = await request(url, { maxBytesHint: 16 * 1024 * 1024 });
      htmlCache.set(url, { at: Date.now(), body });
      if (htmlCache.size > 24) htmlCache.delete(htmlCache.keys().next().value);
      return body;
    })();
    htmlLoads.set(url, load);
    try {
      return await load;
    } finally {
      if (htmlLoads.get(url) === load) htmlLoads.delete(url);
    }
  }

  function canonicalPath(value, kind) {
    const raw = nonEmpty(value);
    if (!raw) throw new Error(`Invalid MangaBuddy ${kind} identifier.`);
    let url;
    try {
      url = new URL(raw, BASE_URL);
    } catch (_) {
      throw new Error(`Invalid MangaBuddy ${kind} identifier.`);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["comizy.io", "mangabuddy.com"].includes(host)) {
      throw new Error(`Invalid MangaBuddy ${kind} identifier.`);
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/" || path.includes("..")) {
      throw new Error(`Invalid MangaBuddy ${kind} identifier.`);
    }
    return path;
  }

  function titlePath(value) {
    const path = canonicalPath(value, "title");
    if (!/^\/[^/]+$/i.test(path) || /^\/(?:latest|ranking|search|genres|lists|auth|api|static)$/i.test(path)) {
      throw new Error("Invalid MangaBuddy title identifier.");
    }
    return path;
  }

  function chapterPath(value) {
    const path = canonicalPath(value, "chapter");
    if (!/^\/[^/]+\/[^/]+$/i.test(path)) throw new Error("Invalid MangaBuddy chapter identifier.");
    return path;
  }

  function sourceURL(path) {
    return `${BASE_URL}${path}`;
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function nextData(html) {
    const match = String(html || "").match(
      /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (!match) throw new Error("MangaBuddy page did not contain Next data.");
    const data = parseJSON(decodeEntities(match[1]));
    if (!data || !data.props || !data.props.pageProps) {
      throw new Error("MangaBuddy page returned invalid Next data.");
    }
    return data.props.pageProps;
  }

  function pageItems(pageProps) {
    const items = pageProps && (pageProps.items || pageProps.initialItems || pageProps.ssrItems);
    return Array.isArray(items) ? items : [];
  }

  function pagination(pageProps) {
    return pageProps && (pageProps.pagination || pageProps.initialPagination || pageProps.ssrPagination) || {};
  }

  function itemGenres(item) {
    return (Array.isArray(item && item.genres) ? item.genres : [])
      .map((genre) => nonEmpty(genre && (genre.name || genre.title) || genre))
      .filter(Boolean)
      .filter((genre, index, values) => values.indexOf(genre) === index);
  }

  function titleCard(item) {
    if (!item || isAdult(item)) return null;
    const path = nonEmpty(item.url || item.path);
    const title = nonEmpty(item.name || item.title);
    if (!title || !/^\/[^/]+$/i.test(path)) return null;
    const href = sourceURL(path);
    const result = {
      id: href,
      href,
      url: href,
      title,
      image: nonEmpty(item.cover || item.image),
    };
    const description = nonEmpty(item.summary || item.description);
    const status = nonEmpty(item.status);
    const genres = itemGenres(item);
    const chapterCount = Number(item.stats && item.stats.chapters_count);
    if (description) result.description = description;
    if (status) result.status = status;
    if (genres.length) result.genres = genres;
    if (Number.isFinite(chapterCount) && chapterCount >= 0) result.chapterCount = chapterCount;
    return result;
  }

  function titleCards(items, filters = {}) {
    const seen = new Set();
    const output = [];
    const includeTags = (filters.includeTags || []).map((tag) => String(tag).toLowerCase());
    const excludeTags = (filters.excludeTags || []).map((tag) => String(tag).toLowerCase());
    const status = nonEmpty(filters.status).toLowerCase();
    for (const item of Array.isArray(items) ? items : []) {
      const card = titleCard(item);
      if (!card || seen.has(card.id)) continue;
      const genres = (card.genres || []).map((genre) => genre.toLowerCase());
      if (includeTags.some((tag) => !genres.includes(tag))) continue;
      if (excludeTags.some((tag) => genres.includes(tag))) continue;
      if (status && String(card.status || "").toLowerCase() !== status) continue;
      seen.add(card.id);
      output.push(card);
    }
    return output;
  }

  function queryOptions(query) {
    if (!query || typeof query !== "object") return { text: nonEmpty(query) };
    return {
      text: nonEmpty(query.text || query.query),
      includeTags: Array.isArray(query.tags || query.includeTags) ? (query.tags || query.includeTags) : [],
      excludeTags: Array.isArray(query.excludeTags) ? query.excludeTags : [],
      status: nonEmpty(query.status),
    };
  }

  function apiPayload(value) {
    const parsed = parseJSON(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MangaBuddy API returned invalid JSON.");
    }
    const data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? parsed.data
      : parsed;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("MangaBuddy API returned an invalid data envelope.");
    }
    return data;
  }

  async function searchAPI(text, page, filters) {
    const params = new URLSearchParams({
      page: String(Math.max(1, Number(page) || 1)),
      limit: String(PAGE_SIZE),
      q: nonEmpty(text).slice(0, 200),
    });
    const data = apiPayload(await request(`${API_URL}/titles/search?${params.toString()}`, {
      kind: "json",
      maxBytesHint: 8 * 1024 * 1024,
    }));
    if (!Array.isArray(data.items)) throw new Error("MangaBuddy search response contained no item list.");
    const output = titleCards(data.items, filters);
    const pageInfo = data.pagination || {};
    return { items: output, hasMore: Boolean(pageInfo.has_next || pageInfo.hasNext) };
  }

  async function cataloguePage(feed, page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    const path = feed === "popular" ? "/ranking" : "/latest";
    const query = currentPage > 1 ? `?page=${currentPage}` : "";
    const props = nextData(await cachedHTML(`${BASE_URL}${path}${query}`));
    return {
      items: titleCards(pageItems(props)),
      hasMore: Boolean(pagination(props).has_next || pagination(props).hasNext),
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    return cataloguePage(/popular|trending|ranking/i.test(String(feedID || "")) ? "popular" : "latest", page);
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      cataloguePage("popular", 1),
      cataloguePage("latest", 1),
    ]);
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest", items: latest.items },
      ],
    };
  }

  async function searchResults(query, page = 1) {
    const options = queryOptions(query);
    if (/^__feed:/i.test(options.text)) {
      return discoveryFeed(options.text.slice("__feed:".length), page);
    }
    if (!options.text) return discoveryFeed("latest", page);
    return searchAPI(options.text, page, options);
  }

  async function loadTitle(value) {
    const path = titlePath(value);
    const url = sourceURL(path);
    const props = nextData(await cachedHTML(url));
    const manga = props.initialManga;
    if (!manga || typeof manga !== "object") throw new Error("MangaBuddy details did not contain a title.");
    if (isAdult(manga)) throw new Error("MangaBuddy marked this title as adult.");
    if (!nonEmpty(manga.name || manga.title)) throw new Error("MangaBuddy details did not contain a title.");
    return { path, url, manga };
  }

  function detailsObject(value) {
    const manga = value.manga;
    const authors = (Array.isArray(manga.authors) ? manga.authors : [])
      .map((author) => nonEmpty(author && (author.name || author.title) || author))
      .filter(Boolean)
      .filter((author, index, values) => values.indexOf(author) === index);
    const genres = itemGenres(manga);
    return {
      id: value.url,
      href: value.url,
      url: value.url,
      title: nonEmpty(manga.name || manga.title),
      description: nonEmpty(manga.summary || manga.description),
      image: nonEmpty(manga.cover || manga.image),
      authors,
      author: authors.join(", "),
      genres,
      status: nonEmpty(manga.status) || "Unknown",
    };
  }

  async function extractDetails(id) {
    return detailsObject(await loadTitle(id));
  }

  function chapterNumber(title) {
    const match = String(title || "").match(/(?:chapter|ch\.?)\s*#?\s*([0-9]+(?:\.[0-9]+)?)/i);
    return match ? Number(match[1]) : null;
  }

  function isRangeChapter(title) {
    return /(?:chapter|ch\.?)\s*#?\s*[0-9]+(?:\.[0-9]+)?\s*-\s*[0-9]+(?:\.[0-9]+)?/i.test(String(title || ""));
  }

  function normalizeChapters(value, titlePathValue) {
    const input = Array.isArray(value) ? value : value && (value.chapters || value.items);
    const prefix = `${titlePathValue.toLowerCase()}/`;
    const entries = [];
    const seen = new Set();
    for (let index = 0; index < (Array.isArray(input) ? input.length : 0); index += 1) {
      const item = input[index];
      if (!item || typeof item !== "object") continue;
      const rawPath = nonEmpty(item.url || item.href || item.path);
      if (!rawPath) continue;
      let path;
      try { path = chapterPath(rawPath); } catch (_) { continue; }
      if (!path.toLowerCase().startsWith(prefix) || seen.has(path)) continue;
      const title = nonEmpty(item.name || item.title) || "Chapter";
      const number = chapterNumber(title);
      entries.push({
        id: sourceURL(path),
        href: sourceURL(path),
        url: sourceURL(path),
        title,
        number: Number.isFinite(number) ? number : null,
        releaseDate: nonEmpty(item.updated_at || item.updatedAt || item.date) || null,
        language: "en",
        sourceIndex: index,
        range: isRangeChapter(title),
      });
      seen.add(path);
    }

    // Comizy/MangaBuddy carries occasional omnibus rows such as
    // "Chapter 1-7" alongside the individual chapters. They make a normal
    // chapter list look duplicated. Keep them only when they are the only
    // readable rows for a title.
    const withoutRanges = entries.filter((entry) => !entry.range);
    const selected = withoutRanges.length ? withoutRanges : entries;
    if (selected.length > MAX_CHAPTERS) throw new Error("MangaBuddy returned too many chapters.");
    selected.sort((left, right) => {
      if (left.number == null && right.number != null) return 1;
      if (left.number != null && right.number == null) return -1;
      if (left.number != null && right.number != null && left.number !== right.number) return right.number - left.number;
      return left.sourceIndex - right.sourceIndex;
    });
    return selected.map(({ sourceIndex, range, ...chapter }) => chapter);
  }

  async function extractChapters(id) {
    const title = await loadTitle(id);
    const cv = nonEmpty(title.manga.cv);
    if (!cv) throw new Error("MangaBuddy title did not provide a chapter version.");
    const data = apiPayload(await request(
      `${API_URL}/titles/${encodeURIComponent(nonEmpty(title.manga.id))}/chapters?cv=${encodeURIComponent(cv)}`,
      { kind: "json", maxBytesHint: 16 * 1024 * 1024 },
    ));
    const chapters = normalizeChapters(data.chapters || data.items, title.path);
    if (!chapters.length) throw new Error("MangaBuddy title returned no readable chapters.");
    return chapters;
  }

  function imageURL(value) {
    const raw = nonEmpty(value);
    if (!raw) return "";
    let url;
    try { url = new URL(raw); } catch (_) { return ""; }
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.cmzcdn\.org$/i.test(url.hostname)) return "";
    if (!/^\/e\//i.test(url.pathname)) return "";
    return url.toString();
  }

  function normalizeImages(value) {
    const input = Array.isArray(value) ? value : value && (value.pages || value.images);
    const output = [];
    const seen = new Set();
    for (const item of Array.isArray(input) ? input : []) {
      const raw = typeof item === "string" ? item : item && (item.url || item.src);
      const url = imageURL(raw);
      if (!url || seen.has(url)) continue;
      output.push({ url, headers: { ...IMAGE_HEADERS } });
      seen.add(url);
      if (output.length > MAX_PAGES) throw new Error("MangaBuddy chapter returned too many pages.");
    }
    if (!output.length) throw new Error("MangaBuddy chapter returned no readable page images.");
    return output;
  }

  async function extractImages(id) {
    const path = chapterPath(id);
    const props = nextData(await cachedHTML(sourceURL(path)));
    const chapter = props.initialChapter;
    if (!chapter || typeof chapter !== "object") throw new Error("MangaBuddy chapter did not contain reader data.");
    const pages = Array.isArray(chapter.pages) && chapter.pages.length ? chapter.pages : chapter.images;
    return normalizeImages(pages);
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
