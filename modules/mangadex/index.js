"use strict";

(() => {
  const BASE_URL = "https://api.mangadex.org";
  const COVER_BASE = "https://uploads.mangadex.org/covers";
  const ALLOWED_RATINGS = ["safe", "suggestive"];
  const SEARCH_LIMIT = 24;
  const CHAPTER_PAGE_LIMIT = 500;
  const MAX_CHAPTER_PAGES = 20;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DEFAULT_HEADERS = { Accept: "application/json" };

  async function responseJSON(response) {
    if (response && typeof response.json === "function") {
      try {
        return await response.json();
      } catch (_) {
        // Fall through to the defensive parser below.
      }
    }
    const body = typeof response.body === "string" ? response.body : "";
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error("MangaDex returned invalid JSON.");
    }
  }

  async function fetchJSON(url) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("MangaDex requires the fetchv2 bridge.");
    }
    const response = await globalThis.fetchv2(url, DEFAULT_HEADERS, "GET", null, {
      followRedirects: true,
      maxBytesHint: 4 * 1024 * 1024,
      responseClass: "json",
    });
    const status = Number(response && response.status);
    if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`MangaDex request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) {
      throw new Error(`MangaDex response was dropped: ${response.dropReason || "size policy"}.`);
    }
    const payload = await responseJSON(response);
    if (!payload || payload.result === "error") {
      const detail = payload && Array.isArray(payload.errors) && payload.errors.length
        ? payload.errors.map((entry) => entry && entry.detail).filter(Boolean).join("; ")
        : "unknown error";
      throw new Error(`MangaDex API error: ${detail}`);
    }
    return payload;
  }

  function queryString(pairs) {
    return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  }

  function withContentRating(params) {
    ALLOWED_RATINGS.forEach((rating) => params.push(["contentRating[]", rating]));
    return params;
  }

  function normalizeMangaID(value) {
    const input = String(value || "").trim();
    const match = input.match(/mangadex\.org\/title\/([0-9a-f-]{36})/i);
    const candidate = match ? match[1] : input;
    if (!UUID_PATTERN.test(candidate)) throw new Error("Invalid MangaDex manga identifier.");
    return candidate.toLowerCase();
  }

  function normalizeChapterID(value) {
    const input = String(value || "").trim();
    const match = input.match(/mangadex\.org\/chapter\/([0-9a-f-]{36})/i);
    const candidate = match ? match[1] : input;
    if (!UUID_PATTERN.test(candidate)) throw new Error("Invalid MangaDex chapter identifier.");
    return candidate.toLowerCase();
  }

  function firstLocaleValue(map) {
    if (!map || typeof map !== "object") return "";
    const preferred = ["en", "en-us", "ja-ro", "ko-ro", "zh-ro"];
    for (const key of preferred) {
      if (typeof map[key] === "string" && map[key].trim()) return map[key].trim();
    }
    const values = Object.values(map).filter((value) => typeof value === "string" && value.trim());
    return values.length ? values[0].trim() : "";
  }

  function titleFrom(attributes) {
    const primary = firstLocaleValue(attributes.title);
    if (primary) return primary;
    const altTitles = Array.isArray(attributes.altTitles) ? attributes.altTitles : [];
    for (const entry of altTitles) {
      const value = firstLocaleValue(entry);
      if (value) return value;
    }
    return "";
  }

  function relationshipsOfType(relationships, type) {
    return (Array.isArray(relationships) ? relationships : []).filter((entry) => entry && entry.type === type);
  }

  function coverURL(mangaID, relationships) {
    const cover = relationshipsOfType(relationships, "cover_art")[0];
    const fileName = cover && cover.attributes && cover.attributes.fileName;
    // Prefer the 256px derivative so cover grids never download multi‑MB art.
    return fileName ? `${COVER_BASE}/${mangaID}/${fileName}.256.jpg` : null;
  }

  function creatorNames(relationships) {
    const names = [...relationshipsOfType(relationships, "author"), ...relationshipsOfType(relationships, "artist")]
      .map((entry) => entry && entry.attributes && entry.attributes.name)
      .filter(Boolean);
    return Array.from(new Set(names));
  }

  function mapStatus(value) {
    switch (String(value || "").toLowerCase()) {
      case "ongoing": return "Ongoing";
      case "completed": return "Completed";
      case "hiatus": return "Hiatus";
      case "cancelled": return "Cancelled";
      default: return "Unknown";
    }
  }

  function genreNames(tags) {
    return (Array.isArray(tags) ? tags : [])
      .filter((tag) => tag && tag.attributes && ["genre", "theme", "format"].includes(tag.attributes.group))
      .map((tag) => firstLocaleValue(tag.attributes.name))
      .filter(Boolean);
  }

  function summaryFrom(manga) {
    const attributes = manga.attributes || {};
    if (!ALLOWED_RATINGS.includes(String(attributes.contentRating || "").toLowerCase())) return null;
    const title = titleFrom(attributes);
    if (!title) return null;
    const href = `https://mangadex.org/title/${manga.id}`;
    return {
      id: manga.id,
      href,
      url: href,
      title,
      image: coverURL(manga.id, manga.relationships),
      description: firstLocaleValue(attributes.description),
      author: creatorNames(manga.relationships).join(", "),
      genres: genreNames(attributes.tags),
      status: mapStatus(attributes.status),
    };
  }

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const offset = (currentPage - 1) * SEARCH_LIMIT;
    const params = [];
    if (query === "__feed:popular") {
      params.push(["order[followedCount]", "desc"]);
    } else if (query === "__feed:latest") {
      params.push(["order[latestUploadedChapter]", "desc"]);
    } else {
      const text = String(query || "").trim().slice(0, 200);
      if (text) params.push(["title", text]);
      params.push(["order[relevance]", "desc"]);
    }
    // Prefer titles that actually have English chapters the app can open.
    params.push(
      ["hasAvailableChapters", "true"],
      ["availableTranslatedLanguage[]", "en"],
      ["limit", String(SEARCH_LIMIT)],
      ["offset", String(offset)],
      ["includes[]", "cover_art"],
    );
    withContentRating(params);
    return `${BASE_URL}/manga?${queryString(params)}`;
  }

  async function searchResults(query, page = 1) {
    const payload = await fetchJSON(searchURL(query, page));
    const items = (Array.isArray(payload.data) ? payload.data : []).map(summaryFrom).filter(Boolean);
    const offset = Number(payload.offset) || 0;
    const total = Number(payload.total) || 0;
    const returned = Array.isArray(payload.data) ? payload.data.length : 0;
    return { items, hasMore: offset + returned < total };
  }

  async function extractDetails(id) {
    const mangaID = normalizeMangaID(id);
    const params = [
      ["includes[]", "cover_art"],
      ["includes[]", "author"],
      ["includes[]", "artist"],
    ];
    const payload = await fetchJSON(`${BASE_URL}/manga/${mangaID}?${queryString(params)}`);
    const manga = payload.data;
    if (!manga || !manga.attributes) throw new Error("MangaDex details were empty.");
    const summary = summaryFrom(manga);
    if (!summary) throw new Error("MangaDex title is missing or excluded by the module content policy.");
    return {
      ...summary,
      authors: creatorNames(manga.relationships),
    };
  }

  function chapterFrom(chapter) {
    const attributes = chapter.attributes || {};
    if (attributes.isUnavailable === true) return null;
    // External-only chapters cannot be opened through MangaDex@Home.
    if (attributes.externalUrl) return null;
    if (attributes.pages === 0) return null;
    const href = `https://mangadex.org/chapter/${chapter.id}`;
    const number = Number(attributes.chapter);
    const chapterTitle = String(attributes.title || "").trim();
    const label = Number.isFinite(number) ? `Chapter ${number}` : "Chapter";
    return {
      id: href,
      href,
      url: href,
      title: chapterTitle ? `${label}: ${chapterTitle}` : label,
      number: Number.isFinite(number) ? number : null,
      releaseDate: attributes.readableAt || attributes.publishAt || null,
      language: String(attributes.translatedLanguage || "en"),
    };
  }

  async function extractChapters(id) {
    const mangaID = normalizeMangaID(id);
    // contentRating is for manga listings; chapter feed uses translatedLanguage.
    const baseParams = [
      ["translatedLanguage[]", "en"],
      ["order[chapter]", "asc"],
      ["order[volume]", "asc"],
      ["limit", String(CHAPTER_PAGE_LIMIT)],
    ];

    let offset = 0;
    let total = Infinity;
    const chapters = [];
    const seen = new Set();
    try {
      for (let page = 0; page < MAX_CHAPTER_PAGES && offset < total; page += 1) {
        const params = [...baseParams, ["offset", String(offset)]];
        const payload = await fetchJSON(`${BASE_URL}/manga/${mangaID}/feed?${queryString(params)}`);
        total = Number(payload.total) || 0;
        const batch = Array.isArray(payload.data) ? payload.data : [];
        for (const entry of batch) {
          const mapped = chapterFrom(entry);
          if (!mapped || seen.has(mapped.id)) continue;
          chapters.push(mapped);
          seen.add(mapped.id);
        }
        offset += CHAPTER_PAGE_LIMIT;
        if (typeof globalThis.reportProgress === "function") {
          await globalThis.reportProgress({ stage: "chapters", completed: Math.min(offset, total), total });
        }
        if (batch.length === 0) break;
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      throw new Error(
        `MangaDex chapter feed failed for this title (${message}). It may be restricted, external-only, or temporarily unavailable.`,
      );
    }
    if (!chapters.length) {
      throw new Error(
        "MangaDex returned no English chapters hosted on MangaDex@Home for this title (they may be external-only or restricted).",
      );
    }
    return chapters;
  }

  async function extractImages(id) {
    const chapterID = normalizeChapterID(id);
    const payload = await fetchJSON(`${BASE_URL}/at-home/server/${chapterID}`);
    const baseUrl = String(payload.baseUrl || "");
    const hash = payload.chapter && payload.chapter.hash;
    const fullQuality = (payload.chapter && Array.isArray(payload.chapter.data)) ? payload.chapter.data : [];
    const dataSaver = (payload.chapter && Array.isArray(payload.chapter.dataSaver)) ? payload.chapter.dataSaver : [];
    if (!baseUrl.startsWith("https://") || !hash) {
      throw new Error("MangaDex returned an invalid MangaDex@Home server response.");
    }
    // Prefer data-saver in-app for reliability and size on mobile networks.
    const files = dataSaver.length
      ? dataSaver.map((name) => ({ name, quality: "data-saver" }))
      : fullQuality.map((name) => ({ name, quality: "data" }));
    if (!files.length) {
      throw new Error("MangaDex chapter has no readable pages on MangaDex@Home.");
    }
    return files.map(({ name, quality }) => ({
      url: `${baseUrl}/${quality}/${hash}/${name}`,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*",
        Referer: "https://mangadex.org/",
      },
    }));
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      searchResults("__feed:popular", 1),
      searchResults("__feed:latest", 1),
    ]);
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest Updates", items: latest.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
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
