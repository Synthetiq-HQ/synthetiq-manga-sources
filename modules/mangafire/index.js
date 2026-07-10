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

  async function pageJSON(url, options = {}) {
    if (typeof globalThis.pagev2 !== "function") {
      throw new Error("MangaFire requires the pagev2 bridge.");
    }
    const target = assertAPIURL(url);
    const snapshot = await globalThis.pagev2({
      url: target,
      headers: { ...API_HEADERS, ...(options.headers || {}) },
      userAgent: null,
      timeoutMilliseconds: options.timeoutMilliseconds || 8_000,
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
    if (payload.error) throw new Error(`MangaFire API error: ${String(payload.error)}`);
    return payload;
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

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const text = String(query || "").trim().slice(0, 200);
    const params = [];
    if (text === "__feed:popular") {
      params.push(["type", "trending"], ["days", "7"]);
    } else if (text === "__feed:latest") {
      params.push(["order[chapter_updated_at]", "desc"]);
    } else if (text) {
      params.push(["keyword", text]);
    }
    addExcludedGenres(params);
    params.push(["page", String(currentPage)], ["limit", "30"]);
    const endpoint = text === "__feed:popular" ? "/api/top-titles" : "/api/titles";
    return `${BASE_URL}${endpoint}?${queryString(params)}`;
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
    const payload = await pageJSON(searchURL(query, page));
    const items = (Array.isArray(payload.items) ? payload.items : [])
      .map(mapSearchItem)
      .filter(Boolean);
    return {
      items,
      hasMore: Boolean(payload.meta && payload.meta.hasNext),
    };
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
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest", items: latest.items },
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
