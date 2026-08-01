"use strict";

(() => {
  const BASE_URL = "https://comic-growl.com";
  const SEARCH_LIMIT = 20;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const LIST_CACHE_TTL = 60_000;
  let listCache = { key: "", at: 0, value: null };

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

  function attribute(tag, name) {
    const match = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
    );
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
      const value = String(raw || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
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
      throw new Error("Comic Growl requires the fetchv2 bridge.");
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
            responseClass: options.responseClass || "html",
          },
        );
      } catch (error) {
        // Bridge/network failures (timeouts, aborted sockets) are transient.
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      const status = Number(response.status || 0);
      if (response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Comic Growl request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("Comic Growl returned an empty response.");
    }
    throw lastError || new Error("Comic Growl request failed.");
  }

  async function fetchList(url, maxBytesHint) {
    if (listCache.key === url && listCache.value && Date.now() - listCache.at < LIST_CACHE_TTL) {
      return listCache.value;
    }
    const body = await fetchDirect(url, { maxBytesHint });
    listCache = { key: url, at: Date.now(), value: body };
    return body;
  }

  // Next.js server pages are full of <!-- --> / <!--$--> comment markers that
  // would otherwise leak into parsed text.
  function stripComments(html) {
    return String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/comic-growl\.com)?\/?series\/([a-f0-9]+)/i);
    if (match) return `${BASE_URL}/series/${match[1].toLowerCase()}`;
    throw new Error("Invalid Comic Growl series identifier.");
  }

  function normalizedEpisodeURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/comic-growl\.com)?\/?episodes\/([a-f0-9]+)/i);
    if (match) return `${BASE_URL}/episodes/${match[1].toLowerCase()}`;
    throw new Error("Invalid Comic Growl episode identifier.");
  }

  function absoluteURL(value) {
    const input = decodeEntities(String(value || "").trim());
    if (input.startsWith("https://")) return input;
    if (input.startsWith("//")) return `https:${input}`;
    if (input.startsWith("/")) return `${BASE_URL}${input}`;
    return "";
  }

  function imageURLFromTag(tag) {
    const candidates = [
      attribute(tag, "src"),
      attribute(tag, "data-src"),
      attribute(tag, "data-lazy-src"),
    ];
    for (const raw of candidates) {
      const value = absoluteURL(raw);
      if (value.startsWith("https://")) return value;
    }
    const srcset = attribute(tag, "srcset") || attribute(tag, "srcSet");
    if (srcset) {
      const first = absoluteURL(srcset.split(",")[0].trim().split(/\s+/)[0]);
      if (first.startsWith("https://")) return first;
    }
    return "";
  }

  function isNextErrorPage(source) {
    return /<html\b[^>]*id=["']__next_error__["']/i.test(source);
  }

  function parseSeriesCards(html) {
    const source = stripComments(html);
    const items = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*href=(["'])((?:https:\/\/comic-growl\.com)?\/series\/[a-f0-9]+)\1[^>]*>/gi;
    let match;
    while ((match = anchorPattern.exec(source)) !== null) {
      const href = absoluteURL(match[2]);
      if (!href || seen.has(href)) continue;
      const window_ = source.slice(match.index, match.index + 3000);
      const titled = window_.match(/<[^>]+data-e2e=["']sliTitle["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i)
        || window_.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
      const linkText = match[0].endsWith(">")
        ? window_.match(/^[^>]*>([\s\S]*?)<\/a>/i)
        : null;
      const coverImage = window_.match(/<img\b[^>]*class=["'][^"']*(?:series-list-item-img|home-series-tile-item-img)[^"']*["'][^>]*>/i);
      const altTitle = coverImage ? attribute(coverImage[0], "alt") : "";
      const title = stripHTML(titled?.[1] || altTitle || linkText?.[1] || "");
      if (!title) continue;
      const imageTag = window_.match(/<img\b[^>]*>/i);
      const image = imageTag ? imageURLFromTag(imageTag[0]) : "";
      seen.add(href);
      items.push({ id: href, href, title, image });
    }
    return items;
  }

  // Comic Growl renders the homepage with Next.js streaming. The actual feed
  // data lives inside `self.__next_f.push([1,"..."])` script chunks as JSON.
  function concatNextFlightChunks(html) {
    const source = String(html || "");
    const out = [];
    const pattern = /self\.__next_f\.push\(\[1,\"([\s\S]*?)\"\]\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      try {
        out.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
      } catch {
        out.push(match[1]);
      }
    }
    return out.join("");
  }

  function extractBalancedJSON(text, key) {
    const source = String(text || "");
    const index = source.indexOf(`"${key}":`);
    if (index === -1) return null;
    // Walk back to the start of the containing object.
    let start = index;
    let depth = 0;
    while (start > 0) {
      const char = source[start];
      if (char === "}") depth += 1;
      else if (char === "{") {
        if (depth === 0) break;
        depth -= 1;
      }
      start -= 1;
    }
    if (source[start] !== "{") return null;
    // Walk forward to the matching closing brace.
    let end = index;
    depth = 0;
    let inString = false;
    let escape = false;
    while (end < source.length) {
      const char = source[end];
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = !inString;
      } else if (!inString) {
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      end += 1;
    }
    if (source[end] !== "}") return null;
    const raw = source.slice(start, end + 1);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function itemFromNextSeries(entry) {
    const title = String(entry?.title || "").trim();
    if (!title) return null;
    const id = String(entry?.id || "").trim();
    const href = id ? `${BASE_URL}/series/${id}` : "";
    const imageObj = Array.isArray(entry?.thumbnailImages)
      ? entry.thumbnailImages.find((img) => img?.size === "large" || img?.size === "original")
      : entry?.image;
    const image = imageObj?.url || "";
    return { id: href, href, title, image };
  }

  function parseHomeRankingHTML(html) {
    const flight = concatNextFlightChunks(html);
    const payload = extractBalancedJSON(flight, "mangaRankingDefault");
    const entries = Array.isArray(payload?.mangaRankingDefault) ? payload.mangaRankingDefault : [];
    if (entries.length) {
      const items = [];
      const seen = new Set();
      for (const entry of entries) {
        const item = itemFromNextSeries(entry);
        if (!item || !item.href || seen.has(item.href)) continue;
        seen.add(item.href);
        items.push(item);
      }
      return { items, hasMore: false };
    }
    // Older server-rendered homepages expose series cards directly.
    return { items: parseSeriesCards(html), hasMore: false };
  }

  function parseSearchHTML(html) {
    const source = String(html || "");
    if (isNextErrorPage(source)) {
      throw new Error("Comic Growl returned an error page instead of results.");
    }
    return { items: parseSeriesCards(source), hasMore: false };
  }

  function parseDetailsHTML(html, href) {
    const source = stripComments(html);
    if (isNextErrorPage(source)) {
      throw new Error("Comic Growl returned an error page for this series.");
    }
    const heading = source.match(/<h1\b[^>]*class=["'][^"']*series-h-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    const title = stripHTML(
      String(heading?.[1] || "").replace(
        /<span\b[^>]*class=["'][^"']*g-hidden[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
        " ",
      ),
    );
    if (!title) throw new Error("Comic Growl details did not contain a title.");

    const ogImage = source.match(/<meta\b[^>]*property=["']og:image["'][^>]*>/i);
    let cover = ogImage ? absoluteURL(attribute(ogImage[0], "content")) : "";
    if (!cover) {
      cover = absoluteURL(
        source.match(/(?:https?:)?\/\/cdn-public\.comici\.jp\/series\/[^\s"'\\]+/i)?.[0] || "",
      );
    }

    const descriptionStart = source.search(/data-e2e=["']shDescTxt["']/i);
    let description = "";
    if (descriptionStart !== -1) {
      const tagClose = source.indexOf(">", descriptionStart);
      const contentStart = tagClose === -1 ? descriptionStart : tagClose + 1;
      const tagsIndex = source.indexOf("series-h-tags", descriptionStart);
      let raw = source.slice(
        contentStart,
        tagsIndex === -1 ? contentStart + 4000 : tagsIndex,
      );
      // If the slice cuts off the next tag, drop the partial fragment.
      const lastOpen = raw.lastIndexOf("<");
      if (lastOpen !== -1 && raw.indexOf(">", lastOpen) === -1) {
        raw = raw.slice(0, lastOpen);
      }
      description = stripHTML(raw);
    }

    const creditStart = source.indexOf("series-h-credit-user");
    let authors = [];
    if (creditStart !== -1) {
      const creditEnd = source.indexOf("series-h-credit-info", creditStart);
      const creditBlock = source.slice(
        creditStart,
        creditEnd === -1 ? creditStart + 3000 : creditEnd,
      );
      authors = uniqueStrings(
        Array.from(creditBlock.matchAll(/<span\b[^>]*class=["'][^"']*g-author-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi))
          .map((entry) => stripHTML(entry[1])),
      );
    }

    const genres = uniqueStrings(
      Array.from(source.matchAll(/<span\b[^>]*class=["'][^"']*series-h-tag-label[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi))
        .map((entry) => stripHTML(entry[1]).replace(/^#/, "").trim()),
    );

    return {
      id: href,
      href,
      url: href,
      title,
      description,
      image: cover,
      authors,
      author: authors.join(", "),
      genres,
      status: "Unknown",
    };
  }

  function parseJapaneseDate(text) {
    const match = String(text || "").match(/(\d{4})\s*[\/.年-]\s*(\d{1,2})\s*[\/.月-]\s*(\d{1,2})/);
    if (!match) return null;
    const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  function parseChaptersHTML(html) {
    const source = stripComments(html);
    const chapters = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*href=(["'])((?:https:\/\/comic-growl\.com)?\/episodes\/[a-f0-9]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(source)) !== null) {
      const href = absoluteURL(match[2]);
      if (!href || seen.has(href)) continue;
      const body = match[3];
      // Skip paid/locked episodes that require coins or app subscription.
      if (/<div\b[^>]*class=["'][^"']*series-eplist-item-access-paid[^"']*["'][^>]*>/i.test(body)) {
        continue;
      }
      const titled = body.match(/<[^>]+data-e2e=["']eliTitle["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i)
        || body.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
      const title = stripHTML(titled?.[1] || "");
      const dateText = stripHTML(
        body.match(/<div\b[^>]*class=["'][^"']*series-eplist-item-meta-date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "",
      );
      seen.add(href);
      chapters.push({
        id: href,
        href,
        url: href,
        title: title || `エピソード ${chapters.length + 1}`,
        number: chapters.length + 1,
        releaseDate: parseJapaneseDate(dateText),
        language: "ja",
      });
    }
    return chapters;
  }

  // Series pages only embed the newest episodes; full lists live on the
  // paginated /series/<hash>/<page> sort views (30 episodes per page).
  function chapterListPageURLs(html, seriesURL) {
    const source = stripComments(html);
    const hash = seriesURL.replace(`${BASE_URL}/series/`, "");
    const pages = new Set();
    const pattern = new RegExp(`href=["']${seriesURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d+)["']`, "gi");
    let match;
    while ((match = pattern.exec(source)) !== null) {
      pages.add(Number(match[1]));
    }
    return [...pages]
      .filter((page) => Number.isFinite(page) && page >= 1)
      .sort((a, b) => a - b)
      .map((page) => `${BASE_URL}/series/${hash}/${page}`);
  }

  function parseScramble(value) {
    if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
    const text = String(value || "").trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  }

  function isIdentityOrder(order) {
    return order.every((value, index) => value === index);
  }

  function parseImagesJSON(body, referer) {
    let payload;
    try {
      payload = JSON.parse(String(body || ""));
    } catch {
      throw new Error("Comic Growl returned an unreadable viewer response.");
    }
    const entries = Array.isArray(payload?.result) ? payload.result : [];
    const pages = [];
    const seen = new Set();
    const sorted = entries.slice().sort((a, b) => Number(a?.sort || 0) - Number(b?.sort || 0));
    for (const entry of sorted) {
      const url = String(entry?.imageUrl || "").trim();
      if (!url.startsWith("https://") || seen.has(url)) continue;
      const order = parseScramble(entry.scramble);
      const scrambled = order.length > 1 && !isIdentityOrder(order);
      const page = {
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: referer,
        },
        scrambled,
      };
      if (scrambled) {
        const side = Math.round(Math.sqrt(order.length));
        const square = side * side === order.length;
        page.tiles = {
          rows: square ? side : 1,
          columns: square ? side : order.length,
          order,
        };
      }
      seen.add(url);
      pages.push(page);
    }
    return { pages, totalPages: Number(payload?.totalPages) || pages.length };
  }

  function normalizeSearchQuery(query) {
    const raw = String(query || "");
    if (raw === "__feed:popular") return { feed: "popular", text: "" };
    if (raw === "__feed:latest") return { feed: "latest", text: "" };
    return { feed: "search", text: raw.trim().slice(0, 200) };
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    if (normalized.feed === "popular" || normalized.feed === "latest") {
      const home = await fetchList(`${BASE_URL}/`, 2 * 1024 * 1024);
      const ranked = parseHomeRankingHTML(home);
      if (!ranked.items.length) {
        throw new Error("Comic Growl homepage did not expose its ranking section.");
      }
      return ranked;
    }
    const url = `${BASE_URL}/search?q=${encodeURIComponent(normalized.text)}`;
    return parseSearchHTML(await fetchDirect(url, { maxBytesHint: 2 * 1024 * 1024 }));
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 2 * 1024 * 1024 }), href);
  }

  async function extractChapters(id) {
    const seriesURL = normalizedSeriesURL(id);
    const main = await fetchDirect(seriesURL, { maxBytesHint: 8 * 1024 * 1024 });
    const pages = chapterListPageURLs(main, seriesURL);
    const bodies = [main];
    for (const pageURL of pages) {
      bodies.push(await fetchDirect(pageURL, { maxBytesHint: 8 * 1024 * 1024 }));
    }
    const chapters = [];
    const seen = new Set();
    for (const body of bodies) {
      for (const chapter of parseChaptersHTML(body)) {
        if (seen.has(chapter.id)) continue;
        seen.add(chapter.id);
        chapters.push({ ...chapter, number: chapters.length + 1 });
      }
    }
    if (!chapters.length) {
      throw new Error("Comic Growl returned no chapters for this series.");
    }
    return chapters;
  }

  async function extractImages(id) {
    const episodeURL = normalizedEpisodeURL(id);
    const html = await fetchDirect(episodeURL, { maxBytesHint: 4 * 1024 * 1024 });
    const viewerID = stripComments(html).match(/data-comici-viewer-id=["']([a-f0-9]+)["']/i)?.[1];
    if (!viewerID) {
      throw new Error("Comic Growl episode did not expose a viewer id.");
    }
    const apiBase = `${BASE_URL}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerID}`;
    const probe = parseImagesJSON(
      await fetchDirect(`${apiBase}&page-from=0&page-to=1`, { maxBytesHint: 1024 * 1024 }),
      episodeURL,
    );
    let pages = probe.pages;
    if (probe.totalPages > pages.length) {
      pages = parseImagesJSON(
        await fetchDirect(`${apiBase}&page-from=0&page-to=${probe.totalPages}`, { maxBytesHint: 4 * 1024 * 1024 }),
        episodeURL,
      ).pages;
    }
    if (!pages.length) {
      throw new Error("Comic Growl returned no readable pages for this episode.");
    }
    return pages;
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      searchResults("__feed:popular", 1),
      searchResults("__feed:latest", 1),
    ]);
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
