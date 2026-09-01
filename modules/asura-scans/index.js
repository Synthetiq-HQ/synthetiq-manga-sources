"use strict";

(() => {
  const BASE_URL = "https://asurascans.com";
  const API_URL = "https://api.asurascans.com";
  const CDN_HOST = "cdn.asurascans.com";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/json",
    Referer: `${BASE_URL}/`,
  };
  const SUPPORTED_TYPES = new Set(["manga", "manhwa", "manhua", "webtoon", "comic"]);
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const RESPONSE_CACHE_TTL_MS = 30_000;
  const responseCache = new Map();

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
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());
      output.push(normalized);
    }
    return output;
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

  function isChallenge(body) {
    return /just a moment|cf-chl-|captcha|access denied|verify you are human|checking your browser/i.test(body);
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("Asura Scans requires the fetchv2 bridge.");
    }

    const requestURL = String(url);
    const responseClass = options.responseClass || "html";
    const cacheKey = `${responseClass}:${requestURL}`;
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt < RESPONSE_CACHE_TTL_MS) return cached.body;

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(750 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || 16 * 1024 * 1024,
            responseClass,
          },
        );
        const status = Number(response?.status || 0);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`Asura Scans request failed with HTTP ${status || "error"}.`);
          if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) continue;
          throw lastError;
        }
        if (response.bodyDropped) {
          throw new Error(`Asura Scans response was dropped: ${response.dropReason || "size policy"}.`);
        }
        const body = await responseText(response);
        if (!body) throw new Error("Asura Scans returned an empty response.");
        if (isChallenge(body)) throw new Error("Asura Scans returned a browser challenge instead of source data.");
        responseCache.set(cacheKey, { storedAt: Date.now(), body });
        if (responseCache.size > 50) responseCache.delete(responseCache.keys().next().value);
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          attempt >= MAX_ATTEMPTS
          || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)
        ) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("Asura Scans request failed.");
  }

  async function fetchJSON(url, options = {}) {
    const body = await fetchDirect(url, { ...options, responseClass: "json" });
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Asura Scans returned invalid JSON.");
    }
  }

  function sourceURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) throw new Error("Asura Scans identifier is empty.");
    const candidate = /^https?:\/\//i.test(raw)
      ? raw
      : `${BASE_URL}/${raw.replace(/^\/+/, "")}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("Invalid Asura Scans URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "asurascans.com") {
      throw new Error("Asura Scans URL is outside the source host.");
    }
    return parsed;
  }

  function decodePathSegment(value) {
    const decoded = decodeURIComponent(String(value || ""));
    if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") {
      throw new Error("Invalid Asura Scans path segment.");
    }
    return decoded;
  }

  function normalizedSeriesURL(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(/^\/comics\/([^/?#]+)\/?$/i);
    if (!match) throw new Error("Invalid Asura Scans series identifier.");
    const slug = decodePathSegment(match[1]);
    return `${BASE_URL}/comics/${encodeURIComponent(slug)}`;
  }

  function routeSlug(value) {
    const href = normalizedSeriesURL(value);
    return decodeURIComponent(new URL(href).pathname.split("/").filter(Boolean)[1]);
  }

  function normalizedChapterToken(value) {
    const token = decodePathSegment(value);
    if (!/^\d+(?:\.\d+)?$/.test(token)) throw new Error("Invalid Asura Scans chapter number.");
    const number = Number(token);
    if (!Number.isFinite(number)) throw new Error("Invalid Asura Scans chapter number.");
    return String(number);
  }

  function normalizedChapterURL(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(/^\/comics\/([^/?#]+)\/chapter\/([^/?#]+)\/?$/i);
    if (!match) throw new Error("Invalid Asura Scans chapter identifier.");
    const series = decodePathSegment(match[1]);
    const chapter = normalizedChapterToken(match[2]);
    return `${BASE_URL}/comics/${encodeURIComponent(series)}/chapter/${encodeURIComponent(chapter)}`;
  }

  function chapterParts(value) {
    const href = normalizedChapterURL(value);
    const parts = new URL(href).pathname.split("/").filter(Boolean);
    return {
      href,
      series: decodeURIComponent(parts[1]),
      number: Number(decodeURIComponent(parts[3])),
      token: decodeURIComponent(parts[3]),
    };
  }

  function normalizedPublicSeriesURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    return normalizedSeriesURL(/^https?:\/\//i.test(raw) ? raw : `${BASE_URL}/${raw.replace(/^\/+/, "")}`);
  }

  function isSupportedType(value) {
    const type = String(value || "").trim().toLowerCase();
    return !type || SUPPORTED_TYPES.has(type);
  }

  function safeCoverURL(value) {
    try {
      const parsed = new URL(decodeEntities(String(value || "").trim()));
      return parsed.protocol === "https:"
        && parsed.hostname.toLowerCase() === CDN_HOST
        && /^\/asura-images\/covers\/[^/?#]+\.(?:png|jpe?g|webp)$/i.test(parsed.pathname)
        ? parsed.toString()
        : "";
    } catch {
      return "";
    }
  }

  function safePageURL(value, chapterNumber, expectedAssetSlug) {
    try {
      const parsed = new URL(decodeEntities(String(value || "").trim()));
      const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      if (
        parsed.protocol !== "https:"
        || parsed.hostname.toLowerCase() !== CDN_HOST
        || parts.length !== 5
        || parts[0].toLowerCase() !== "asura-images"
        || !new Set(["chapters", "chapters-restored"]).has(parts[1].toLowerCase())
        || !expectedAssetSlug
        || parts[2] !== expectedAssetSlug
        || Number(parts[3]) !== Number(chapterNumber)
        || !/^[a-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(parts[4])
      ) return "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function normalizeQuery(query) {
    if (query && typeof query === "object" && !Array.isArray(query)) {
      return {
        feed: null,
        text: String(query.text || query.query || "").trim(),
        tags: Array.isArray(query.tags)
          ? query.tags.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
        excludeTags: Array.isArray(query.excludeTags)
          ? query.excludeTags.map((value) => String(value || "").trim()).filter(Boolean)
          : [],
        status: String(query.status || "").trim(),
        type: String(query.type || "").trim(),
      };
    }
    const raw = String(query || "").trim();
    if (/^__feed:popular$/i.test(raw)) return { feed: "popular", text: "", tags: [], excludeTags: [], status: "", type: "" };
    if (/^__feed:latest$/i.test(raw)) return { feed: "latest", text: "", tags: [], excludeTags: [], status: "", type: "" };
    return { feed: null, text: raw, tags: [], excludeTags: [], status: "", type: "" };
  }

  function statusLabel(value) {
    const status = String(value || "").trim().toLowerCase();
    if (status === "ongoing") return "Ongoing";
    if (status === "completed" || status === "complete" || status === "finished") return "Completed";
    if (status === "hiatus") return "Hiatus";
    if (status === "dropped") return "Dropped";
    if (status === "cancelled" || status === "canceled") return "Cancelled";
    return String(value || "Unknown").trim() || "Unknown";
  }

  function cardGenres(card) {
    return uniqueStrings((Array.isArray(card?.genres) ? card.genres : []).map((genre) => (
      typeof genre === "string" ? stripHTML(genre) : stripHTML(genre?.name || "")
    )));
  }

  function cardURL(card) {
    const raw = card?.public_url || (card?.slug ? `/comics/${card.slug}-08677664` : "");
    try {
      return normalizedPublicSeriesURL(raw);
    } catch {
      return "";
    }
  }

  function normalizeCard(card) {
    if (!card || !isSupportedType(card.type)) return null;
    const href = cardURL(card);
    const title = stripHTML(card.title || "");
    if (!href || !title) return null;
    const genres = cardGenres(card);
    return {
      id: href,
      href,
      title,
      ...(safeCoverURL(card.cover || card.image) ? { image: safeCoverURL(card.cover || card.image) } : {}),
      ...(genres.length ? { genres } : {}),
      ...(card.type ? { type: String(card.type).trim().toLowerCase() } : {}),
      ...(card.status ? { status: statusLabel(card.status) } : {}),
    };
  }

  function itemMatchesQuery(item, query) {
    const itemGenres = Array.isArray(item.genres) ? item.genres.map((value) => String(value).toLowerCase()) : [];
    if (query.tags.length && !query.tags.every((tag) => itemGenres.includes(tag.toLowerCase()))) return false;
    if (query.excludeTags.length && query.excludeTags.some((tag) => itemGenres.includes(tag.toLowerCase()))) return false;
    if (query.status && String(item.status || "").toLowerCase() !== query.status.toLowerCase()) return false;
    if (query.type && String(item.type || "").toLowerCase() !== query.type.toLowerCase()) return false;
    return true;
  }

  function parseSeriesPayload(payload, query) {
    const records = Array.isArray(payload?.data) ? payload.data : [];
    const items = records.map(normalizeCard).filter(Boolean).filter((item) => itemMatchesQuery(item, query));
    const hasMore = typeof payload?.meta?.has_more === "boolean" ? payload.meta.has_more : false;
    return { items, hasMore };
  }

  async function seriesFeed(sort, page = 1, query = {}) {
    const currentPage = Math.max(1, Number(page) || 1);
    const params = new URLSearchParams({
      sort: sort === "latest" ? "latest" : "popular",
      type: "manhwa",
      limit: "20",
      offset: String((currentPage - 1) * 20),
    });
    if (query.tags[0]) params.set("genres", query.tags[0].slice(0, 100));
    if (query.status) params.set("status", query.status.slice(0, 40).toLowerCase());
    const payload = await fetchJSON(`${API_URL}/api/series?${params.toString()}`, {
      headers: { Accept: "application/json", Referer: `${BASE_URL}/` },
      maxBytesHint: 4 * 1024 * 1024,
    });
    return parseSeriesPayload(payload, query);
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeQuery(query);
    if (normalized.feed) return seriesFeed(normalized.feed, page, normalized);

    if (!normalized.text || normalized.text === "*") {
      return seriesFeed("popular", page, normalized);
    }

    const currentPage = Math.max(1, Number(page) || 1);
    const params = new URLSearchParams({
      q: normalized.text.slice(0, 200),
      limit: "20",
      offset: String((currentPage - 1) * 20),
    });
    const payload = await fetchJSON(`${API_URL}/api/search?${params.toString()}`, {
      headers: { Accept: "application/json", Referer: `${BASE_URL}/` },
      maxBytesHint: 4 * 1024 * 1024,
    });
    return parseSeriesPayload(payload, normalized);
  }

  function normalizeSeriesDetails(payload, href) {
    const series = payload?.series;
    if (!series || typeof series !== "object") throw new Error("Asura Scans details did not contain a series.");
    if (!isSupportedType(series.type)) throw new Error("Asura Scans returned an unsupported series type.");
    if (series.public_url && normalizedPublicSeriesURL(series.public_url) !== href) {
      throw new Error("Asura Scans details belonged to a different series.");
    }
    const authors = uniqueStrings([series.author]);
    const genres = cardGenres(series);
    const image = safeCoverURL(series.cover || series.image);
    return {
      id: href,
      href,
      url: href,
      title: stripHTML(series.title || ""),
      description: stripHTML(series.description || ""),
      ...(image ? { image } : {}),
      authors,
      author: authors.join(", "),
      genres,
      status: statusLabel(series.status),
    };
  }

  async function extractDetails(value) {
    const href = normalizedSeriesURL(value);
    const slug = routeSlug(href);
    const payload = await fetchJSON(`${API_URL}/api/series/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json", Referer: `${BASE_URL}/` },
      maxBytesHint: 2 * 1024 * 1024,
    });
    return normalizeSeriesDetails(payload, href);
  }

  function unpackAstroValue(value) {
    if (Array.isArray(value)) {
      if (value.length >= 2 && typeof value[0] === "number") return unpackAstroValue(value[1]);
      if (value.length === 1 && value[0] === 0) return null;
      return value.map(unpackAstroValue);
    }
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, entry] of Object.entries(value)) output[key] = unpackAstroValue(entry);
      return output;
    }
    return value;
  }

  function chapterIsland(html) {
    for (const match of String(html || "").matchAll(/<astro-island\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/ChapterListReact/i.test(tag)) continue;
      const props = tag.match(/\bprops="([^"]*)"/i)?.[1];
      if (!props) throw new Error("Asura Scans chapter list props were missing.");
      try {
        return JSON.parse(decodeEntities(props));
      } catch {
        throw new Error("Asura Scans chapter list props were invalid.");
      }
    }
    throw new Error("Asura Scans did not expose a chapter list.");
  }

  function chapterIsPublic(chapter) {
    const premium = chapter?.is_premium === true || /^(?:true|1)$/i.test(String(chapter?.is_premium || ""));
    if (!premium) return true;
    const unlock = Date.parse(String(chapter?.early_access_until || ""));
    return Number.isFinite(unlock) && unlock <= Date.now();
  }

  function formatChapterNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Asura Scans returned an invalid chapter number.");
    return String(number);
  }

  function chaptersFromHTML(html, href) {
    const props = chapterIsland(html);
    const sourceSlug = String(unpackAstroValue(props.seriesSlug) || "").trim().toLowerCase();
    const rawChapters = unpackAstroValue(props.chapters);
    if (!Array.isArray(rawChapters)) throw new Error("Asura Scans chapter list was not an array.");
    const expectedPublicURL = String(unpackAstroValue(props.publicUrl) || "").trim();
    if (expectedPublicURL && normalizedPublicSeriesURL(expectedPublicURL) !== href) {
      throw new Error("Asura Scans chapter list belonged to a different series.");
    }

    const chapters = new Map();
    for (const sourceChapter of rawChapters) {
      if (!sourceChapter || typeof sourceChapter !== "object" || !chapterIsPublic(sourceChapter)) continue;
      if (sourceSlug && sourceChapter.series_slug && String(sourceChapter.series_slug).toLowerCase() !== sourceSlug) continue;
      const number = Number(sourceChapter.number ?? sourceChapter.name);
      if (!Number.isFinite(number)) continue;
      const token = formatChapterNumber(number);
      const chapterURL = `${href}/chapter/${encodeURIComponent(token)}`;
      if (chapters.has(chapterURL)) continue;
      const sourceTitle = stripHTML(sourceChapter.title || "");
      const title = sourceTitle && /^chapter\s+\d/i.test(sourceTitle)
        ? sourceTitle
        : `Chapter ${token}${sourceTitle ? ` - ${sourceTitle}` : ""}`;
      const releaseDate = sourceChapter.published_at || sourceChapter.created_at || null;
      chapters.set(chapterURL, {
        id: chapterURL,
        href: chapterURL,
        url: chapterURL,
        title,
        number,
        releaseDate: releaseDate ? String(releaseDate) : null,
        language: "en",
      });
    }

    const output = [...chapters.values()];
    output.sort((left, right) => left.number - right.number || left.url.localeCompare(right.url));
    return output;
  }

  async function extractChapters(value) {
    const href = normalizedSeriesURL(value);
    const chapters = chaptersFromHTML(
      await fetchDirect(href, { maxBytesHint: 16 * 1024 * 1024 }),
      href,
    );
    if (!chapters.length) throw new Error("Asura Scans returned no public chapters for this series.");
    return chapters;
  }

  function pageEntries(payload, chapterInfo) {
    const data = payload?.data;
    const chapter = data?.chapter;
    if (!data || !chapter || typeof chapter !== "object") {
      throw new Error("Asura Scans chapter response did not contain chapter data.");
    }
    if (data.is_locked || String(data.access_gate || "").trim()) {
      throw new Error("Asura Scans chapter is locked or not publicly available.");
    }
    if (Number(chapter.number) !== chapterInfo.number) {
      throw new Error("Asura Scans returned a different chapter than requested.");
    }
    const expectedSeries = normalizedPublicSeriesURL(data.series?.public_url || "");
    const requestedSeries = `${BASE_URL}/comics/${encodeURIComponent(chapterInfo.series)}`;
    if (expectedSeries !== requestedSeries) {
      throw new Error("Asura Scans chapter belonged to a different series.");
    }
    const pages = Array.isArray(chapter.pages) ? chapter.pages : [];
    if (!pages.length) throw new Error("Asura Scans chapter returned no readable page images.");
    const firstURL = String(pages[0]?.url || pages[0] || "");
    let firstParsed;
    try { firstParsed = new URL(firstURL); } catch { throw new Error("Asura Scans chapter had an invalid page URL."); }
    const firstParts = firstParsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const assetSlug = firstParts.length === 5
      && firstParts[0] === "asura-images"
      && new Set(["chapters", "chapters-restored"]).has(firstParts[1].toLowerCase())
      ? firstParts[2]
      : "";
    if (!assetSlug) throw new Error("Asura Scans chapter had an invalid page path.");

    const seen = new Set();
    const output = [];
    for (const entry of pages) {
      const rawURL = typeof entry === "string" ? entry : entry?.url;
      const pageURL = safePageURL(rawURL, chapterInfo.number, assetSlug);
      if (!pageURL || seen.has(pageURL)) throw new Error("Asura Scans returned an invalid or duplicate page manifest.");
      seen.add(pageURL);
      output.push({
        url: pageURL,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
          Referer: chapterInfo.href,
        },
      });
    }
    const declaredCount = Number(chapter.page_count);
    if (Number.isInteger(declaredCount) && declaredCount > 0 && declaredCount !== output.length) {
      throw new Error("Asura Scans page manifest was incomplete.");
    }
    return output;
  }

  async function extractImages(value) {
    const chapterInfo = chapterParts(value);
    const payload = await fetchJSON(
      `${API_URL}/api/series/${encodeURIComponent(chapterInfo.series)}/chapters/${encodeURIComponent(chapterInfo.token)}`,
      {
        headers: { Accept: "application/json", Referer: chapterInfo.href },
        maxBytesHint: 8 * 1024 * 1024,
      },
    );
    return pageEntries(payload, chapterInfo);
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      seriesFeed("popular", 1, normalizeQuery("")),
      seriesFeed("latest", 1, normalizeQuery("")),
    ]);
    if (!popular.items.length || !latest.items.length) throw new Error("Asura Scans returned no discovery items.");
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest", items: latest.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
    return seriesFeed(feed, page, normalizeQuery(""));
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
