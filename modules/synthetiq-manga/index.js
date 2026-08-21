"use strict";

(() => {
  // Books adapter for the existing Synthetiq Manga thin client. The API returns
  // CDN page URLs plus request headers; preserve both for protected image hosts.
  const API_BASE = "https://one.synthetiq.uk/manga";
  const API_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    Referer: "https://weebcentral.com/",
    "User-Agent": API_HEADERS["User-Agent"],
  };

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") return String(await response.text() || "");
    return "";
  }

  async function request(path) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("Synthetiq Manga requires the Books network bridge.");
    }
    const response = await globalThis.fetchv2(
      `${API_BASE}${path}`,
      API_HEADERS,
      "GET",
      null,
      {
        followRedirects: true,
        maxBytesHint: 2 * 1024 * 1024,
        responseClass: "json",
      },
    );
    const status = Number(response && response.status);
    if (!response || response.ok === false || status < 200 || status >= 300) {
      throw new Error(`Synthetiq Manga request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) {
      throw new Error(`Synthetiq Manga response was dropped: ${response.dropReason || "size policy"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error("Synthetiq Manga returned an empty response.");
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Synthetiq Manga returned invalid JSON.");
    }
  }

  function text(value, fallback = "") {
    const normalized = String(value == null ? "" : value).trim();
    return normalized || fallback;
  }

  function mapCard(item) {
    const id = text(item && (item.id || item.href || item.seriesId));
    if (!id) return null;
    const image = text(item.image || item.posterUrl);
    return {
      id,
      href: id,
      title: text(item.title, "Untitled"),
      image,
      posterUrl: image,
      description: text(item.description),
      status: text(item.status),
      type: text(item.type),
      chapterCount: Number(item.chapterCount) || 0,
      cachedChapterCount: Number(item.cachedChapterCount) || 0,
      fast: Boolean(item.fast || item.streamCached || item.cached),
    };
  }

  function mapCards(items) {
    return (Array.isArray(items) ? items : []).map(mapCard).filter(Boolean);
  }

  function chapterNumber(chapter, index) {
    const direct = Number(chapter && (chapter.number ?? chapter.chapterNumber));
    if (Number.isFinite(direct)) return direct;
    const match = text(chapter && chapter.title).match(/(?:chapter|chap|ch\\.?)\\s*[:#.-]?\\s*(\\d+(?:\\.\\d+)?)/i);
    return match ? Number(match[1]) : index + 1;
  }

  async function feed(page) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const data = await request(`/v1/discovery/feed?feedId=more-fast&page=${encodeURIComponent(requestedPage)}`);
    return {
      items: mapCards(data.items),
      page: requestedPage,
      hasMore: Boolean(data.hasMore),
    };
  }

  async function searchResults(query, page = 1) {
    const raw = text(query);
    if (raw === "__feed:popular" || raw === "__feed:latest" || raw === "__feed:niche") {
      return feed(page);
    }
    if (!raw) return feed(page);
    const data = await request(`/v1/search?q=${encodeURIComponent(raw)}`);
    return { items: mapCards(data.items), page: 1, hasMore: false };
  }

  async function extractDetails(seriesID) {
    const data = await request(`/v1/details?id=${encodeURIComponent(text(seriesID))}`);
    const image = text(data.image || data.posterUrl);
    return {
      id: text(seriesID),
      title: text(data.title, "Untitled"),
      description: text(data.description, "No description available."),
      image,
      posterUrl: image,
      status: text(data.status),
      type: text(data.type),
      author: text(data.author),
      genres: Array.isArray(data.genres) ? data.genres.map((genre) => text(genre)).filter(Boolean) : [],
    };
  }

  async function extractChapters(seriesID) {
    const data = await request(`/v1/chapters?id=${encodeURIComponent(text(seriesID))}`);
    return (Array.isArray(data.items) ? data.items : [])
      .map((chapter, index) => {
        const id = text(chapter && (chapter.id || chapter.href));
        if (!id) return null;
        const number = chapterNumber(chapter, index);
        return {
          id,
          href: id,
          number,
          chapterNumber: number,
          title: text(chapter.title, `Chapter ${number}`),
          pageCount: Number(chapter.pageCount) || 0,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
  }

  function safeHeaders(value) {
    const headers = value && typeof value === "object" ? value : {};
    const output = { ...IMAGE_HEADERS };
    for (const [key, headerValue] of Object.entries(headers)) {
      const name = text(key);
      const normalized = text(headerValue);
      if (name && normalized) output[name] = normalized;
    }
    return output;
  }

  async function extractImages(chapterID) {
    const data = await request(`/v1/pages?id=${encodeURIComponent(text(chapterID))}`);
    const pages = Array.isArray(data.pages) ? data.pages : (Array.isArray(data.images) ? data.images : []);
    const headers = safeHeaders(data.headers);
    const imageRequests = pages
      .map((page) => typeof page === "string" ? page : text(page && (page.url || page.src || page.image)))
      .map((url) => text(url))
      .filter(Boolean)
      .map((url) => ({ url, headers }));
    if (!imageRequests.length) throw new Error("Synthetiq Manga returned no readable pages for this chapter.");
    return imageRequests;
  }

  async function discoveryHome() {
    const data = await request("/v1/discovery/home");
    const sections = (Array.isArray(data.sections) ? data.sections : [])
      .map((section) => {
        const items = mapCards(section.items);
        return items.length ? {
          id: text(section.id),
          title: text(section.title, "Synthetiq Manga"),
          style: text(section.style, "poster"),
          items,
        } : null;
      })
      .filter(Boolean);
    return { sections };
  }

  async function discoveryFeed(_feedID, page = 1) {
    return feed(page);
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
