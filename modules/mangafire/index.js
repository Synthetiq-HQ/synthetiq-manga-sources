"use strict";

(() => {
  const BASE_URL = "https://mangafire.to";
  const API_LIMIT = 200;
  const MAX_CHAPTER_PAGES = 64;
  const EXCLUDED_GENRE_IDS = [7, 268929, 268930, 268932];
  const API_HEADERS = {
    Accept: "application/json,text/plain,*/*",
    Referer: `${BASE_URL}/`,
    "X-Requested-With": "XMLHttpRequest",
  };
  const MAX_ATTEMPTS = 3;
  // The API rate-limits sustained bursts with 429s; keep a floor between
  // pagev2 calls so a full reader walk stays under the burst budget.
  const MIN_REQUEST_SPACING = 500;
  let lastRequestAt = 0;
  const protectionTokenCache = new Map();

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
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function parseJSON(value) {
    if (value && typeof value === "object") return value;
    const text = String(value || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function JSONFromHTML(html) {
    const pre = String(html || "").match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
    return parseJSON(decodeEntities(pre ? pre[1] : stripHTML(html)));
  }

  function assertAPIURL(value) {
    const target = new URL(String(value || ""));
    if (target.protocol !== "https:" || target.hostname !== "mangafire.to" || !target.pathname.startsWith("/api/")) {
      throw new Error("MangaFire pagev2 requests are restricted to its HTTPS API.");
    }
    return target.toString();
  }

  function protectionValue(value) {
    const text = String(value || "");
    if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(text)) return Number(text);
    if (text === "true") return true;
    if (text === "false") return false;
    return text;
  }

  function protectionRequest(value) {
    const target = new URL(assertAPIURL(value));
    target.searchParams.delete("vrf");
    const params = {};
    for (const [rawKey, rawValue] of target.searchParams.entries()) {
      const isArray = rawKey.endsWith("[]");
      const key = isArray ? rawKey.slice(0, -2) : rawKey;
      const value = protectionValue(rawValue);
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        params[key] = isArray ? [value] : value;
      } else {
        if (!Array.isArray(params[key])) params[key] = [params[key]];
        params[key].push(value);
      }
    }
    return {
      target,
      path: target.pathname,
      params,
      cacheKey: `${target.pathname}?${target.searchParams.toString()}`,
    };
  }

  async function protectedAPIURL(value, forceRefresh = false) {
    const request = protectionRequest(value);
    if (forceRefresh) protectionTokenCache.delete(request.cacheKey);
    let token = protectionTokenCache.get(request.cacheKey) || "";
    if (!token) {
      const pathLiteral = JSON.stringify(request.path);
      const paramsLiteral = JSON.stringify(request.params);
      const snapshot = await globalThis.pagev2({
        url: `${BASE_URL}/`,
        headers: { Accept: "text/html,application/xhtml+xml", Referer: `${BASE_URL}/` },
        userAgent: null,
        timeoutMilliseconds: 15_000,
        settleMilliseconds: 350,
        includeHTML: false,
        captureResponseBodies: false,
        maxEntries: 12,
        maxResponseCharacters: 32_000,
        actionScript: null,
        returnScript: `typeof globalThis.getProtectionToken === "function" ? globalThis.getProtectionToken(${pathLiteral}, ${paramsLiteral}) : null`,
        waitForSelector: "body",
        waitForURLIncludes: null,
        waitForRequestURLIncludes: null,
        waitForResponseURLIncludes: null,
        waitForResponseBodyIncludes: null,
      });
      token = String((snapshot && snapshot.evaluatedData) || "").trim();
      if (!token) throw new Error("MangaFire could not prepare its protected API request.");
      if (protectionTokenCache.size >= 64) {
        protectionTokenCache.delete(protectionTokenCache.keys().next().value);
      }
      protectionTokenCache.set(request.cacheKey, token);
    }
    request.target.searchParams.set("vrf", token);
    return request.target.toString();
  }

  async function pageJSON(url, options = {}) {
    if (typeof globalThis.pagev2 !== "function") {
      throw new Error("MangaFire requires the pagev2 bridge.");
    }
    let target = assertAPIURL(url);
    let lastError = null;
    let refreshedProtection = false;
    // The API answers bursts and cold WebKit sessions with 429/challenge
    // bodies; retry with backoff instead of failing the whole stage.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      const spacingWait = lastRequestAt + MIN_REQUEST_SPACING - Date.now();
      if (spacingWait > 0) await sleep(spacingWait);
      lastRequestAt = Date.now();
      try {
        const snapshot = await globalThis.pagev2({
          url: target,
          headers: { ...API_HEADERS, ...(options.headers || {}) },
          userAgent: null,
          timeoutMilliseconds: options.timeoutMilliseconds || 15_000,
          settleMilliseconds: 75,
          includeHTML: true,
          captureResponseBodies: false,
          maxEntries: 16,
          maxResponseCharacters: 1_000_000,
          actionScript: null,
          returnScript: "document.body ? document.body.innerText : ''",
          waitForSelector: "body",
          waitForURLIncludes: "/api/",
          waitForRequestURLIncludes: null,
          waitForResponseURLIncludes: null,
          waitForResponseBodyIncludes: null,
        });

        let payload = parseJSON(snapshot && snapshot.evaluatedData);
        if (!payload && snapshot && Array.isArray(snapshot.events)) {
          for (let index = snapshot.events.length - 1; index >= 0 && !payload; index -= 1) {
            payload = parseJSON(snapshot.events[index] && snapshot.events[index].body);
          }
        }
        if (!payload && snapshot) payload = JSONFromHTML(snapshot.html);
        if (!payload) {
          throw new Error("MangaFire pagev2 returned no JSON. The source may be challenged or unavailable.");
        }
        const APIMessage = String((payload && (payload.error || payload.message)) || "");
        if (/token/i.test(APIMessage)) {
          target = await protectedAPIURL(url, refreshedProtection);
          refreshedProtection = true;
          lastError = new Error(`MangaFire API authorization changed: ${APIMessage}`);
          continue;
        }
        if (payload.error) throw new Error(`MangaFire API error: ${String(payload.error)}`);
        return payload;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError || new Error("MangaFire request failed.");
  }

  function titlePath(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/mangafire\.to)?\/?title\/([^/?#]+)/i);
    if (match) return `/title/${match[1]}`;
    if (/^[a-z0-9]+(?:-[a-z0-9-]+)?$/i.test(input)) return `/title/${input}`;
    throw new Error("Invalid MangaFire title identifier.");
  }

  function titleHID(value) {
    return titlePath(value).replace("/title/", "").split("-")[0];
  }

  function chapterID(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/mangafire\.to)?\/?title\/[^/?#]+\/chapter\/([0-9]+)/i)
      || input.match(/(?:https:\/\/mangafire\.to)?\/?chapter\/([0-9]+)/i);
    if (match) return match[1];
    if (/^[0-9]+$/.test(input)) return input;
    throw new Error("Invalid MangaFire chapter identifier.");
  }

  function addExcludedGenres(params) {
    EXCLUDED_GENRE_IDS.forEach((id) => params.push(["genres_ex[]", String(id)]));
  }

  function queryString(pairs) {
    return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
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
        ? query.tags.map((t) => String(typeof t === "object" ? (t.name || t.id || "") : t).trim()).filter(Boolean)
        : [];
      const excludeTags = Array.isArray(query.excludeTags)
        ? query.excludeTags.map((t) => String(typeof t === "object" ? (t.name || t.id || "") : t).trim()).filter(Boolean)
        : [];
      return {
        text: String(query.text || query.query || "").trim(),
        tags,
        excludeTags,
        status: String(query.status || "").trim(),
      };
    }
    return { text: String(query || "").trim(), tags: [], excludeTags: [], status: "" };
  }

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const normalized = normalizeSearchQuery(query);
    const text = normalized.text;
    const params = [];
    if (text === "__feed:popular" && !normalized.tags.length && !normalized.status) {
      params.push(["order[views_7d]", "desc"]);
    } else if (text === "__feed:latest" && !normalized.tags.length && !normalized.status) {
      params.push(["order[chapter_updated_at]", "desc"]);
    } else if (text === "__feed:niche" && !normalized.tags.length && !normalized.status) {
      params.push(["order[chapter_updated_at]", "asc"]);
    } else {
      // Genre names as keyword is the most reliable public search surface.
      const keyword = [text && !text.startsWith("__feed:") ? text : "", ...normalized.tags]
        .filter(Boolean)
        .join(" ")
        .slice(0, 200);
      if (keyword) params.push(["keyword", keyword]);
      if (normalized.status) {
        const status = normalized.status.toLowerCase();
        if (status === "ongoing" || status === "publishing") params.push(["status[]", "releasing"]);
        else if (status === "completed" || status === "complete") params.push(["status[]", "finished"]);
      }
    }
    addExcludedGenres(params);
    params.push(["page", String(currentPage)], ["limit", "30"]);
    return `${BASE_URL}/api/titles?${queryString(params)}`;
  }

  function mapStatus(value) {
    switch (String(value || "").toLowerCase()) {
      case "releasing": return "Ongoing";
      case "finished":
      case "completed": return "Completed";
      case "on_hiatus": return "Hiatus";
      case "discontinued": return "Cancelled";
      default: return "Unknown";
    }
  }

  function isExplicitlyExcluded(item) {
    const groups = [item && item.genres, item && item.themes, item && item.demographics];
    return groups.some((group) => Array.isArray(group) && group.some((entry) => EXCLUDED_GENRE_IDS.includes(Number(entry && entry.id))));
  }

  function mapSearchItem(item) {
    if (!item || !item.title || !item.url || isExplicitlyExcluded(item)) return null;
    const path = titlePath(item.url);
    const href = `${BASE_URL}${path}`;
    const poster = item.poster || {};
    return {
      id: href,
      href,
      url: href,
      title: String(item.title),
      image: String(poster.medium || poster.large || poster.small || ""),
      status: mapStatus(item.status),
    };
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    const payload = await pageJSON(searchURL(query, page));
    let items = (Array.isArray(payload.items) ? payload.items : [])
      .map(mapSearchItem)
      .filter(Boolean);
    // Client-side exclude pass when the API only accepts keyword search.
    if (normalized.excludeTags.length) {
      const blocked = new Set(normalized.excludeTags.map((t) => t.toLowerCase()));
      items = items.filter((item) => {
        const hay = `${item.title} ${item.status || ""}`.toLowerCase();
        return ![...blocked].some((tag) => hay.includes(tag));
      });
    }
    return {
      items,
      hasMore: payload.meta
        ? Boolean(payload.meta.hasNext)
        : items.length >= 30,
    };
  }

  async function extractTags() {
    return FALLBACK_TAGS.slice();
  }

  function detailsObject(payload, fallback) {
    const item = payload && payload.data ? payload.data : payload;
    if (!item || !item.title || isExplicitlyExcluded(item)) {
      throw new Error("MangaFire details are missing or excluded by the module content policy.");
    }
    const path = titlePath(item.url || fallback);
    const href = `${BASE_URL}${path}`;
    const poster = item.poster || {};
    const groupTitles = (group) => Array.isArray(group)
      ? group.map((entry) => String((entry && entry.title) || "")).filter(Boolean)
      : [];
    const genres = [...groupTitles(item.genres), ...groupTitles(item.themes), ...groupTitles(item.demographics)];
    const authors = Array.isArray(item.authors)
      ? item.authors.map((author) => String((author && author.title) || "")).filter(Boolean)
      : [];
    return {
      id: href,
      href,
      url: href,
      title: String(item.title),
      description: stripHTML(item.synopsisHtml || item.description || ""),
      image: String(poster.large || poster.medium || poster.small || ""),
      author: authors.join(", "),
      authors,
      genres,
      status: mapStatus(item.status),
    };
  }

  async function extractDetails(id) {
    const hid = titleHID(id);
    return detailsObject(await pageJSON(`${BASE_URL}/api/titles/${encodeURIComponent(hid)}`), id);
  }

  function ISODate(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1_000).toISOString();
  }

  async function canonicalTitlePath(id, hid) {
    const path = titlePath(id);
    if (path.replace("/title/", "").includes("-")) return path;
    const details = detailsObject(await pageJSON(`${BASE_URL}/api/titles/${encodeURIComponent(hid)}`), id);
    return titlePath(details.url);
  }

  function chapterURL(hid, page) {
    const params = [
      ["language", "en"],
      ["sort", "number"],
      ["order", "desc"],
      ["page", String(page)],
      ["limit", String(API_LIMIT)],
    ];
    return `${BASE_URL}/api/titles/${encodeURIComponent(hid)}/chapters?${queryString(params)}`;
  }

  async function extractChapters(id) {
    const hid = titleHID(id);
    const path = await canonicalTitlePath(id, hid);
    const first = await pageJSON(chapterURL(hid, 1));
    const lastPage = Math.max(1, Number(first.meta && first.meta.lastPage) || 1);
    if (lastPage > MAX_CHAPTER_PAGES) {
      throw new Error(`MangaFire chapter list exceeds the ${MAX_CHAPTER_PAGES}-page safety limit.`);
    }

    const responses = [first];
    for (let page = 2; page <= lastPage; page += 1) {
      responses.push(await pageJSON(chapterURL(hid, page)));
      if (typeof globalThis.reportProgress === "function") {
        await globalThis.reportProgress({ stage: "chapters", completed: page, total: lastPage });
      }
    }

    const seen = new Set();
    const chapters = [];
    for (const response of responses) {
      for (const item of Array.isArray(response.items) ? response.items : []) {
        const remoteID = String((item && item.id) || "");
        if (!/^[0-9]+$/.test(remoteID) || seen.has(remoteID)) continue;
        const number = Number(item.number);
        const chapterName = String(item.name || "").trim();
        const label = Number.isFinite(number) ? `Chapter ${number}` : "Chapter";
        const title = chapterName ? `${label}: ${chapterName}` : label;
        const href = `${BASE_URL}${path}/chapter/${remoteID}`;
        chapters.push({
          id: href,
          href,
          url: href,
          title,
          number: Number.isFinite(number) ? number : null,
          releaseDate: ISODate(item.createdAt),
          language: String(item.language || "en"),
          type: String(item.type || ""),
        });
        seen.add(remoteID);
      }
    }
    return chapters;
  }

  function pageDescriptor(value) {
    const object = Array.isArray(value) ? null : value;
    const rawURL = Array.isArray(value) ? value[0] : object && (object.url || object.src || object.image);
    let offset = Number(Array.isArray(value) ? value[2] : object && (object.offset || object.scrambleOffset));
    if (!Number.isFinite(offset) || offset <= 0) offset = 0;
    let url = String(rawURL || "");
    if (!url.startsWith("https://")) return null;
    if (offset > 0 && !/#scrambled_[0-9]+$/i.test(url)) {
      url = `${url.split("#")[0]}#scrambled_${offset}`;
    }
    const marker = url.match(/#scrambled_([0-9]+)$/i);
    if (marker) offset = Number(marker[1]);
    const descriptor = {
      url,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*",
        Referer: `${BASE_URL}/`,
      },
      scrambled: offset > 0,
      scrambleOffset: offset || null,
    };
    if (object) {
      const markerKeys = [
        "algorithm", "isScrambled", "key", "order", "scramble", "scrambled",
        "scrambleKey", "seed", "tileMap", "tiles",
      ];
      markerKeys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(object, key)) descriptor[key] = object[key];
      });
    }
    return descriptor;
  }

  async function extractImages(id) {
    const remoteID = chapterID(id);
    const payload = await pageJSON(`${BASE_URL}/api/chapters/${encodeURIComponent(remoteID)}`);
    const chapter = payload && payload.data ? payload.data : payload;
    const pages = (chapter && Array.isArray(chapter.pages) ? chapter.pages : [])
      .map(pageDescriptor)
      .filter(Boolean);
    if (!pages.length) throw new Error("MangaFire chapter returned no readable image entries.");
    return pages;
  }

  async function discoveryHome() {
    const popular = await searchResults("__feed:popular", 1);
    const latest = await searchResults("__feed:latest", 1);
    const niche = await searchResults("__feed:niche", 1);
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest", items: latest.items },
        { id: "niche", title: "Niche Gems", items: niche.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase();
    const mapped = feed === "latest" ? "latest" : (feed === "niche" ? "niche" : "popular");
    return searchResults(`__feed:${mapped}`, page);
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
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
