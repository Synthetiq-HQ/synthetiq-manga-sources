"use strict";

(() => {
  // MangaDex (Español) — Spanish-language catalogue from the public MangaDex
  // API. Search and discovery are scoped to titles that have es-la/es chapter
  // uploads; the catalogue mirrors the site's mature setting (safe,
  // suggestive and erotica ratings; explicit titles stay excluded). Chapters
  // are deduplicated per volume+chapter with the Latin American edition
  // preferred, and page images come from the official at-home network
  // (api.mangadex.org -> *.mangadex.network).
  const WEBSITE_URL = "https://mangadex.org";
  const API_URL = "https://api.mangadex.org";
  const UPLOADS_URL = "https://uploads.mangadex.org";
  const TRANSLATED_LANGUAGES = ["es-la", "es"];
  const CONTENT_RATINGS = ["safe", "suggestive", "erotica"];
  const TITLE_LANGUAGES = ["es-la", "es", "en", "ja-ro", "ja"];
  const NO_SPANISH_CHAPTERS_NOTICE = "⚠️ Sin capítulos en español disponibles en MangaDex.";
  const FEED_SECTIONS = [
    { id: "popular", title: "Popular en español", feed: "__feed:popular" },
    { id: "latest", title: "Actualizaciones recientes", feed: "__feed:latest" },
  ];
  const SEARCH_PAGE_SIZE = 20;
  const FEED_PAGE_SIZE = 500;
  const MAX_FEED_PAGES = 12;
  const LIST_BYTE_HINT = 2 * 1024 * 1024;
  const DETAILS_BYTE_HINT = 2 * 1024 * 1024;
  const FEED_BYTE_HINT = 4 * 1024 * 1024;
  const ATHOME_BYTE_HINT = 1024 * 1024;
  const DEFAULT_HEADERS = {
    Accept: "application/json",
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?mangadex\.org\/(title|chapter)\/([0-9a-f-]{36})(?:[/?#].*)?$/i;
  const HTTPS_HOST_PATTERN = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i;

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
        .replace(/<[^>]+>/g, " ")
        // MangaDex descriptions use markdown links; keep only the label.
        .replace(/\[([^\]]*)\]\((?:https?:)?\/\/[^)\s]*\)/g, "$1"),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
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
      throw new Error("MangaDex requires the fetchv2 bridge.");
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
        lastError = new Error(`MangaDex request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("MangaDex returned an empty response.");
    }
    throw lastError || new Error("MangaDex request failed.");
  }

  async function fetchJSON(url, maxBytesHint) {
    const body = await fetchDirect(url, { maxBytesHint: maxBytesHint || LIST_BYTE_HINT });
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("MangaDex returned an unparseable JSON response.");
    }
    if (!data || typeof data !== "object") {
      throw new Error("MangaDex returned an unexpected JSON payload.");
    }
    return data;
  }

  function httpHost(value) {
    const match = String(value || "").match(HTTPS_HOST_PATTERN);
    return match ? match[1].toLowerCase() : "";
  }

  function isAllowedImageHost(value) {
    const host = httpHost(value);
    if (!host) return false;
    return host === "uploads.mangadex.org" || host === "mangadex.network" || host.endsWith(".mangadex.network");
  }

  function normalizeUUID(value, label, pathKind) {
    const raw = String(value == null ? "" : value).trim();
    const fromURL = raw.match(UUID_URL_PATTERN);
    let candidate = raw;
    if (fromURL) {
      if (pathKind && fromURL[1].toLowerCase() !== pathKind) {
        throw new Error(`Invalid MangaDex ${label} identifier.`);
      }
      candidate = fromURL[2];
    }
    if (!UUID_PATTERN.test(candidate)) {
      throw new Error(`Invalid MangaDex ${label} identifier.`);
    }
    return candidate.toLowerCase();
  }

  function mangaUUID(value) {
    return normalizeUUID(value, "manga", "title");
  }

  function chapterUUID(value) {
    return normalizeUUID(value, "chapter", "chapter");
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

  function availableLanguageParams() {
    return TRANSLATED_LANGUAGES.map((language) => ["availableTranslatedLanguage[]", language]);
  }

  function chapterLanguageParams() {
    return TRANSLATED_LANGUAGES.map((language) => ["translatedLanguage[]", language]);
  }

  function contentRatingParams() {
    return CONTENT_RATINGS.map((rating) => ["contentRating[]", rating]);
  }

  function localizedTitle(attributes) {
    const title = attributes && attributes.title && typeof attributes.title === "object" ? attributes.title : {};
    for (const language of TITLE_LANGUAGES) {
      if (typeof title[language] === "string" && title[language].trim()) return title[language].trim();
    }
    const altTitles = Array.isArray(attributes && attributes.altTitles) ? attributes.altTitles : [];
    for (const language of TITLE_LANGUAGES) {
      for (const alternate of altTitles) {
        if (alternate && typeof alternate[language] === "string" && alternate[language].trim()) {
          return alternate[language].trim();
        }
      }
    }
    const fallback = Object.values(title).find((value) => typeof value === "string" && value.trim());
    return fallback ? fallback.trim() : "MangaDex title";
  }

  function localizedDescription(attributes) {
    const description = attributes && attributes.description && typeof attributes.description === "object"
      ? attributes.description
      : {};
    for (const language of TITLE_LANGUAGES) {
      if (typeof description[language] === "string" && description[language].trim()) {
        return stripHTML(description[language]);
      }
    }
    const fallback = Object.values(description).find((value) => typeof value === "string" && value.trim());
    return fallback ? stripHTML(fallback) : "";
  }

  function coverFileName(manga) {
    const relationships = Array.isArray(manga && manga.relationships) ? manga.relationships : [];
    const cover = relationships.find((relationship) => relationship && relationship.type === "cover_art");
    const fileName = cover && cover.attributes && cover.attributes.fileName;
    return typeof fileName === "string" ? fileName.trim() : "";
  }

  function coverURL(mangaID, fileName, thumbnail) {
    if (!fileName) return "";
    const suffix = thumbnail ? ".256.jpg" : "";
    return `${UPLOADS_URL}/covers/${String(mangaID || "").toLowerCase()}/${fileName}${suffix}`;
  }

  function mangaSummary(manga) {
    const id = `${WEBSITE_URL}/title/${String(manga && manga.id || "").toLowerCase()}`;
    return {
      id,
      href: id,
      url: id,
      title: localizedTitle(manga && manga.attributes),
      image: coverURL(manga && manga.id, coverFileName(manga), true),
    };
  }

  function statusLabel(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    const mapped = {
      ongoing: "Ongoing",
      completed: "Completed",
      hiatus: "Hiatus",
      cancelled: "Cancelled",
    };
    return mapped[value.toLowerCase()] || value.charAt(0).toUpperCase() + value.slice(1);
  }

  function genreNames(attributes) {
    const tags = Array.isArray(attributes && attributes.tags) ? attributes.tags : [];
    const names = [];
    const seen = new Set();
    for (const tag of tags) {
      const tagAttributes = tag && tag.attributes && typeof tag.attributes === "object" ? tag.attributes : null;
      if (!tagAttributes) continue;
      const group = typeof tagAttributes.group === "string" ? tagAttributes.group : "";
      if (group && group !== "genre" && group !== "theme") continue;
      const dict = tagAttributes.name && typeof tagAttributes.name === "object" ? tagAttributes.name : {};
      const preferred = typeof dict.en === "string" && dict.en.trim()
        ? dict.en.trim()
        : (Object.values(dict).find((value) => typeof value === "string" && value.trim()) || "").trim();
      const key = preferred.toLowerCase();
      if (!preferred || seen.has(key)) continue;
      seen.add(key);
      names.push(preferred);
    }
    return names;
  }

  function searchQuery(input) {
    if (typeof input === "string") return input.trim();
    if (input && typeof input === "object") {
      return String(input.text || input.query || "").trim();
    }
    return "";
  }

  async function fetchMangaPage(extraPairs, offset, limit) {
    const pairs = [
      ["limit", limit],
      ["offset", offset],
      ["includes[]", "cover_art"],
    ].concat(availableLanguageParams(), contentRatingParams(), extraPairs);
    const payload = await fetchJSON(`${API_URL}/manga?${buildParams(pairs)}`, LIST_BYTE_HINT);
    const data = Array.isArray(payload.data)
      ? payload.data.filter((manga) => manga && manga.type === "manga")
      : [];
    return { items: data.map(mangaSummary), total: Number(payload.total || 0) };
  }

  async function searchResults(query, page = 1) {
    const text = searchQuery(query);
    const pageNumber = Math.max(1, Number(page) || 1);
    const offset = (pageNumber - 1) * SEARCH_PAGE_SIZE;
    const extras = [];
    if (text === "__feed:latest") {
      extras.push(["order[latestUploadedChapter]", "desc"]);
    } else if (text === "__feed:popular" || !text) {
      extras.push(["order[followedCount]", "desc"]);
    } else {
      // MangaDex relevance ordering for free-text title searches.
      extras.push(["title", text]);
    }
    const { items, total } = await fetchMangaPage(extras, offset, SEARCH_PAGE_SIZE);
    return { items, hasMore: offset + items.length < total };
  }

  // Best-effort: does this title have at least one READABLE Spanish chapter?
  // Only a complete feed page with zero readable chapters answers false
  // (used to annotate stale "available in Spanish" titles); any error or
  // truncated response answers true so the raw description stays untouched.
  async function hasReadableSpanishChapters(uuid) {
    try {
      const pairs = [
        ["limit", FEED_PAGE_SIZE],
        ["offset", 0],
        ["includeExternalUrl", 0],
        ["order[volume]", "asc"],
        ["order[chapter]", "asc"],
      ].concat(chapterLanguageParams(), contentRatingParams());
      const payload = await fetchJSON(`${API_URL}/manga/${uuid}/feed?${buildParams(pairs)}`, FEED_BYTE_HINT);
      const data = Array.isArray(payload.data)
        ? payload.data.filter((chapter) => chapter && chapter.type === "chapter")
        : [];
      const total = Number(payload.total || 0);
      if (total > data.length) return true;
      for (const chapter of data) {
        const attributes = chapter.attributes || {};
        if (attributes.externalUrl) continue;
        if (attributes.isUnavailable === true) continue;
        if (!(Number(attributes.pages) > 0)) continue;
        const language = String(attributes.translatedLanguage || "").toLowerCase();
        if (!TRANSLATED_LANGUAGES.includes(language)) continue;
        return true;
      }
      return false;
    } catch (error) {
      return true;
    }
  }

  async function extractDetails(mangaID) {
    const uuid = mangaUUID(mangaID);
    const query = buildParams([
      ["includes[]", "cover_art"],
      ["includes[]", "author"],
      ["includes[]", "artist"],
    ]);
    const payload = await fetchJSON(`${API_URL}/manga/${uuid}?${query}`, DETAILS_BYTE_HINT);
    const manga = payload.data;
    if (!manga || typeof manga !== "object") {
      throw new Error("MangaDex returned no manga details.");
    }
    const attributes = manga.attributes || {};
    const relationships = Array.isArray(manga.relationships) ? manga.relationships : [];
    const authors = [];
    const seenAuthors = new Set();
    for (const relationship of relationships) {
      if (!relationship || (relationship.type !== "author" && relationship.type !== "artist")) continue;
      const name = relationship.attributes && relationship.attributes.name;
      const label = typeof name === "string" ? name.trim() : "";
      const key = label.toLowerCase();
      if (!label || seenAuthors.has(key)) continue;
      seenAuthors.add(key);
      authors.push(label);
    }
    const id = `${WEBSITE_URL}/title/${String(manga.id || uuid).toLowerCase()}`;
    const details = {
      id,
      href: id,
      url: id,
      title: localizedTitle(attributes),
      description: localizedDescription(attributes),
      image: coverURL(manga.id || uuid, coverFileName(manga), false),
      authors,
      author: authors[0] || "",
      genres: genreNames(attributes),
      status: statusLabel(attributes.status),
    };
    if (!(await hasReadableSpanishChapters(uuid))) {
      // Stale MangaDex metadata: this title's Spanish chapters were pulled
      // (licensing). Make the empty chapter list read as intentional
      // instead of an error.
      details.description = details.description
        ? `${NO_SPANISH_CHAPTERS_NOTICE}\n\n${details.description}`
        : NO_SPANISH_CHAPTERS_NOTICE;
    }
    return details;
  }

  async function extractChapters(mangaID) {
    const uuid = mangaUUID(mangaID);
    const rawChapters = [];
    let offset = 0;
    let total = null;
    for (let pageIndex = 0; pageIndex < MAX_FEED_PAGES; pageIndex += 1) {
      const pairs = [
        ["limit", FEED_PAGE_SIZE],
        ["offset", offset],
        ["includes[]", "scanlation_group"],
        ["includeExternalUrl", 0],
        ["order[volume]", "asc"],
        ["order[chapter]", "asc"],
      ].concat(chapterLanguageParams(), contentRatingParams());
      const payload = await fetchJSON(`${API_URL}/manga/${uuid}/feed?${buildParams(pairs)}`, FEED_BYTE_HINT);
      const data = Array.isArray(payload.data)
        ? payload.data.filter((chapter) => chapter && chapter.type === "chapter")
        : [];
      rawChapters.push(...data);
      total = Number(payload.total || 0);
      offset += data.length;
      if (!data.length || offset >= total) break;
    }

    const byChapter = new Map();
    for (const chapter of rawChapters) {
      const attributes = chapter.attributes || {};
      // External-hosted, pulled, or page-less chapters cannot be read here.
      if (attributes.externalUrl) continue;
      if (attributes.isUnavailable === true) continue;
      if (!(Number(attributes.pages) > 0)) continue;
      const language = String(attributes.translatedLanguage || "").toLowerCase();
      if (!TRANSLATED_LANGUAGES.includes(language)) continue;
      const number = attributes.chapter == null ? "" : String(attributes.chapter).trim();
      const volume = attributes.volume == null ? "" : String(attributes.volume).trim();
      const titleKey = number ? "" : String(attributes.title || "").trim().toLowerCase();
      const key = `${volume}|${number}|${titleKey}`;
      const existing = byChapter.get(key);
      // Prefer the Latin-American edition when both exist; otherwise keep the
      // first copy of a duplicated chapter number.
      if (existing && !(existing.language === "es" && language === "es-la")) continue;
      byChapter.set(key, {
        chapter,
        language,
        uuid: String(chapter.id || "").toLowerCase(),
      });
    }
    if (!byChapter.size) {
      // MangaDex can keep stale "available in Spanish" metadata for titles
      // whose chapters were pulled (licensing). Mirror the site and answer
      // with an empty list instead of failing the whole request.
      return [];
    }

    const chapters = [];
    for (const entry of byChapter.values()) {
      const attributes = entry.chapter.attributes || {};
      const numberRaw = attributes.chapter == null ? "" : String(attributes.chapter).trim();
      const parsed = numberRaw ? Number(numberRaw) : NaN;
      const titleText = String(attributes.title || "").trim();
      const id = `${WEBSITE_URL}/chapter/${entry.uuid}`;
      const item = {
        id,
        href: id,
        url: id,
        language: "es",
      };
      item.title = numberRaw
        ? `Cap. ${numberRaw}${titleText ? ` - ${titleText}` : ""}`
        : (titleText || "Especial");
      if (Number.isFinite(parsed)) item.number = parsed;
      const released = typeof attributes.readableAt === "string" && attributes.readableAt
        ? attributes.readableAt
        : attributes.publishAt;
      if (typeof released === "string" && released) item.releaseDate = released;
      chapters.push(item);
    }
    chapters.sort((left, right) => {
      const leftNumber = Number.isFinite(left.number) ? left.number : null;
      const rightNumber = Number.isFinite(right.number) ? right.number : null;
      if (leftNumber === null && rightNumber === null) return 0;
      if (leftNumber === null) return 1;
      if (rightNumber === null) return -1;
      return rightNumber - leftNumber;
    });
    return chapters;
  }

  async function extractImages(chapterID) {
    const uuid = chapterUUID(chapterID);
    const payload = await fetchJSON(`${API_URL}/at-home/server/${uuid}`, ATHOME_BYTE_HINT);
    const baseURL = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
    const chapter = payload.chapter && typeof payload.chapter === "object" ? payload.chapter : {};
    const hash = String(chapter.hash || "").trim();
    const files = Array.isArray(chapter.data)
      ? chapter.data.filter((file) => typeof file === "string" && file.trim())
      : [];
    if (!baseURL.startsWith("https://") || !hash || !files.length) {
      throw new Error("MangaDex returned an incomplete chapter image payload.");
    }
    if (!isAllowedImageHost(baseURL)) {
      throw new Error("MangaDex returned an unexpected chapter image host.");
    }
    return files.map((file) => ({
      url: `${baseURL}/data/${hash}/${file.trim()}`,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*",
        Referer: `${WEBSITE_URL}/`,
      },
    }));
  }

  async function discoveryHome() {
    const sections = [];
    for (const section of FEED_SECTIONS) {
      const { items } = await searchResults(section.feed, 1);
      sections.push({ id: section.id, title: section.title, items });
    }
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    const id = String(feedID || "").trim().toLowerCase();
    const section = FEED_SECTIONS.find((candidate) => candidate.id === id);
    if (!section) return { items: [], hasMore: false };
    return searchResults(section.feed, page);
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
