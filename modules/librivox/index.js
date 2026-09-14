"use strict";

(() => {
  // LibriVox exposes a documented JSON catalogue. Each audiobook section is
  // one stable chapter and one independently streamable MP3 track.
  const BASE_URL = "https://librivox.org";
  const API_URL = `${BASE_URL}/api/feed/audiobooks/`;
  const PAGE_SIZE = 24;
  const API_LIMIT = PAGE_SIZE + 1;
  const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  const MAX_ATTEMPTS = 3;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const DEFAULT_HEADERS = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const bookCache = new Map();
  const bookLoads = new Map();
  const MAX_CACHED_BOOKS = 8;

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function stripHTML(value) {
    return text(value)
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function list(value) {
    if (Array.isArray(value)) return value.flatMap((entry) => list(entry)).filter(Boolean);
    if (value && typeof value === "object") {
      const name = [value.name, value.title, value.first_name && value.last_name ? `${value.first_name} ${value.last_name}` : ""]
        .map(text)
        .find(Boolean);
      return name ? [stripHTML(name)] : [];
    }
    const item = stripHTML(value);
    return item ? [item] : [];
  }

  function unique(values) {
    return [...new Set(values.map(text).filter(Boolean))];
  }

  function first(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function normalizedBookID(value) {
    const input = text(value);
    const match = input.match(/[?&]id=(\d+)/i) || input.match(/(?:^|:)book:(\d+)(?::|$)/i);
    const id = match ? match[1] : input;
    if (!/^\d{1,10}$/.test(id) || Number(id) < 1) throw new Error("Invalid LibriVox audiobook identifier.");
    return id;
  }

  function sectionID(bookID, sectionNumber) {
    const id = normalizedBookID(bookID);
    const number = Number(sectionNumber);
    if (!Number.isInteger(number) || number < 1 || number > 10000) return "";
    return `librivox:book:${id}:section:${number}`;
  }

  function parseSectionID(value) {
    const match = text(value).match(/^librivox:book:(\d{1,10}):section:(\d{1,5})$/i);
    if (!match) throw new Error("Invalid LibriVox audiobook section identifier.");
    return { bookID: normalizedBookID(match[1]), number: Number(match[2]) };
  }

  function safeURL(value, kind) {
    const input = text(value);
    if (!input) return null;
    try {
      const url = new URL(input, BASE_URL);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      const librivoxHost = host === "librivox.org" || host.endsWith(".librivox.org");
      const archiveHost = host === "archive.org" || host.endsWith(".archive.org");
      if (kind === "source" && !librivoxHost) return null;
      if (kind === "media" && !archiveHost && !librivoxHost) return null;
      if (!kind && !librivoxHost && !archiveHost) return null;
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  function sourceURL(book) {
    return safeURL(book && (book.url_librivox || book.url || book.href), "source")
      || `${API_URL}?id=${encodeURIComponent(normalizedBookID(book && book.id))}&format=json`;
  }

  function authorsFor(book) {
    const values = unique(list(book && (book.authors || book.author)));
    return values.length ? values : [];
  }

  function genresFor(book) {
    return unique(list(book && (book.genres || book.genre)));
  }

  function responseBody(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function responseJSON(response) {
    if (response && response.bodyDropped) {
      throw new Error(`LibriVox response was dropped: ${response.dropReason || "size limit"}.`);
    }
    if (response && typeof response.json === "function") {
      try {
        return await response.json();
      } catch (_) {
        // Some app bridges expose text only even when the response is JSON.
      }
    }
    if (response && typeof response.text === "function") {
      const body = await response.text();
      try {
        return JSON.parse(body);
      } catch (_) {
        throw new Error("LibriVox returned invalid JSON.");
      }
    }
    try {
      return JSON.parse(responseBody(response));
    } catch (_) {
      throw new Error("LibriVox returned an empty or invalid JSON response.");
    }
  }

  async function requestJSON(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("LibriVox requires the fetchv2 bridge.");
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(800 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          "GET",
          null,
          {
            followRedirects: true,
            maxBytesHint: MAX_RESPONSE_BYTES,
            responseClass: "json",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`LibriVox request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        return await responseJSON(response);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError || new Error("LibriVox request failed.");
  }

  function booksFrom(payload) {
    if (Array.isArray(payload && payload.books)) return payload.books;
    if (payload && payload.books && Array.isArray(payload.books.book)) return payload.books.book;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function itemFor(book) {
    const id = normalizedBookID(book && book.id);
    const authors = authorsFor(book);
    return {
      id,
      href: sourceURL(book),
      url: sourceURL(book),
      title: stripHTML(book && book.title) || `LibriVox audiobook ${id}`,
      image: safeURL(book && (book.coverart_thumbnail || book.coverart_jpg), "media"),
      description: stripHTML(book && book.description),
      author: authors.join(", "),
      genres: genresFor(book),
    };
  }

  function pageResult(payload, page) {
    const rawBooks = booksFrom(payload);
    const offset = (Math.max(1, Number(page) || 1) - 1) * PAGE_SIZE;
    const items = rawBooks.slice(0, PAGE_SIZE).map(itemFor);
    const total = Number(payload && (payload.totalItems || payload.total || payload.numFound));
    const hasMore = rawBooks.length > PAGE_SIZE || (Number.isFinite(total) && total > offset + items.length);
    return { items, hasMore };
  }

  async function fetchCatalogue(params) {
    const url = new URL(API_URL);
    url.searchParams.set("format", "json");
    url.searchParams.set("coverart", "1");
    url.searchParams.set("limit", String(API_LIMIT));
    url.searchParams.set("offset", String(params.offset || 0));
    if (params.title) url.searchParams.set("title", params.title);
    return requestJSON(url.toString());
  }

  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const raw = typeof query === "string" ? query : String((query && (query.text || query.query)) || "");
    const value = raw.trim();
    const params = {
      offset: (requestedPage - 1) * PAGE_SIZE,
      title: value && !value.startsWith("__feed:") ? value.slice(0, 160) : "",
    };
    return pageResult(await fetchCatalogue(params), requestedPage);
  }

  async function fetchBook(bookID) {
    const id = normalizedBookID(bookID);
    if (bookCache.has(id)) {
      const cached = bookCache.get(id);
      bookCache.delete(id);
      bookCache.set(id, cached);
      return cached;
    }
    if (bookLoads.has(id)) return bookLoads.get(id);
    const load = (async () => {
      const url = new URL(API_URL);
      url.searchParams.set("format", "json");
      url.searchParams.set("coverart", "1");
      url.searchParams.set("extended", "1");
      url.searchParams.set("id", id);
      const books = booksFrom(await requestJSON(url.toString()));
      const book = books.find((candidate) => normalizedBookID(candidate && candidate.id) === id);
      if (!book) throw new Error("LibriVox audiobook was not found.");
      const sections = Array.isArray(book.sections) ? book.sections : [];
      if (!sections.length) throw new Error("LibriVox audiobook has no playable sections.");
      const result = { book, sections };
      bookCache.set(id, result);
      while (bookCache.size > MAX_CACHED_BOOKS) bookCache.delete(bookCache.keys().next().value);
      return result;
    })();
    bookLoads.set(id, load);
    try {
      return await load;
    } finally {
      bookLoads.delete(id);
    }
  }

  function sectionNumber(section) {
    const value = Number(section && (section.section_number || section.sectionNumber || section.number));
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  function sectionURL(section) {
    return safeURL(section && (section.listen_url || section.url || section.href), "media");
  }

  function durationSeconds(section) {
    const direct = Number(section && (section.playtimesecs || section.playtime_seconds || section.duration));
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parts = text(section && (section.playtime || section.durationText)).split(":").map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
    return null;
  }

  function chaptersFor(bookID, sections) {
    const language = text((sections[0] && sections[0].language) || (bookID && bookID.language) || "und") || "und";
    return sections
      .map((section) => {
        const number = sectionNumber(section);
        const id = sectionID(bookID, number);
        if (!id || !sectionURL(section)) return null;
        return {
          id,
          href: id,
          url: id,
          title: stripHTML(section.title) || `Section ${number}`,
          number,
          releaseDate: text(section.release_date || section.releaseDate) || null,
          language: text(section.language) || language,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.number - right.number);
  }

  async function extractDetails(id) {
    const result = await fetchBook(id);
    const book = result.book;
    const base = itemFor(book);
    const authors = authorsFor(book);
    return {
      ...base,
      authors,
      status: "Completed",
      language: text(first(book.language)) || "und",
      chapterCount: result.sections.length,
      duration: Number(book.totaltimesecs) > 0 ? Number(book.totaltimesecs) : null,
    };
  }

  async function extractChapters(id) {
    const result = await fetchBook(id);
    const chapters = chaptersFor(result.book.id, result.sections);
    if (!chapters.length) throw new Error("LibriVox audiobook has no complete playable chapter list.");
    return chapters;
  }

  async function extractAudio(chapterID) {
    const reference = parseSectionID(chapterID);
    const result = await fetchBook(reference.bookID);
    const section = result.sections.find((candidate) => sectionNumber(candidate) === reference.number);
    const url = sectionURL(section);
    if (!section || !url) throw new Error("LibriVox section has no playable HTTPS audio URL.");
    const title = stripHTML(section.title) || `Section ${reference.number}`;
    const duration = durationSeconds(section);
    return {
      tracks: [{
        id: sectionID(reference.bookID, reference.number),
        title,
        url,
        format: "mp3",
        fileName: `${reference.bookID}-section-${reference.number}.mp3`,
        duration,
        part: reference.number,
        track: reference.number,
        language: text(section.language) || text(first(result.book.language)) || "und",
        readers: unique(list(section.readers)).join(", "),
      }],
    };
  }

  async function discoveryHome() {
    const catalogue = await searchResults("__feed:catalogue", 1);
    return { sections: [{ id: "catalogue", title: "LibriVox catalogue", items: catalogue.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    // The app requests the conventional popular/latest feeds for every
    // source. LibriVox has one catalogue, so both aliases use that feed.
    const feed = String(feedID || "").toLowerCase();
    if (!["catalogue", "popular", "latest"].includes(feed)) {
      throw new Error("LibriVox only exposes its documented catalogue feed.");
    }
    return searchResults("__feed:catalogue", page);
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractAudio,
    discoveryHome,
    discoveryFeed,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
