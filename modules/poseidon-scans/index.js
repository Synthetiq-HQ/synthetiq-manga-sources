"use strict";

(() => {
  const BASE_URL = "https://poseidon-scans.net";
  const LANGUAGE = "fr";
  const DEFAULT_HEADERS = {
    Accept: "text/x-component",
    RSC: "1",
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const OPTIMIZED_IMAGE_WIDTH = 1200;
  const OPTIMIZED_IMAGE_QUALITY = 75;
  const HOME_CACHE_TTL = 90_000;
  let homeCache = { at: 0, value: "" };

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

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("Poseidon Scans requires the fetchv2 bridge.");
    }
    const requestedAttempts = Number(options.maxAttempts);
    const attempts = Number.isFinite(requestedAttempts)
      ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(requestedAttempts)))
      : MAX_ATTEMPTS;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { "User-Agent": "Mozilla/5.0", ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || 8 * 1024 * 1024,
            responseClass: options.responseClass || "x-component",
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Poseidon Scans request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) {
        throw new Error(`Poseidon Scans response was dropped: ${response.dropReason || "size policy"}.`);
      }
      const body = await responseText(response);
      if (body) return { body, finalUrl: response.finalUrl || url };
      lastError = new Error("Poseidon Scans returned an empty response.");
    }
    throw lastError || new Error("Poseidon Scans request failed.");
  }

  function absoluteURL(raw) {
    const input = String(raw || "").trim().replace(/&amp;/g, "&");
    if (!input) return "";
    if (input.startsWith("https://")) return input.split("#")[0];
    if (input.startsWith("//")) return `https:${input}`.split("#")[0];
    if (input.startsWith("/")) return `${BASE_URL}${input}`.split("#")[0];
    return `${BASE_URL}/${input}`.split("#")[0];
  }

  function readerImageURL(raw) {
    const original = absoluteURL(raw);
    if (!original) return "";
    // Poseidon serves some source scans above the Books downloader's 12 MiB
    // per-image ceiling. Its public Next image route provides a bounded,
    // cacheable WebP without requiring credentials or browser state.
    if (!/^https:\/\/poseidon-scans\.net\//i.test(original)) return original;
    if (original.startsWith(`${BASE_URL}/_next/image?`)) return original;
    return `${BASE_URL}/_next/image?url=${encodeURIComponent(original)}&w=${OPTIMIZED_IMAGE_WIDTH}&q=${OPTIMIZED_IMAGE_QUALITY}`;
  }

  function flightObject(text, key, open, close) {
    const needle = `"${key}":`;
    let index = String(text || "").indexOf(needle);
    if (index < 0) return null;
    index += needle.length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== open) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(index, cursor + 1);
      }
    }
    return null;
  }

  function parseJSON(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Poseidon Scans returned malformed data: ${error && error.message ? error.message : "parse error"}`);
    }
  }

  function seriesSlug(url) {
    const match = String(url || "").trim().match(/\/serie\/([^/?#]+)/i);
    if (!match) throw new Error("Invalid Poseidon Scans series identifier.");
    return match[1];
  }

  function formatChapterNumber(number) {
    return String(number).replace(/\.0+$/, "");
  }

  function chapterTitle(raw) {
    const base = raw.isVolume
      ? `Volume ${formatChapterNumber(raw.number)}`
      : `Chapitre ${formatChapterNumber(raw.number)}`;
    const title = String(raw.title || "").trim();
    return title && !raw.isVolume ? `${base} - ${title}` : base;
  }

  function normalizeDate(value) {
    const raw = String(value || "").replace(/^\$D/, "");
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function coverURL(slug, coverImage) {
    const raw = String(coverImage || "").trim();
    // The site resolves covers by series slug (filenames differ for some
    // series), so only absolute URLs are kept verbatim.
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${BASE_URL}/api/covers/${slug}.webp`;
  }

  function searchItem(manga) {
    const slug = String(manga.slug || "").trim();
    if (!slug) return null;
    const url = `${BASE_URL}/serie/${slug}`;
    return {
      id: url,
      href: url,
      url,
      title: decodeEntities(String(manga.title || "").trim()),
      image: coverURL(slug, manga.coverImage),
    };
  }

  async function searchRequest(query, page) {
    const q = encodeURIComponent(String(query || "").trim() || "a");
    const result = await fetchDirect(`${BASE_URL}/api/search?q=${q}&page=${Math.max(1, Number(page) || 1)}`, {
      headers: { Accept: "application/json" },
      responseClass: "json",
    });
    const data = parseJSON(result.body);
    const pages = Math.max(1, Number(data && data.pages) || 1);
    const items = (Array.isArray(data && data.mangas) ? data.mangas : [])
      .map(searchItem)
      .filter(Boolean);
    return { items, page: Math.max(1, Number(page) || 1), hasMore: Math.max(1, Number(page) || 1) < pages };
  }

  async function loadHome(forceRefresh = false) {
    if (!forceRefresh && homeCache.value && Date.now() - homeCache.at < HOME_CACHE_TTL) return homeCache.value;
    const result = await fetchDirect(`${BASE_URL}/`);
    homeCache = { at: Date.now(), value: result.body };
    return result.body;
  }

  function parseHomeTrending(body) {
    const items = [];
    const seen = new Set();
    const pattern = /"title":"([^"]{1,90})"[^}]{0,400}?"slug":"([a-z0-9-]+)"/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const slug = match[2];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const item = searchItem({ slug, title: decodeEntities(match[1]), coverImage: "" });
      if (item) items.push(item);
    }
    return items;
  }

  async function trending() {
    const home = await loadHome();
    return { items: parseHomeTrending(home), page: 1, hasMore: false };
  }

  async function popular(page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    const result = await fetchDirect(
      `${BASE_URL}/api/search?q=&limit=16&page=${currentPage}`,
      {
        headers: { Accept: "application/json" },
        responseClass: "json",
      },
    );
    const data = parseJSON(result.body);
    const pages = Math.max(1, Number(data && data.pages) || 1);
    const items = (Array.isArray(data && data.mangas) ? data.mangas : [])
      .map(searchItem)
      .filter(Boolean);
    return { items, page: currentPage, hasMore: currentPage < pages };
  }

  async function latest(page) {
    const result = await fetchDirect(`${BASE_URL}/api/manga/lastchapters?limit=16&page=${Math.max(1, Number(page) || 1)}`, {
      headers: { Accept: "application/json" },
      responseClass: "json",
    });
    const data = parseJSON(result.body);
    const items = (Array.isArray(data.data) ? data.data : [])
      .map(searchItem)
      .filter(Boolean);
    return { items, page: Math.max(1, Number(page) || 1), hasMore: items.length === 16 };
  }

  function parseMangaObject(body) {
    const text = flightObject(body, "manga", "{", "}");
    return text ? parseJSON(text) : null;
  }

  function parseDetails(body) {
    const manga = parseMangaObject(body);
    if (!manga) throw new Error("Poseidon Scans series page did not include manga data.");
    const slug = String(manga.slug || "").trim();
    const url = `${BASE_URL}/serie/${slug}`;
    const statusFr = String(manga.status || "").trim().toLowerCase();
    const status =
      statusFr.includes("en cours") ? "Ongoing"
      : statusFr === "terminé" || statusFr === "termine" || statusFr === "complet" ? "Completed"
      : statusFr.includes("pause") || statusFr.includes("hiatus") ? "Hiatus"
      : statusFr.includes("annul") || statusFr.includes("abandon") ? "Cancelled"
      : "Unknown";
    const authors = [];
    for (const field of [String(manga.author || ""), String(manga.artist || "")]) {
      const name = decodeEntities(field.trim());
      if (name && !authors.includes(name)) authors.push(name);
    }
    const genres = Array.isArray(manga.categories)
      ? manga.categories
          .map((category) => decodeEntities(String(category && category.name || "").trim()))
          .filter(Boolean)
      : [];
    return {
      id: url,
      href: url,
      url,
      title: decodeEntities(String(manga.title || "").trim()),
      description: decodeEntities(String(manga.description || "").trim()),
      image: coverURL(slug, manga.coverImage),
      authors,
      author: authors.join(", "),
      genres,
      status,
    };
  }

  function chapterIsFree(raw) {
    if (!raw || raw.isPremium !== true) return true;
    const until = normalizeDate(raw.premiumUntil);
    if (!until) return false;
    return new Date(until).getTime() <= Date.now();
  }

  function parseChapters(body, seriesUrl) {
    const manga = parseMangaObject(body);
    const chapters = manga && Array.isArray(manga.chapters) ? manga.chapters : [];
    const output = [];
    const slug = seriesSlug(seriesUrl);
    for (const raw of chapters) {
      const number = Number(raw && raw.number);
      if (!Number.isFinite(number)) continue;
      if (!chapterIsFree(raw)) continue;
      const url = `${BASE_URL}/serie/${slug}/chapter/${formatChapterNumber(number)}`;
      output.push({
        id: url,
        href: url,
        url,
        title: chapterTitle(raw),
        number,
        releaseDate: normalizeDate(raw.createdAt),
        language: LANGUAGE,
      });
    }
    output.sort((left, right) => right.number - left.number);
    return output;
  }

  function parseImages(body) {
    const currentText = flightObject(body, "currentChapter", "{", "}");
    const current = currentText ? parseJSON(currentText) : {};
    const initialText = flightObject(body, "initialData", "{", "}");
    let raw = [];
    if (initialText) {
      const initial = parseJSON(initialText);
      if (Array.isArray(initial.images)) raw = initial.images;
    }
    const images = raw
      .map((page, index) => ({
        url: readerImageURL(String(page.originalUrl || "")),
        order: Number.isFinite(Number(page.order)) ? Number(page.order) : index,
      }))
      .filter((page) => page.url)
      .sort((left, right) => left.order - right.order);
    return { current, images };
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    if (text === "__feed:popular") return popular(page);
    if (text === "__feed:latest") return latest(page);
    return searchRequest(text, page);
  }

  async function extractDetails(id) {
    const slug = seriesSlug(id);
    const result = await fetchDirect(`${BASE_URL}/serie/${slug}`);
    return parseDetails(result.body);
  }

  async function extractChapters(id) {
    const slug = seriesSlug(id);
    const seriesUrl = `${BASE_URL}/serie/${slug}`;
    let chapters = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chapters.length; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      const result = await fetchDirect(
        `${BASE_URL}/serie/${slug}`,
        { headers: attempt > 1 ? { "Cache-Control": "no-cache", "RSC": "1" } : {} },
      );
      chapters = parseChapters(result.body, seriesUrl);
    }
    if (!chapters.length) {
      throw new Error("Poseidon Scans series page returned no chapter list.");
    }
    return chapters;
  }

  async function extractImages(id) {
    const input = String(id || "").trim();
    if (!/^https?:\/\/poseidon-scans\.net\/serie\/[^/?#]+\/chapter\/[0-9.]+$/i.test(input)) {
      throw new Error("Invalid Poseidon Scans chapter identifier.");
    }
    const chapterURL = absoluteURL(input);
    // The app gives each handler one bounded runtime window. Do not retry a
    // chapter page inside the handler: fetchDirect's normal retry policy can
    // otherwise turn one slow request into several sequential requests and
    // make a valid download appear as a generic app timeout. Image files are
    // downloaded separately by the app and retain their own request headers.
    const result = await fetchDirect(chapterURL, {
      maxAttempts: 1,
      maxBytesHint: 16 * 1024 * 1024,
    });
    const parsed = parseImages(result.body);
    const locked = parsed.current.isPremium === true;
    const pages = parsed.images;
    if (!pages.length && locked) {
      throw new Error("This chapter is Premium and requires a Poseidon Scans account.");
    }
    if (!pages.length) {
      throw new Error("This chapter returned no readable page images.");
    }
    return pages.map((page) => ({
      url: page.url,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `${chapterURL}`,
      },
    }));
  }

  async function discoveryHome() {
    const [popularResult, latestResult, trendingResult] = await Promise.all([popular(1), latest(1), trending()]);
    return {
      sections: [
        { id: "trending", title: "Populaire aujourd'hui", items: trendingResult.items },
        { id: "popular", title: "Toutes les séries", items: popularResult.items },
        { id: "latest", title: "Derniers chapitres", items: latestResult.items },
      ].filter((section) => section.items.length),
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase();
    if (feed === "popular") return popular(page);
    if (feed === "latest") return latest(page);
    if (feed === "trending") return trending();
    return { items: [], page: Math.max(1, Number(page) || 1), hasMore: false };
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
