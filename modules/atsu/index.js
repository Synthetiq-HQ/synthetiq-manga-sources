"use strict";

(() => {
  const BASE_URL = "https://atsu.moe";
  const SEARCH_URL = `${BASE_URL}/collections/manga/documents/search`;
  const PAGE_SIZE = 24;
  const DEFAULT_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Referer: `${BASE_URL}/`,
  };

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
    const response = await globalThis.fetchv2(url, DEFAULT_HEADERS, "GET", null, {
      followRedirects: true,
      maxBytesHint: 2 * 1024 * 1024,
      responseClass,
    });
    if (!response || response.bodyDropped) {
      throw new Error("Atsu response exceeded the module safety limit.");
    }
    if (response.ok === false || (response.status && (response.status < 200 || response.status >= 300))) {
      throw new Error(`Atsu request failed with HTTP ${response.status || "error"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error("Atsu returned an empty response.");
    if (/cf-chl|just a moment|attention required/i.test(body)) {
      throw new Error("Atsu requires a browser challenge before it can respond.");
    }
    return body;
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
    return {
      id,
      href: `${BASE_URL}/manga/${encodeURIComponent(id)}`,
      title,
      image: assetURL(item.posterSmall || item.smallImage || item.posterMedium || item.mediumImage || item.poster || item.image),
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

  async function catalogue(query, page) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const params = new URLSearchParams({
      q: nonEmpty(query) || "*",
      query_by: "title,englishTitle,otherNames,authors",
      include_fields: "id,title,englishTitle,poster,posterSmall,posterMedium,type,isAdult",
      page: String(requestedPage),
      per_page: String(PAGE_SIZE),
    });
    const payload = await requestJSON(`${SEARCH_URL}?${params.toString()}`);
    return {
      items: cards(payload.hits),
      hasMore: requestedPage * PAGE_SIZE < Number(payload.found || 0),
    };
  }

  async function popular() {
    const payload = await requestJSON(`${BASE_URL}/api/search/popular`);
    return { items: cards(payload.items || payload), hasMore: false };
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
    const genres = (Array.isArray(manga.tags) ? manga.tags : [])
      .map((tag) => nonEmpty(tag?.name || tag))
      .filter(Boolean)
      .slice(0, 30);
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

  async function searchResults(query, page = 1) {
    const normalized = nonEmpty(query);
    if (normalized === "__feed:popular") return popular();
    // The site does not expose an update feed. Return an honest empty page
    // instead of labelling popular titles as latest updates.
    if (normalized === "__feed:latest") return { items: [], hasMore: false };
    return catalogue(normalized, page);
  }

  async function extractDetails(value) {
    const id = mangaID(value);
    const html = await request(`${BASE_URL}/manga/${encodeURIComponent(id)}`, "html");
    return detailsFromManga(mangaPageFromHTML(html), id);
  }

  async function extractChapters(value) {
    const id = mangaID(value);
    const payload = await requestJSON(`${BASE_URL}/api/manga/info?mangaId=${encodeURIComponent(id)}`);
    const chapters = Array.isArray(payload.chapters) ? payload.chapters : [];
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
    const explore = await catalogue("", 1);
    return {
      sections: [
        { id: "popular", title: "Popular", items: popularItems.items },
        { id: "explore", title: "Explore", items: explore.items },
      ].filter((section) => section.items.length),
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (String(feedID) === "popular") return popular();
    if (String(feedID) !== "explore") return { items: [], page: Math.max(1, Number(page) || 1), hasMore: false };
    const result = await catalogue("", page);
    return { ...result, page: Math.max(1, Number(page) || 1) };
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    discoveryHome,
    discoveryFeed,
  };
  Object.assign(globalThis, handlers);
  globalThis.SynthetiqModule = handlers;
})();
