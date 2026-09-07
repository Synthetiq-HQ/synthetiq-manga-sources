"use strict";

(() => {
  const BASE_URL = "https://novelfrance.fr";
  const API_URL = `${BASE_URL}/api`;
  const SEARCH_PAGE_SIZE = 20;
  const CHAPTER_PAGE_SIZE = 50;
  const MAX_CHAPTER_PAGES = 200;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const NOVEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,180}$/i;
  const CHAPTER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,180}$/i;
  const DEFAULT_HEADERS = {
    Accept: "application/json",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    Referer: `${BASE_URL}/`,
  };
  const UNSAFE_MARKERS = [
    "18",
    "r 18",
    "adult",
    "adulte",
    "mature",
    "ecchi",
    "harem",
    "yaoi",
    "yuri",
    "hentai",
    "erotic",
    "erotique",
    "erotisme",
    "smut",
    "nsfw",
    "explicit",
    "porn",
    "pornographique",
    "sexuel",
    "sexuelle",
    "sexual",
    "lemon",
    "lime",
    "x rated",
  ];
  const detailsCache = new Map();
  const chaptersCache = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
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

  function cleanText(value) {
    if (typeof value !== "string") return "";
    return decodeEntities(value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function allowedHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "novelfrance.fr" || host.endsWith(".novelfrance.fr");
  }

  function absoluteURL(value) {
    if (typeof value !== "string") return "";
    const input = value.trim();
    if (!input) return "";
    try {
      const url = new URL(input, BASE_URL);
      if (url.protocol !== "https:" || !allowedHost(url.hostname)) return "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function novelURL(slug) {
    return `${BASE_URL}/novel/${encodeURIComponent(slug)}`;
  }

  function chapterURL(slug, chapterSlug) {
    return `${novelURL(slug)}/${encodeURIComponent(chapterSlug)}`;
  }

  function normalizeNovelSlug(value) {
    if (typeof value !== "string") throw new Error("NovelFrance identifier is invalid.");
    const input = value.trim();
    if (NOVEL_SLUG_PATTERN.test(input)) return input.toLowerCase();
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error("NovelFrance identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.search || url.hash) {
      throw new Error("NovelFrance identifier host or URL is not allowed.");
    }
    const match = url.pathname.match(/^\/novel\/([a-z0-9][a-z0-9-]{1,180})\/?$/i);
    if (!match) throw new Error("NovelFrance identifier is not a novel URL.");
    return match[1].toLowerCase();
  }

  function normalizeChapterReference(value) {
    if (typeof value !== "string") throw new Error("NovelFrance chapter identifier is invalid.");
    let url;
    try {
      url = new URL(String(value || ""), BASE_URL);
    } catch (_) {
      throw new Error("NovelFrance chapter identifier is invalid.");
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname) || url.search || url.hash) {
      throw new Error("NovelFrance chapter host or URL is not allowed.");
    }
    const match = url.pathname.match(/^\/novel\/([a-z0-9][a-z0-9-]{1,180})\/([a-z0-9][a-z0-9-]{0,180})\/?$/i);
    if (!match) throw new Error("NovelFrance identifier is not a chapter URL.");
    return { slug: match[1].toLowerCase(), chapterSlug: match[2].toLowerCase() };
  }

  function responseBody(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") return response.text();
    return Promise.resolve(typeof response.body === "string" ? response.body : response.body || "");
  }

  function isChallengePage(body) {
    return /(?:cf-chl-|cf-turnstile|challenge-platform|just a moment|access denied)/i.test(String(body || "").slice(0, 65536));
  }

  async function requestJSON(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelFrance requires the fetchv2 bridge.");
    const requestURL = absoluteURL(url);
    if (!requestURL) throw new Error("NovelFrance request URL is not public or host-confined.");
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          "GET",
          null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
            responseClass: "json",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.bodyDropped) throw new Error("NovelFrance response exceeded the module limit.");
        const finalURL = response.finalUrl || response.url;
        if (finalURL && !absoluteURL(finalURL)) {
          throw new Error("NovelFrance redirected to a non-public or unapproved host.");
        }
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`NovelFrance request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        const body = await responseBody(response);
        if (!body) throw new Error("NovelFrance returned an empty response.");
        if (isChallengePage(body)) throw new Error("NovelFrance returned a browser challenge.");
        if (typeof body === "object") return body;
        try {
          return JSON.parse(body);
        } catch (_) {
          throw new Error("NovelFrance returned malformed JSON.");
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|exceeded the module limit|malformed JSON/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("NovelFrance request failed.");
  }

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\+/g, " plus ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasUnsafeMarker(value) {
    const normalized = fold(value);
    return UNSAFE_MARKERS.some((marker) => {
      const token = fold(marker);
      return token && (` ${normalized} `).includes(` ${token} `);
    });
  }

  function structuredMetadataValues(novel) {
    const values = [];
    let hasSafetyField = false;
    for (const field of ["genres", "tags"]) {
      if (!Object.prototype.hasOwnProperty.call(novel || {}, field)) continue;
      hasSafetyField = true;
      if (!Array.isArray(novel[field])) throw new Error("NovelFrance safety metadata is malformed.");
      for (const item of novel[field]) {
        let value = "";
        if (typeof item === "string") {
          value = item;
        } else if (item && typeof item === "object" && !Array.isArray(item)) {
          const candidates = [item.name, item.slug].filter((candidate) => candidate !== undefined && candidate !== null);
          if (!candidates.length || candidates.some((candidate) => typeof candidate !== "string")) {
            throw new Error("NovelFrance safety metadata is malformed.");
          }
          value = candidates.find((candidate) => cleanText(candidate)) || "";
        } else {
          throw new Error("NovelFrance safety metadata is malformed.");
        }
        const cleaned = cleanText(value);
        if (!cleaned) throw new Error("NovelFrance safety metadata is empty.");
        values.push(cleaned);
      }
    }
    if (!hasSafetyField || !values.length) throw new Error("NovelFrance safety metadata is missing.");
    return [...new Set(values)];
  }

  function metadataValues(novel) {
    const values = structuredMetadataValues(novel);
    for (const field of ["contentRating", "ageRating"]) {
      if (!Object.prototype.hasOwnProperty.call(novel || {}, field) || novel[field] === null) continue;
      if (typeof novel[field] !== "string" || !cleanText(novel[field])) {
        throw new Error("NovelFrance safety metadata is malformed.");
      }
      values.push(cleanText(novel[field]));
    }
    const title = cleanText(novel && novel.title);
    if (!title) throw new Error("NovelFrance title is empty after cleaning.");
    values.push(title);
    return [...new Set(values)];
  }

  function assertSafeNovel(novel) {
    const values = metadataValues(novel);
    if (values.some(hasUnsafeMarker)) throw new Error("NovelFrance title failed the safety filter.");
    return structuredMetadataValues(novel);
  }

  function validateSearchIdentity(novel) {
    const slug = normalizeNovelSlug(novel && novel.slug);
    if (Object.prototype.hasOwnProperty.call(novel, "id")) {
      const sourceID = novel.id;
      const validStringID = typeof sourceID === "string" && sourceID.trim() && sourceID.length <= 256 && !/[/?#]/.test(sourceID);
      const validNumericID = Number.isSafeInteger(sourceID) && sourceID >= 0;
      if (!validStringID && !validNumericID) throw new Error("NovelFrance search identity is invalid.");
    }
    return slug;
  }

  function safeSearchItem(novel) {
    if (!novel || typeof novel !== "object" || Array.isArray(novel)) return null;
    try {
      const slug = validateSearchIdentity(novel);
      const title = cleanText(novel.title);
      if (!title) throw new Error("NovelFrance title is empty after cleaning.");
      const genres = assertSafeNovel(novel);
      const href = novelURL(slug);
      const author = cleanText(novel.author);
      return {
        id: slug,
        href,
        url: href,
        title,
        description: cleanText(novel.description),
        image: absoluteURL(novel.coverImage),
        author,
        authors: author ? [author] : [],
        genres,
        status: cleanText(novel.status),
        language: "fr",
      };
    } catch (_) {
      return null;
    }
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    if (!text) return { items: [], hasMore: false };
    const requestedPage = Number(page);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
      throw new Error("NovelFrance search pagination page is invalid.");
    }
    const skip = (requestedPage - 1) * SEARCH_PAGE_SIZE;
    if (!Number.isSafeInteger(skip)) throw new Error("NovelFrance search pagination is invalid.");
    const payload = await requestJSON(`${API_URL}/search?q=${encodeURIComponent(text.slice(0, 160))}&skip=${skip}&take=${SEARCH_PAGE_SIZE}`);
    if (!payload || !Array.isArray(payload.novels)) throw new Error("NovelFrance search returned no novel list.");
    if (typeof payload.hasMore !== "boolean") throw new Error("NovelFrance search pagination metadata was invalid.");
    for (const field of ["skip", "total"]) {
      if (Object.prototype.hasOwnProperty.call(payload, field) && (!Number.isSafeInteger(payload[field]) || payload[field] < 0)) {
        throw new Error("NovelFrance search pagination metadata was invalid.");
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "take") && (!Number.isSafeInteger(payload.take) || payload.take <= 0)) {
      throw new Error("NovelFrance search pagination metadata was invalid.");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "skip") && payload.skip !== skip) {
      throw new Error("NovelFrance search pagination cursor was invalid.");
    }
    if (Number.isSafeInteger(payload.skip) && Number.isSafeInteger(payload.take) && Number.isSafeInteger(payload.total)) {
      const expectedHasMore = payload.skip + payload.take < payload.total;
      if (payload.hasMore !== expectedHasMore) throw new Error("NovelFrance search pagination metadata was inconsistent.");
    }
    const items = [];
    const seen = new Set();
    for (const novel of payload.novels) {
      const item = safeSearchItem(novel);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return { items, hasMore: Boolean(payload.hasMore) };
  }

  async function extractDetails(id) {
    const slug = normalizeNovelSlug(id);
    if (detailsCache.has(slug)) return detailsCache.get(slug);
    const novel = await requestJSON(`${API_URL}/novels/${encodeURIComponent(slug)}`);
    if (!novel || String(novel.slug || "").toLowerCase() !== slug) throw new Error("NovelFrance returned mismatched novel details.");
    const genres = assertSafeNovel(novel);
    const href = novelURL(slug);
    const author = cleanText(novel.author);
    const title = cleanText(novel.title);
    const details = {
      id: slug,
      href,
      url: href,
      title,
      description: cleanText(novel.description),
      image: absoluteURL(novel.coverImage),
      author,
      authors: author ? [author] : [],
      genres,
      status: cleanText(novel.status),
      language: "fr",
    };
    detailsCache.set(slug, details);
    return details;
  }

  function normalizedChapter(chapter, slug) {
    if (!chapter || typeof chapter !== "object") return null;
    if (typeof chapter.isPremium !== "boolean" || !Object.prototype.hasOwnProperty.call(chapter, "freeAt")) {
      throw new Error("NovelFrance chapter safety metadata is missing.");
    }
    if (chapter.isPremium || chapter.freeAt !== null) return null;
    const number = Number(chapter.chapterNumber);
    const chapterSlug = String(chapter.slug || "").trim().toLowerCase();
    const title = cleanText(chapter.title);
    if (!Number.isFinite(number) || number < 0 || !CHAPTER_SLUG_PATTERN.test(chapterSlug) || !title) return null;
    const href = chapterURL(slug, chapterSlug);
    return {
      id: href,
      href,
      url: href,
      number,
      title,
      language: "fr",
      isPremium: false,
    };
  }

  async function extractChapters(id) {
    const slug = normalizeNovelSlug(id);
    if (chaptersCache.has(slug)) return chaptersCache.get(slug);
    await extractDetails(slug);
    const output = [];
    const seen = new Set();
    let skip = 0;
    let pageCount = 0;
    let hasMore = true;
    while (hasMore) {
      pageCount += 1;
      if (pageCount > MAX_CHAPTER_PAGES) throw new Error("NovelFrance chapter list exceeded the safety limit.");
      const payload = await requestJSON(`${API_URL}/chapters/${encodeURIComponent(slug)}?skip=${skip}&take=${CHAPTER_PAGE_SIZE}&order=asc`);
      if (!payload || !Array.isArray(payload.chapters)) throw new Error("NovelFrance returned no chapter list.");
      if (typeof payload.hasMore !== "boolean" || !Number.isSafeInteger(payload.skip) || payload.skip < 0 ||
        !Number.isSafeInteger(payload.take) || payload.take <= 0 || !Number.isSafeInteger(payload.total) || payload.total < 0 ||
        payload.order !== "asc") {
        throw new Error("NovelFrance chapter pagination metadata was invalid.");
      }
      if (payload.skip !== skip) throw new Error("NovelFrance chapter pagination cursor was invalid.");
      const expectedHasMore = payload.skip + payload.take < payload.total;
      if (payload.hasMore !== expectedHasMore) throw new Error("NovelFrance chapter pagination metadata was inconsistent.");
      if (payload.hasMore && payload.chapters.length === 0) throw new Error("NovelFrance chapter pagination made no progress.");
      for (const chapter of payload.chapters) {
        const normalized = normalizedChapter(chapter, slug);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        output.push(normalized);
      }
      hasMore = payload.hasMore;
      skip += payload.take;
    }
    output.sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
    chaptersCache.set(slug, output);
    return output;
  }

  async function extractText(reference) {
    const { slug, chapterSlug } = normalizeChapterReference(reference);
    await extractDetails(slug);
    const chapter = await requestJSON(`${API_URL}/chapters/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}`);
    if (!chapter || typeof chapter.slug !== "string" || chapter.slug.toLowerCase() !== chapterSlug) {
      throw new Error("NovelFrance returned mismatched chapter content.");
    }
    if (typeof chapter.isPremium !== "boolean" || !Object.prototype.hasOwnProperty.call(chapter, "freeAt")) {
      throw new Error("NovelFrance chapter safety metadata is missing.");
    }
    if (chapter.isPremium || chapter.freeAt !== null) throw new Error("NovelFrance chapter is premium or locked.");
    if (!Array.isArray(chapter.paragraphs)) throw new Error("NovelFrance chapter text is unavailable.");
    const paragraphs = chapter.paragraphs
      .filter((paragraph) => paragraph && (!paragraph.kind || paragraph.kind === "text"))
      .map((paragraph) => cleanText(paragraph.content))
      .filter(Boolean);
    const content = paragraphs.join("\n\n").trim();
    if (!content) throw new Error("NovelFrance chapter text was empty.");
    return content;
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractText };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
