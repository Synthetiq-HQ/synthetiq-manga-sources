"use strict";

(() => {
  const BASE_URL = "https://mangaxo.com";
  const BASE_HOST = "mangaxo.com";
  const IMAGE_HOSTS = new Set(["img.mangaxo.com", "img1.mangaxo.com", "img2.mangaxo.com"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/home`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const RESPONSE_CACHE_TTL_MS = 30_000;
  const MAX_CHAPTERS = 10_000;
  const MAX_IMAGES = 2_000;
  const SEARCH_PAGE_SIZE = 16;
  const responseCache = new Map();
  const searchPageCache = new Map();
  const chapterCache = new Map();
  const chapterLoads = new Map();
  const chapterRecords = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }

  function uniqueStrings(values) {
    const output = [];
    const seen = new Set();
    for (const value of values) {
      const normalized = String(value ?? "").trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }
    return output;
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u0027/gi, "'")
      .replace(/\\u003d/gi, "=")
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
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

  function metaContent(html, key) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      const name = attribute(tag, "property") || attribute(tag, "name");
      if (name.toLowerCase() === String(key).toLowerCase()) return attribute(tag, "content");
    }
    return "";
  }

  function sourceURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) throw new Error("MangaXo identifier is empty.");
    let parsed;
    try {
      parsed = new URL(raw, BASE_URL);
    } catch {
      throw new Error("Invalid MangaXo URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== BASE_HOST) {
      throw new Error("MangaXo URL is outside the source host.");
    }
    return parsed;
  }

  function mangaReference(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(/^\/manga\/([^\/?#]+)\/?$/i);
    if (!match) throw new Error("Invalid MangaXo manga identifier.");
    let slug;
    try {
      slug = decodeURIComponent(match[1]).toLowerCase();
    } catch {
      throw new Error("Invalid MangaXo manga identifier.");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug)) throw new Error("Invalid MangaXo manga identifier.");
    return { slug, href: `${BASE_URL}/manga/${slug}` };
  }

  function chapterReference(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(/^\/manga\/([^\/?#]+)\/chapter-([0-9]{1,8}(?:\.[0-9]{1,6})?)\/?$/i);
    if (!match) throw new Error("Invalid MangaXo chapter identifier.");
    const slug = match[1].toLowerCase();
    const token = match[2];
    const number = Number(token);
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug) || !Number.isFinite(number)) {
      throw new Error("Invalid MangaXo chapter identifier.");
    }
    const href = `${BASE_URL}/manga/${slug}/chapter-${token}`;
    return { slug, token, number, href, key: href.toLowerCase() };
  }

  function isChallenge(body) {
    return /<title[^>]*>[\s\S]{0,200}?(?:just a moment|attention required)[\s\S]{0,200}?<\/title>|cf-chl-|cf-error|verify you are human|enable javascript and cookies|access denied/i.test(
      String(body || ""),
    );
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    if (typeof response.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  function cachedResponse(key) {
    const entry = responseCache.get(key);
    if (!entry || Date.now() - entry.storedAt >= RESPONSE_CACHE_TTL_MS) {
      responseCache.delete(key);
      return "";
    }
    return entry.body;
  }

  function cacheResponse(key, body) {
    responseCache.set(key, { storedAt: Date.now(), body });
    while (responseCache.size > 64) responseCache.delete(responseCache.keys().next().value);
  }

  function searchCacheKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function uniqueSearchPageItems(cacheKey, page, rawItems) {
    let pages = searchPageCache.get(cacheKey);
    if (!pages) {
      pages = new Map();
      searchPageCache.set(cacheKey, pages);
    }
    pages.set(page, rawItems);
    while (searchPageCache.size > 32) searchPageCache.delete(searchPageCache.keys().next().value);

    const priorIDs = new Set();
    for (const [pageNumber, pageItems] of pages) {
      if (pageNumber >= page) continue;
      for (const item of pageItems) priorIDs.add(String(item.id || item.href || item.url));
    }
    return rawItems.filter((item) => !priorIDs.has(String(item.id || item.href || item.url)));
  }

  async function request(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("MangaXo requires the fetchv2 bridge.");
    const requestURL = String(url);
    const cacheKey = `${options.responseClass || "html"}:${requestURL}`;
    if (options.cacheable !== false) {
      const cached = cachedResponse(cacheKey);
      if (cached) return cached;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(650 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || 8 * 1024 * 1024,
            responseClass: options.responseClass || "html",
          },
        );
        const status = Number(response?.status || 0);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`MangaXo request failed with HTTP ${status || "error"}.`);
          if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) continue;
          throw lastError;
        }
        if (response.bodyDropped) throw new Error("MangaXo response exceeded the app size limit.");
        const body = await responseText(response);
        if (!body) throw new Error("MangaXo returned an empty response.");
        if (isChallenge(body)) throw new Error("MangaXo returned a browser challenge instead of source data.");
        if (options.cacheable !== false) cacheResponse(cacheKey, body);
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          attempt >= MAX_ATTEMPTS
          || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)
        ) throw lastError;
      }
    }
    throw lastError || new Error("MangaXo request failed.");
  }

  async function requestJSON(url, options = {}) {
    const body = await request(url, { ...options, responseClass: "json" });
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("MangaXo returned invalid JSON.");
    }
    if (!payload || typeof payload !== "object") throw new Error("MangaXo returned an invalid JSON payload.");
    return payload;
  }

  function safeCoverURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase();
    const wpCover = host === "i2.wp.com"
      && /^\/mangaxo\.com\/manga\/images\/[a-z0-9_.-]+\.(?:jpe?g|png|webp)$/i.test(parsed.pathname);
    const sourceCover = host === BASE_HOST
      && /^\/(?:manga\/images\/[a-z0-9_.-]+\.(?:jpe?g|png|webp)|assets\/images\/placeholder-cover\.png)$/i.test(parsed.pathname);
    return wpCover || sourceCover ? parsed.toString() : "";
  }

  function safeImageURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:" || !IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
    if (!/^\/wp-content\/uploads\/WP-manga\/data\/manga_[a-z0-9]+\/[a-z0-9]+\/[a-z0-9][a-z0-9_.-]*\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)) return "";
    const queryKeys = [...parsed.searchParams.keys()];
    if (queryKeys.length && !(queryKeys.length === 1 && parsed.searchParams.get("domain") === "www.mangaread.org")) return "";
    return parsed.toString();
  }

  function parsePosterCards(html) {
    const source = String(html || "");
    const posterMatches = [...source.matchAll(/<a\b[^>]*class=(['"])[^'\"]*\bmanga-poster\b[^'\"]*\1[^>]*>/gi)];
    const items = [];
    const seen = new Set();
    for (let index = 0; index < posterMatches.length; index += 1) {
      const poster = posterMatches[index];
      const nextStart = posterMatches[index + 1]?.index ?? source.length;
      const card = source.slice(poster.index, nextStart);
      let manga;
      try {
        manga = mangaReference(attribute(poster[0], "href"));
      } catch {
        continue;
      }
      if (seen.has(manga.href)) continue;
      const imageTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
      const title = stripHTML(
        card.match(/<h3\b[^>]*class=(['"])[^'\"]*\bmanga-name\b[^'\"]*\1[^>]*>([\s\S]*?)<\/h3>/i)?.[2]
          || attribute(imageTag, "alt")
          || card.match(/<a\b[^>]*title=(['"])([\s\S]*?)\1/i)?.[2]
          || "",
      );
      if (!title) continue;
      const image = safeCoverURL(attribute(imageTag, "data-src") || attribute(imageTag, "src"));
      const item = { id: manga.href, href: manga.href, title };
      if (image) item.image = image;
      const chapterCount = card.match(/(?:All|over)\s+([0-9][0-9,]*)\s+chapters?/i)?.[1];
      if (chapterCount) item.chapterCount = Number(chapterCount.replace(/,/g, ""));
      seen.add(manga.href);
      items.push(item);
    }
    return items;
  }

  function hasNextSearchPage(html, page, itemCount = 0) {
    const currentPage = Math.max(1, Number(page) || 1);
    for (const match of String(html || "").matchAll(/<a\b[^>]*href=(['"])([^'\"]+)\1[^>]*>/gi)) {
      let parsed;
      try { parsed = sourceURL(match[2]); } catch { continue; }
      if (parsed.pathname !== "/search") continue;
      const nextPage = Number(parsed.searchParams.get("page"));
      if (Number.isInteger(nextPage) && nextPage > currentPage) return true;
    }
    // MangaXo occasionally serves a full result page without its pagination
    // controls. A full page is still a safe signal to let the app request the
    // next page; an empty next page will stop pagination at the caller.
    return Number(itemCount) >= SEARCH_PAGE_SIZE;
  }

  function jsonLDObjects(html) {
    const objects = [];
    for (const match of String(html || "").matchAll(/<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(match[2].trim());
        if (Array.isArray(parsed)) objects.push(...parsed);
        else objects.push(parsed);
      } catch {
        continue;
      }
    }
    return objects;
  }

 function parseDetailsHTML(html, href) {
   const source = String(html || "");
    const structuredObjects = jsonLDObjects(source);
    const structured = structuredObjects.find((value) => {
      const type = Array.isArray(value?.["@type"]) ? value["@type"] : [value?.["@type"]];
      return value && typeof value === "object" && value.name && type.some((entry) => /comicseries|book|creativework/i.test(String(entry || "")));
    }) || structuredObjects.find((value) => value && typeof value === "object" && value.name) || {};
    const title = stripHTML(
      source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        || structured.name
        || metaContent(source, "og:title"),
    );
    if (!title) throw new Error("MangaXo details did not contain a title.");
    const descriptions = [...source.matchAll(/<div\b[^>]*class=(['"])[^'\"]*\bdescription\b[^'\"]*\1[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) => stripHTML(match[2]))
      .filter((value) => value && !/^what do you think about this manga\??$/i.test(value));
    const description = descriptions[0]
      || stripHTML(structured.description || metaContent(source, "description") || metaContent(source, "og:description"));
    const genresBlock = source.match(/<div\b[^>]*class=(['"])[^'\"]*\bgenres\b[^'\"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2] || "";
    const genres = uniqueStrings([...genresBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => stripHTML(match[1])));
    const structuredGenres = Array.isArray(structured.genre) ? structured.genre : [structured.genre];
    genres.push(...uniqueStrings(structuredGenres.map((value) => stripHTML(value))));
    const authorValues = [];
   const structuredAuthor = structured.author;
   if (typeof structuredAuthor === "string") authorValues.push(structuredAuthor);
   else if (structuredAuthor?.name) authorValues.push(structuredAuthor.name);
    const visibleSource = source.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
    const authorContext = visibleSource.match(/(?:Author|Artist)\s*:?[\s\S]{0,300}/i)?.[0] || "";
    const authorText = stripHTML(authorContext).replace(/^(?:Author|Artist)\s*:?\s*/i, "");
    if (authorText && authorText.length < 200) authorValues.push(authorText);
    const authors = uniqueStrings(authorValues);
    const status = (metaContent(source, "description") || metaContent(source, "og:description"))
      .match(/\b(ongoing|completed|hiatus|dropped|cancelled|canceled)\b/i)?.[1] || "Unknown";
    const image = safeCoverURL(
      structured.image
        || metaContent(source, "og:image")
        || metaContent(source, "twitter:image"),
    );
    const chapterCount = (metaContent(source, "og:title") || source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .match(/All\s+([0-9][0-9,]*)\s+chapters?/i)?.[1];
    const result = {
      id: href,
      href,
      url: href,
      title,
      description,
      author: authors.join(", "),
      authors,
      genres: uniqueStrings(genres),
      status,
    };
    if (image) result.image = image;
    if (chapterCount) result.chapterCount = Number(chapterCount.replace(/,/g, ""));
    return result;
  }

  function mangaID(html) {
    const match = String(html || "").match(/data-manga-id=(['"])([0-9]{1,12})\1/i);
    if (!match) throw new Error("MangaXo manga page did not contain a source ID.");
    return match[2];
  }

  function readingListHTML(payload) {
    if (!payload || payload.status === false) throw new Error("MangaXo returned no chapter list.");
    if (typeof payload.html !== "string" || !payload.html.trim()) throw new Error("MangaXo returned an empty chapter list.");
    return payload.html;
  }

  function rowAttribute(openingTag, name) {
    return attribute(openingTag, name);
  }

  function parseChapters(html, manga) {
    const source = String(html || "");
    const section = source.match(/<ul\b[^>]*id=(['"])en-chapters\1[^>]*>([\s\S]*?)<\/ul>/i)?.[2] || "";
    const records = new Map();
    for (const match of section.matchAll(/<li\b[^>]*data-id=(['"])([0-9]{1,12})\1[^>]*>[\s\S]*?<\/li>/gi)) {
      const block = match[0];
      const openingTag = block.match(/<li\b[^>]*>/i)?.[0] || "";
      const readingId = rowAttribute(openingTag, "data-id");
      const rawNumber = rowAttribute(openingTag, "data-number");
      const number = Number(rawNumber);
      if (!readingId || !Number.isFinite(number)) continue;
      const linkTag = block.match(/<a\b[^>]*class=(['"])[^'\"]*\bitem-link\b[^'\"]*\1[^>]*>/i)?.[0]
        || block.match(/<a\b[^>]*href=(['"])[^'\"]+\1[^>]*>/i)?.[0]
        || "";
      const rawHref = attribute(linkTag, "href");
      let chapter;
      try { chapter = chapterReference(rawHref); } catch { continue; }
      if (chapter.slug !== manga.slug) continue;
      const sourceTitle = attribute(linkTag, "data-shortname") || attribute(linkTag, "title");
      const title = stripHTML(sourceTitle || block.match(/<span\b[^>]*class=(['"])[^'\"]*\bname\b[^'\"]*\1[^>]*>([\s\S]*?)<\/span>/i)?.[2] || `Chapter ${chapter.token}`)
        || `Chapter ${chapter.token}`;
      const record = {
        id: chapter.href,
        href: chapter.href,
        url: chapter.href,
        title,
        number,
        language: "en",
      };
      const previous = records.get(chapter.key);
      if (!previous || previous.title === `Chapter ${chapter.token}`) {
        records.set(chapter.key, record);
        chapterRecords.set(chapter.key, { ...chapter, readingId, mangaID: manga.sourceID });
      }
      if (records.size >= MAX_CHAPTERS) break;
    }
    const output = [...records.values()];
    output.sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
    return output;
  }

  function parseImageList(html, chapterHref) {
    const pages = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<div\b[^>]*class=(['"])[^'\"]*\biv-card\b[^'\"]*\1[^>]*>/gi)) {
      const rawURL = attribute(match[0], "data-url");
      const pageURL = safeImageURL(rawURL);
      if (!pageURL || seen.has(pageURL)) throw new Error("MangaXo returned an invalid or duplicate page manifest.");
      seen.add(pageURL);
      pages.push({
        url: pageURL,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
          Referer: chapterHref,
        },
      });
      if (pages.length > MAX_IMAGES) throw new Error("MangaXo returned too many page images.");
    }
    if (!pages.length) throw new Error("MangaXo chapter returned no readable page images.");
    return pages;
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    const currentPage = Math.max(1, Number(page) || 1);
    const url = !text || text === "*" || text.startsWith("__feed:")
      ? `${BASE_URL}/home`
      : `${BASE_URL}/search?keyword=${encodeURIComponent(text.slice(0, 160))}${currentPage > 1 ? `&page=${currentPage}` : ""}`;
    const html = await request(url, { maxBytesHint: 8 * 1024 * 1024 });
    const rawItems = parsePosterCards(html);
    if (!rawItems.length) throw new Error("MangaXo returned no manga results.");
    const isFeed = !text || text === "*" || text.startsWith("__feed:");
    const items = isFeed
      ? rawItems
      : uniqueSearchPageItems(searchCacheKey(text), currentPage, rawItems);
    const hasMore = !isFeed
      && items.length > 0
      && (rawItems.length >= SEARCH_PAGE_SIZE || hasNextSearchPage(html, currentPage, rawItems.length));
    return { items, hasMore };
  }

  async function extractDetails(value) {
    const manga = mangaReference(value);
    const html = await request(manga.href, { maxBytesHint: 12 * 1024 * 1024 });
    const result = parseDetailsHTML(html, manga.href);
    result.sourceID = mangaID(html);
    return result;
  }

  async function loadChapters(manga) {
    const page = await request(manga.href, { maxBytesHint: 12 * 1024 * 1024 });
    const sourceID = mangaID(page);
    const payload = await requestJSON(`${BASE_URL}/ajax/reading-list/${sourceID}`, {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: manga.href,
        "X-Requested-With": "XMLHttpRequest",
      },
      maxBytesHint: 12 * 1024 * 1024,
    });
    const chapters = parseChapters(readingListHTML(payload), { ...manga, sourceID });
    if (!chapters.length) throw new Error("MangaXo returned no English chapters for this manga.");
    return chapters;
  }

  async function extractChapters(value) {
    const manga = mangaReference(value);
    if (chapterCache.has(manga.slug)) return chapterCache.get(manga.slug);
    if (chapterLoads.has(manga.slug)) return chapterLoads.get(manga.slug);
    const load = loadChapters(manga);
    chapterLoads.set(manga.slug, load);
    try {
      const chapters = await load;
      chapterCache.set(manga.slug, chapters);
      return chapters;
    } finally {
      chapterLoads.delete(manga.slug);
    }
  }

  async function resolveChapter(reference) {
    const cached = chapterRecords.get(reference.key);
    if (cached) return cached;
    await extractChapters(`${BASE_URL}/manga/${reference.slug}`);
    const resolved = chapterRecords.get(reference.key);
    if (!resolved) throw new Error("MangaXo chapter is not present in the English chapter list.");
    return resolved;
  }

  async function extractImages(value) {
    const reference = chapterReference(value);
    const chapter = await resolveChapter(reference);
    const payload = await requestJSON(`${BASE_URL}/ajax/image/list/${chapter.readingId}?mode=vertical&hozPageSize=1`, {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: chapter.href,
        "X-Requested-With": "XMLHttpRequest",
      },
      maxBytesHint: 12 * 1024 * 1024,
    });
    if (payload.status === false) throw new Error("MangaXo chapter image request failed.");
    return parseImageList(payload.html, reference.href);
  }

  async function discoveryHome() {
    const html = await request(`${BASE_URL}/home`, { maxBytesHint: 12 * 1024 * 1024 });
    const items = parsePosterCards(html);
    if (!items.length) throw new Error("MangaXo returned no discovery items.");
    return { sections: [{ id: "home", title: "MangaXo Home", items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    if (currentPage > 1) return { items: [], hasMore: false };
    const html = await request(`${BASE_URL}/home`, { maxBytesHint: 12 * 1024 * 1024 });
    const items = parsePosterCards(html);
    if (!items.length) throw new Error(`MangaXo returned no ${String(feedID || "home")} items.`);
    return { items, hasMore: false };
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
