"use strict";

(() => {
  const BASE_URL = "https://atsu.moe";
  const SEARCH_URL = `${BASE_URL}/collections/manga/documents/search`;
  const PAGE_SIZE = 24;
  const DEFAULT_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Referer: `${BASE_URL}/`,
  };
  const MAX_REQUEST_ATTEMPTS = 4;
  const catalogueMetadata = new Map();
  const catalogueCache = new Map();
  const CATALOGUE_CACHE_TTL_MS = 30_000;

  function sleep(milliseconds) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
  }

  function nonEmpty(value) {
    const text = String(value ?? "").trim();
    return text || "";
  }

  function isAdult(item) {
    const value = item?.isAdult;
    return value === true || value === 1 || String(value).toLowerCase() === "true";
  }

  function assetURL(value) {
    const raw = nonEmpty(value);
    if (!raw) return "";
    if (raw.startsWith("https://")) return raw;
    if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
    return `${BASE_URL}/static/${raw.replace(/^static\//, "")}`;
  }

  function mangaID(value) {
    const raw = nonEmpty(value);
    const match = raw.match(/(?:atsu\.moe\/manga\/)?([A-Za-z0-9_-]{3,})\/?(?:[?#].*)?$/i);
    if (!match) throw new Error("Invalid Atsu manga identifier.");
    return match[1];
  }

  function chapterReference(mangaIDValue, chapterID) {
    const manga = mangaID(mangaIDValue);
    const chapter = nonEmpty(chapterID);
    if (!/^[A-Za-z0-9_-]{3,}$/.test(chapter)) {
      throw new Error("Invalid Atsu chapter identifier.");
    }
    return `atsu|${manga}|${chapter}`;
  }

  function parseChapterReference(value) {
    const parts = nonEmpty(value).split("|");
    if (parts.length !== 3 || parts[0] !== "atsu") {
      throw new Error("Invalid Atsu chapter reference.");
    }
    return { mangaID: mangaID(parts[1]), chapterID: nonEmpty(parts[2]) };
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string" && response.body) return response.body;
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return "";
  }

  async function request(url, responseClass) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("Atsu requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(900 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(url, DEFAULT_HEADERS, "GET", null, {
          followRedirects: true,
          maxBytesHint: 2 * 1024 * 1024,
          responseClass,
        });
        if (!response || response.bodyDropped) {
          throw new Error("Atsu response exceeded the module safety limit.");
        }
        const status = Number(response.status || 0);
        if (response.ok === false || (status && (status < 200 || status >= 300))) {
          const error = new Error(`Atsu request failed with HTTP ${status || "error"}.`);
          if ((status === 429 || status >= 500) && attempt < MAX_REQUEST_ATTEMPTS) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const body = await responseText(response);
        if (!body) throw new Error("Atsu returned an empty response.");
        if (/cf-chl|just a moment|attention required/i.test(body)) {
          throw new Error("Atsu requires a browser challenge before it can respond.");
        }
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_REQUEST_ATTEMPTS || !/network|timed?\s*out|connection|HTTP (?:429|5\d\d)/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("Atsu request failed.");
  }

  async function requestJSON(url) {
    const body = await request(url, "json");
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Atsu returned invalid JSON.");
    }
  }

  function card(item) {
    if (!item || isAdult(item)) return null;
    const id = nonEmpty(item.id);
    const title = nonEmpty(item.englishTitle || item.title);
    if (!id || !title) return null;
    const genres = (Array.isArray(item.tags) ? item.tags : [])
      .map((tag) => nonEmpty(tag?.name || tag))
      .filter(Boolean)
      .filter((tag, index, values) => values.indexOf(tag) === index);
    catalogueMetadata.set(id, { genres });
    return {
      id,
      href: `${BASE_URL}/manga/${encodeURIComponent(id)}`,
      title,
      image: assetURL(item.posterSmall || item.smallImage || item.posterMedium || item.mediumImage || item.poster || item.image),
      ...(genres.length ? { genres } : {}),
    };
  }

  function cards(items) {
    const seen = new Set();
    const output = [];
    for (const item of Array.isArray(items) ? items : []) {
      const mapped = card(item?.document || item);
      if (!mapped || seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      output.push(mapped);
    }
    return output;
  }

  async function catalogue(query, page, options = {}) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const params = new URLSearchParams({
      q: nonEmpty(query) || "*",
      query_by: "title,englishTitle,otherNames,authors",
      include_fields: "id,title,englishTitle,poster,posterSmall,posterMedium,type,isAdult,tags,status,authors",
      page: String(requestedPage),
      per_page: String(PAGE_SIZE),
    });
    if (options.sort_by) params.append("sort_by", options.sort_by);
    if (options.filter_by) params.append("filter_by", options.filter_by);
    const url = `${SEARCH_URL}?${params.toString()}`;
    const cached = catalogueCache.get(url);
    let payload;
    if (cached && Date.now() - cached.storedAt < CATALOGUE_CACHE_TTL_MS) {
      payload = cached.payload;
    } else {
      payload = await requestJSON(url);
      catalogueCache.set(url, { storedAt: Date.now(), payload });
      if (catalogueCache.size > 40) {
        catalogueCache.delete(catalogueCache.keys().next().value);
      }
    }
    return {
      items: cards(payload.hits),
      hasMore: requestedPage * PAGE_SIZE < Number(payload.found || 0),
    };
  }

  async function popular(page = 1) {
    return catalogue("*", page, {
      sort_by: "trending:desc",
      filter_by: "isAdult:=false",
    });
  }

  async function latest(page = 1) {
    return catalogue("*", page, {
      sort_by: "dateAdded:desc",
      filter_by: "isAdult:=false",
    });
  }

  function mangaPageFromHTML(html) {
    const match = String(html).match(/window\.mangaPage\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i);
    if (!match) throw new Error("Atsu title page did not include metadata.");
    try {
      return JSON.parse(match[1]).mangaPage;
    } catch {
      throw new Error("Atsu title metadata could not be decoded.");
    }
  }

  function detailsFromManga(manga, id) {
    if (!manga || isAdult(manga)) {
      throw new Error("This title is excluded by the source content policy.");
    }
    const title = nonEmpty(manga.englishTitle || manga.title);
    if (!title) throw new Error("Atsu title metadata did not contain a name.");
    const authors = (Array.isArray(manga.authors) ? manga.authors : [])
      .map((author) => nonEmpty(author?.name || author))
      .filter(Boolean);
    const pageGenres = (Array.isArray(manga.tags) ? manga.tags : [])
      .map((tag) => nonEmpty(tag?.name || tag))
      .filter(Boolean)
      .filter((tag, index, values) => values.indexOf(tag) === index);
    const genres = [...pageGenres];
    for (const tag of catalogueMetadata.get(id)?.genres || []) {
      if (!genres.includes(tag)) genres.push(tag);
    }
    const image = assetURL(
      manga.poster?.smallImage || manga.poster?.mediumImage || manga.poster?.image || manga.posterSmall || manga.smallImage,
    );
    return {
      id,
      href: `${BASE_URL}/manga/${encodeURIComponent(id)}`,
      url: `${BASE_URL}/manga/${encodeURIComponent(id)}`,
      title,
      description: nonEmpty(manga.synopsis || manga.description),
      image,
      authors,
      author: authors.join(", "),
      genres,
      status: nonEmpty(manga.status) || "Unknown",
    };
  }

  async function niche(page) {
    return catalogue("*", page, {
      sort_by: "views:asc",
      filter_by: "isAdult:=false",
    });
  }

  const FALLBACK_TAGS = [
    "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Isekai",
    "Martial Arts", "Mystery", "Psychological", "Romance", "School Life",
    "Sci-Fi", "Seinen", "Shoujo", "Shounen", "Slice of Life", "Sports",
    "Supernatural", "Tragedy",
  ];

  function normalizeSearchQuery(query) {
    if (typeof query === "string" && query.startsWith("__niche__:")) {
      try {
        return normalizeSearchQuery(JSON.parse(query.slice("__niche__:".length)));
      } catch {
        // fall through
      }
    }
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const tags = Array.isArray(query.tags)
        ? query.tags.map((t) => nonEmpty(typeof t === "object" ? (t.name || t.id || "") : t)).filter(Boolean)
        : [];
      const excludeTags = Array.isArray(query.excludeTags)
        ? query.excludeTags.map((t) => nonEmpty(typeof t === "object" ? (t.name || t.id || "") : t)).filter(Boolean)
        : [];
      return {
        text: nonEmpty(query.text || query.query || ""),
        tags,
        excludeTags,
        status: nonEmpty(query.status),
      };
    }
    return { text: nonEmpty(query), tags: [], excludeTags: [], status: "" };
  }

  function filterValue(value) {
    return `\`${nonEmpty(value).replace(/`/g, "")}\``;
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    if (normalized.text === "__feed:popular" && !normalized.tags.length) return popular(page);
    if (normalized.text === "__feed:niche" && !normalized.tags.length) return niche(page);
    if (normalized.text === "__feed:latest" && !normalized.tags.length) return latest(page);

    const filters = ["isAdult:=false"];
    for (const tag of normalized.tags) {
      filters.push(`tags:=${filterValue(tag)}`);
    }
    for (const tag of normalized.excludeTags) {
      filters.push(`tags:!=${filterValue(tag)}`);
    }
    if (normalized.status) {
      const status = normalized.status.toLowerCase();
      if (status === "ongoing" || status === "publishing") filters.push("status:=Ongoing");
      else if (status === "completed" || status === "complete") filters.push("status:=Completed");
    }

    const text = normalized.text && !normalized.text.startsWith("__feed:")
      ? normalized.text
      : (normalized.tags.length || normalized.status ? "*" : normalized.text);
    return catalogue(text || "*", page, {
      filter_by: filters.join(" && "),
      sort_by: text === "*" ? "trending:desc" : undefined,
    });
  }

  async function extractTags() {
    return FALLBACK_TAGS.slice();
  }

  async function extractDetails(value) {
    const id = mangaID(value);
    const html = await request(`${BASE_URL}/manga/${encodeURIComponent(id)}`, "html");
    return detailsFromManga(mangaPageFromHTML(html), id);
  }

  function chapterNumber(chapter) {
    const parsed = Number(chapter?.number);
    return chapter?.number == null || !Number.isFinite(parsed) ? null : parsed;
  }

  function chapterIdentity(chapter) {
    const number = chapterNumber(chapter);
    if (number != null) return `number:${number}`;
    return `special:${nonEmpty(chapter?.title).toLowerCase()}:${nonEmpty(chapter?.id)}`;
  }

  function selectPrimaryScanlation(chapters) {
    const groups = new Map();
    for (const chapter of chapters) {
      const scanID = nonEmpty(chapter?.scanId || chapter?.scanlationMangaId) || "default";
      const group = groups.get(scanID) || [];
      group.push(chapter);
      groups.set(scanID, group);
    }
    if (groups.size <= 1) return chapters;

    const ranked = Array.from(groups.entries()).map(([scanID, items]) => {
      const numeric = items.map(chapterNumber).filter((value) => value != null);
      const identities = new Set(items.map(chapterIdentity));
      const readable = items.filter((item) => Number(item?.pageCount || 0) > 0).length;
      return {
        scanID,
        items,
        coverage: identities.size,
        maxNumber: numeric.length ? Math.max(...numeric) : -1,
        readableRatio: items.length ? readable / items.length : 0,
      };
    });
    const widest = Math.max(...ranked.map((group) => group.coverage));
    const candidates = ranked.filter((group) => group.coverage >= widest * 0.85);
    candidates.sort((left, right) =>
      right.maxNumber - left.maxNumber
      || right.coverage - left.coverage
      || right.readableRatio - left.readableRatio
      || left.scanID.localeCompare(right.scanID),
    );
    return candidates[0]?.items || chapters;
  }

  function deduplicateChapters(chapters) {
    const selected = new Map();
    for (const chapter of chapters) {
      const key = chapterIdentity(chapter);
      const previous = selected.get(key);
      if (!previous) {
        selected.set(key, chapter);
        continue;
      }
      const previousPages = Number(previous?.pageCount || 0);
      const nextPages = Number(chapter?.pageCount || 0);
      const previousDate = Date.parse(previous?.createdAt || "") || 0;
      const nextDate = Date.parse(chapter?.createdAt || "") || 0;
      if (nextPages > previousPages || (nextPages === previousPages && nextDate > previousDate)) {
        selected.set(key, chapter);
      }
    }
    return Array.from(selected.values());
  }

  async function extractChapters(value) {
    const id = mangaID(value);
    const payload = await requestJSON(`${BASE_URL}/api/manga/info?mangaId=${encodeURIComponent(id)}`);
    const allChapters = Array.isArray(payload.chapters) ? payload.chapters : [];
    const chapters = deduplicateChapters(selectPrimaryScanlation(allChapters));
    const seen = new Set();
    const output = [];
    for (const chapter of chapters) {
      const chapterID = nonEmpty(chapter?.id);
      if (!chapterID || seen.has(chapterID)) continue;
      seen.add(chapterID);
      const parsedNumber = Number(chapter.number);
      const number = chapter.number == null || !Number.isFinite(parsedNumber) ? null : parsedNumber;
      const parsedIndex = Number(chapter.index);
      const reference = chapterReference(id, chapterID);
      output.push({
        id: reference,
        href: reference,
        url: reference,
        title: nonEmpty(chapter.title) || `Chapter ${number ?? output.length + 1}`,
        number,
        language: "en",
        _order: Number.isFinite(parsedIndex) ? parsedIndex : Number.MAX_SAFE_INTEGER,
      });
    }
    output.sort((left, right) => left._order - right._order || (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER));
    if (!output.length) throw new Error("Atsu returned no chapters for this title.");
    return output.map(({ _order, ...chapter }) => chapter);
  }

  async function extractImages(value) {
    const chapter = parseChapterReference(value);
    const payload = await requestJSON(
      `${BASE_URL}/api/read/chapter?mangaId=${encodeURIComponent(chapter.mangaID)}&chapterId=${encodeURIComponent(chapter.chapterID)}`,
    );
    const pages = Array.isArray(payload.readChapter?.pages) ? payload.readChapter.pages : [];
    const output = pages
      .slice()
      .sort((left, right) => Number(left?.number || 0) - Number(right?.number || 0))
      .map((page) => assetURL(page?.image))
      .filter((url) => url.startsWith(`${BASE_URL}/static/`))
      .map((url) => ({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          Referer: `${BASE_URL}/`,
        },
      }));
    if (!output.length) throw new Error("Atsu chapter returned no readable page images.");
    return output;
  }

  async function discoveryHome() {
    const popularItems = await popular();
    const latestItems = await latest();
    const nicheItems = await niche(1);
    return {
      sections: [
        { id: "popular", title: "Popular", items: popularItems.items },
        { id: "latest", title: "Latest", items: latestItems.items },
        { id: "niche", title: "Niche Gems", items: nicheItems.items },
      ].filter((section) => section.items.length),
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (String(feedID) === "popular") return popular(page);
    if (String(feedID) === "niche") {
      const result = await niche(page);
      return { ...result, page: Math.max(1, Number(page) || 1) };
    }
    if (String(feedID) !== "latest") return { items: [], page: Math.max(1, Number(page) || 1), hasMore: false };
    const result = await latest(page);
    return { ...result, page: Math.max(1, Number(page) || 1) };
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    extractTags,
    discoveryHome,
    discoveryFeed,
  };
  Object.assign(globalThis, handlers);
  globalThis.SynthetiqModule = handlers;
})();
