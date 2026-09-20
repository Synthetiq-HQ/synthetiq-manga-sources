"use strict";

(() => {
  const BASE_URL = "https://colorizedmangas.com";
  const SOURCE_HOSTS = new Set(["colorizedmangas.com", "www.colorizedmangas.com"]);
  const IMAGE_HOSTS = new Set(["cdn.jsdelivr.net"]);
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const PAGE_SIZE = 24;
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const ADULT_MARKERS = [
    "adult",
    "ecchi",
    "erotic",
    "hentai",
    "nsfw",
    "nude",
    "porn",
    "smut",
    "yaoi",
    "yuri",
  ];
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/*,*/*",
    Referer: `${BASE_URL}/`,
  };
  let homeCache = { fetchedAt: 0, value: null };

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
        .replace(/<br\s*\/?>(?=.)/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = String(tag || "").match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp(`\\b${escapedName}\\s*=\\s*([^\\s>]+)`, "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => (typeof value === "string" ? value : ""));
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function sourceURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !SOURCE_HOSTS.has(url.hostname.toLowerCase())) return "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "") || BASE_URL;
    } catch (_) {
      return "";
    }
  }

  function assetURL(value, base = BASE_URL) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol !== "https:" || !SOURCE_HOSTS.has(url.hostname.toLowerCase())) return "";
      if (!/^\/(?:covers|icon|og)(?:\/|[-.]|$)/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function imageURL(value) {
    const input = decodeEntities(String(value || "").trim());
    if (!input) return "";
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname.toLowerCase())) return "";
      if (!/^\/gh\/[^/]+\/[^/]+\/pages\/\d+\/\d+\.(?:webp|jpe?g|png)$/i.test(url.pathname)) return "";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    return page.includes("just a moment")
      || page.includes("cf-chl-")
      || page.includes("verify you are human")
      || page.includes("access denied")
      || page.includes("captcha");
  }

  async function fetchHTML(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("ColorizedManga requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await sleep(700 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          "GET",
          null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
            responseClass: "html",
          },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`ColorizedManga request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        if (response.bodyDropped) throw new Error("ColorizedManga response exceeded the app size limit.");
        const body = await responseText(response);
        if (!body.trim()) throw new Error("ColorizedManga returned an empty response.");
        if (isChallengePage(body)) throw new Error("ColorizedManga returned a challenge or access-denied page.");
        return { body, finalUrl: sourceURL(response.finalUrl || url, BASE_URL) || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/challenge|access-denied|empty response|exceeded/i.test(lastError.message)) break;
      }
    }
    throw lastError || new Error("ColorizedManga request failed.");
  }

  async function loadHome(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && homeCache.value && now - homeCache.fetchedAt < 5 * 60 * 1000) return homeCache.value;
    const value = await fetchHTML(`${BASE_URL}/`, { maxBytesHint: 2 * 1024 * 1024 });
    homeCache = { fetchedAt: now, value };
    return value;
  }

  function queryText(value) {
    if (typeof value === "string") return value;
    return String((value && (value.text || value.query || value.keyword)) || "");
  }

  function isAllowedContent(value) {
    const text = String(value || "").toLowerCase();
    return !ADULT_MARKERS.some((marker) => new RegExp(`(^|[^a-z0-9])${marker.replace(/[+]/g, "\\+")}(?=$|[^a-z0-9])`, "i").test(text));
  }

  function cardTitle(inner, tag) {
    const heading = inner.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    return stripHTML(heading ? heading[1] : attribute(tag, "aria-label").split("—")[0]);
  }

  function parseHomeCards(html) {
    const cards = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const match of String(html || "").matchAll(pattern)) {
      const tag = match[0];
      const inner = tag.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, "");
      const href = attribute(tag, "href");
      const series = sourceURL(href, BASE_URL);
      if (!series) continue;
      const path = new URL(series).pathname;
      const slugMatch = path.match(/^\/([a-z0-9-]+)$/i);
      if (!slugMatch || !/<h3\b/i.test(inner) || !/\/covers\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)/i.test(inner)) continue;
      const slug = slugMatch[1].toLowerCase();
      if (seen.has(slug)) continue;
      const title = cardTitle(inner, tag);
      const imageTag = inner.match(/<img\b[^>]*>/i)?.[0] || "";
      const image = assetURL(attribute(imageTag, "src"), BASE_URL);
      const description = stripHTML(attribute(tag, "aria-label")) || stripHTML(inner);
      if (!title || !image || !isAllowedContent(`${title} ${description}`)) continue;
      cards.push({
        id: series,
        href: series,
        url: series,
        title,
        image,
        description,
      });
      seen.add(slug);
    }
    return cards;
  }

  function parseMeta(html, key, attributeName = "name") {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      if (attribute(tag, attributeName).toLowerCase() === key.toLowerCase()) return attribute(tag, "content");
    }
    return "";
  }

  function jsonLDValues(html) {
    const values = [];
    for (const match of String(html || "").matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        values.push(JSON.parse(match[1].trim()));
      } catch (_) {
        // Ignore unrelated or malformed JSON-LD blocks and use the page fallback.
      }
    }
    return values;
  }

  function findComicSeries(value) {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findComicSeries(item);
        if (found) return found;
      }
      return null;
    }
    const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (type.some((entry) => String(entry).toLowerCase() === "comicseries")) return value;
    for (const child of Object.values(value)) {
      const found = findComicSeries(child);
      if (found) return found;
    }
    return null;
  }

  function seriesFromID(id) {
    const series = sourceURL(id, BASE_URL);
    if (!series) throw new Error("Invalid ColorizedManga series identifier.");
    const match = new URL(series).pathname.match(/^\/([a-z0-9-]+)$/i);
    if (!match) throw new Error("Invalid ColorizedManga series identifier.");
    return { url: series, slug: match[1].toLowerCase() };
  }

  function inferUnitType(html) {
    const normalized = String(html || "").replace(/\\"/g, '"');
    const unit = normalized.match(/"unit"\s*:\s*"(chapter|volume)"/i)?.[1];
    if (unit) return unit.toLowerCase();
    return /\/volumes(?:["'\/]|\\u002f)/i.test(normalized) ? "volume" : "chapter";
  }

  function parseDetails(html, series) {
    const comic = jsonLDValues(html).map(findComicSeries).find(Boolean) || {};
    const heading = String(html || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    let title = stripHTML(heading ? heading[1] : comic.name || "");
    title = title.replace(/^Colorized\s+/i, "").trim();
    title = title.replace(/\s*\(Colored\s*\/\s*Digital Color Edition\)\s*$/i, "").trim();
    if (!title) throw new Error("ColorizedManga details did not contain a title.");
    const author = typeof comic.author === "string" ? comic.author : comic.author?.name || "";
    const genres = Array.isArray(comic.genre) ? comic.genre.map((genre) => String(genre).trim()).filter(Boolean) : [];
    const image = assetURL(comic.image, BASE_URL) || assetURL(parseMeta(html, "og:image", "property"), BASE_URL);
    const description = stripHTML(comic.description || parseMeta(html, "description"));
    const statusToken = String(html || "").replace(/\\"/g, '"').match(/"status"\s*:\s*"([^"]+)"/i)?.[1]?.toLowerCase();
    const status = statusToken === "live" || statusToken === "ongoing"
      ? "Ongoing"
      : statusToken === "complete" || statusToken === "completed"
        ? "Completed"
        : "Unknown";
    if (!isAllowedContent(`${title} ${description} ${genres.join(" ")}`)) {
      throw new Error("ColorizedManga item was excluded by the safety filter.");
    }
    return {
      id: series.url,
      href: series.url,
      url: series.url,
      title,
      author,
      authors: author ? [author] : [],
      status,
      image,
      description,
      genres,
    };
  }

  function chapterTitle(inner, unit, numberText) {
    const subtitle = inner.match(/<div\b[^>]*text-sm[^>]*font-medium[^>]*>([\s\S]*?)<\/div>/i);
    const cleanSubtitle = stripHTML(subtitle ? subtitle[1] : "");
    const unitLabel = unit === "volume" ? "Volume" : "Chapter";
    return cleanSubtitle ? `${unitLabel} ${numberText} — ${cleanSubtitle}` : `${unitLabel} ${numberText}`;
  }

  function parseChapters(html, series) {
    const chapters = [];
    const seen = new Set();
    const pattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    for (const match of String(html || "").matchAll(pattern)) {
      const anchor = match[0];
      const href = sourceURL(attribute(anchor, "href"), BASE_URL);
      if (!href) continue;
      const parsed = new URL(href);
      const route = parsed.pathname.match(new RegExp(`^/${series.slug}/(chapter|volume)/(\\d+(?:\\.\\d+)?)$`, "i"));
      if (!route || seen.has(href)) continue;
      const unit = route[1].toLowerCase();
      const numberText = route[2];
      const number = Number(numberText);
      if (!Number.isFinite(number)) continue;
      const inner = anchor.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, "");
      const title = chapterTitle(inner, unit, numberText);
      if (!isAllowedContent(`${title} ${stripHTML(inner)}`)) continue;
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number,
        language: "en",
      });
      seen.add(href);
    }
    chapters.sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
    return chapters;
  }

  function chapterFromID(id) {
    const chapter = sourceURL(id, BASE_URL);
    if (!chapter) throw new Error("Invalid ColorizedManga chapter identifier.");
    const match = new URL(chapter).pathname.match(/^\/([a-z0-9-]+)\/(chapter|volume)\/(\d+(?:\.\d+)?)$/i);
    if (!match) throw new Error("Invalid ColorizedManga chapter identifier.");
    return { url: chapter, slug: match[1].toLowerCase(), unit: match[2].toLowerCase(), number: match[3] };
  }

  function parseImages(html) {
    const pages = [];
    const seen = new Set();
    const pattern = /https?:\/\/cdn\.jsdelivr\.net\/gh\/[^"'<>\s]+?\/pages\/\d+\/\d+\.(?:webp|jpe?g|png)(?:\?[^"'<>\s]*)?/gi;
    for (const match of String(html || "").matchAll(pattern)) {
      const url = imageURL(match[0]);
      if (!url || seen.has(url)) continue;
      pages.push({ url, headers: IMAGE_HEADERS });
      seen.add(url);
    }
    return pages;
  }

  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const home = await loadHome();
    const all = parseHomeCards(home.body);
    const text = queryText(query).trim().toLowerCase();
    const filtered = text.startsWith("__feed:") || !text
      ? all
      : all.filter((item) => `${item.title} ${item.description} ${item.id}`.toLowerCase().includes(text));
    const start = (requestedPage - 1) * PAGE_SIZE;
    const items = filtered.slice(start, start + PAGE_SIZE);
    return { items, hasMore: start + PAGE_SIZE < filtered.length };
  }

  async function extractDetails(id) {
    const series = seriesFromID(id);
    const page = await fetchHTML(series.url, { maxBytesHint: 4 * 1024 * 1024 });
    return parseDetails(page.body, series);
  }

  async function extractChapters(id) {
    const series = seriesFromID(id);
    const detailsPage = await fetchHTML(series.url, { maxBytesHint: 4 * 1024 * 1024 });
    const preferredUnit = inferUnitType(detailsPage.body);
    const units = preferredUnit === "volume" ? ["volumes", "chapters"] : ["chapters", "volumes"];
    for (const unitPath of units) {
      const page = await fetchHTML(`${series.url}/${unitPath}`, { maxBytesHint: MAX_RESPONSE_BYTES });
      const chapters = parseChapters(page.body, series);
      if (chapters.length) return chapters;
    }
    throw new Error("ColorizedManga returned no readable chapters or volumes.");
  }

  async function extractImages(id) {
    const chapter = chapterFromID(id);
    const page = await fetchHTML(chapter.url, {
      headers: { Referer: `${BASE_URL}/${chapter.slug}/` },
      maxBytesHint: 4 * 1024 * 1024,
    });
    const pages = parseImages(page.body);
    if (!pages.length) throw new Error(`ColorizedManga ${chapter.unit} ${chapter.number} returned no readable page images.`);
    return pages;
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:popular", 1);
    return { sections: [{ id: "library", title: "Colorized Manga", items: result.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "popular").toLowerCase();
    if (feed !== "popular" && feed !== "latest" && feed !== "library") return { items: [], hasMore: false };
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
