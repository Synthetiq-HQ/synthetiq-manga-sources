"use strict";

(() => {
  const BASE_URL = "https://novelfire.net";
  const CHAPTER_BASE_URL = "https://novelphoenix.com";
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MAX_CHAPTER_PAGES = 100;
  const REQUEST_INTERVAL_MS = 400;
  const MAX_CACHED_RESPONSES = 48;
  const UNSAFE_GENRES = new Set([
    "adult",
    "ecchi",
    "erotica",
    "explicit",
    "harem",
    "mature",
    "nsfw",
    "porn",
    "r-18",
    "smut",
  ]);
  const responseCache = new Map();
  const chapterCache = new Map();
  const chapterLoads = new Map();
  let nextRequestAt = 0;

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
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, BASE_URL);
      if (url.protocol !== "https:" || (url.hostname !== "novelfire.net" && !url.hostname.endsWith(".novelfire.net"))) return "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function normalizeSlug(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/novelfire\.net)?\/?book\/([a-z0-9][a-z0-9-]{0,199})\/?$/i);
    const slug = match ? match[1] : input.replace(/^\/+|\/+$/g, "");
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/i.test(slug)) throw new Error("Invalid NovelFire book identifier.");
    return slug.toLowerCase();
  }

  function chapterReference(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/novelfire\.net)?\/?book\/([a-z0-9][a-z0-9-]{0,199})\/chapter-([0-9]{1,8})\/?$/i)
      || input.match(/^([a-z0-9][a-z0-9-]{0,199})-chapter-([0-9]{1,8})$/i);
    if (!match) throw new Error("Invalid NovelFire chapter identifier.");
    return { slug: match[1].toLowerCase(), number: Number(match[2]) };
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    const head = page.match(/<head\b[\s\S]*?<\/head>/i)?.[0] || page.slice(0, 16 * 1024);
    return /<title\b[^>]*>[\s\S]*?(?:just a moment|attention required|checking your browser|access denied)/i.test(head)
      || /cf-chl-|cf-turnstile|challenge-platform|verify you are human/i.test(head);
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  async function waitForRequestSlot() {
    const now = Date.now();
    const delay = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(nextRequestAt, now) + REQUEST_INTERVAL_MS;
    if (delay > 0) await sleep(delay);
  }

  function cachedResponse(url) {
    if (!responseCache.has(url)) return "";
    const value = responseCache.get(url);
    responseCache.delete(url);
    responseCache.set(url, value);
    return value;
  }

  function cacheResponse(url, body) {
    if (responseCache.has(url)) responseCache.delete(url);
    responseCache.set(url, body);
    while (responseCache.size > MAX_CACHED_RESPONSES) responseCache.delete(responseCache.keys().next().value);
  }

  async function request(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelFire requires the fetchv2 bridge.");
    if (options.cacheable !== false) {
      const cached = cachedResponse(url);
      if (cached) return cached;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1500 * attempt);
      try {
        await waitForRequestSlot();
        const response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          { followRedirects: true, maxBytesHint: options.maxBytesHint || 2 * 1024 * 1024, responseClass: options.responseClass || "html" },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`NovelFire request failed with HTTP ${status || "error"}.`);
          if (!RETRYABLE_STATUS.has(status)) break;
          continue;
        }
        if (response.bodyDropped) throw new Error("NovelFire response exceeded the app size limit.");
        const body = await responseText(response);
        if (!body) throw new Error("NovelFire returned an empty response.");
        if (isChallengePage(body)) throw new Error("NovelFire requires browser verification.");
        if (options.cacheable !== false) cacheResponse(url, body);
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError || new Error("NovelFire request failed.");
  }

  function itemFor(slug, title, image, chapterCount = null) {
    const normalized = normalizeSlug(slug);
    const item = { id: normalized, href: `${BASE_URL}/book/${normalized}`, title: decodeEntities(title || "").trim(), image: absoluteURL(image) };
    if (Number.isFinite(Number(chapterCount)) && Number(chapterCount) > 0) item.chapterCount = Number(chapterCount);
    return item;
  }

  function parseCatalogue(html) {
    const items = [];
    const seen = new Set();
    const cardPattern = /<li\b[^>]*class=(['"])[^'"]*\bnovel-item\b[^'"]*\1[^>]*>[\s\S]*?<\/li>/gi;
    for (const cardMatch of String(html || "").matchAll(cardPattern)) {
      const card = cardMatch[0];
      const linkMatch = card.match(/<a\b[^>]*href=(['"])(\/book\/([a-z0-9-]+))\1[^>]*>/i);
      if (!linkMatch) continue;
      const slug = linkMatch[3];
      if (seen.has(slug)) continue;
      const title = attribute(linkMatch[0], "title") || stripHTML(card.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]);
      const imageTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
      const image = attribute(imageTag, "data-src") || attribute(imageTag, "src");
      const count = card.match(/([0-9][0-9,]*)\s+Chapters?/i)?.[1]?.replace(/,/g, "");
      const item = itemFor(slug, title, image, count);
      if (!item.title) continue;
      seen.add(slug);
      items.push(item);
    }
    return items;
  }

  function hasNextPage(html) {
    return /<a\b[^>]*\brel=(['"])next\1/i.test(String(html || ""));
  }

  async function cataloguePage(path, page) {
    const separator = path.includes("?") ? "&" : "?";
    const html = await request(`${BASE_URL}${path}${page > 1 ? `${separator}page=${page}` : ""}`);
    return { items: parseCatalogue(html), hasMore: hasNextPage(html) };
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    const requestedPage = Math.max(1, Number(page) || 1);
    if (!text || text.startsWith("__feed:")) {
      const isLatest = text === "__feed:latest";
      const path = isLatest ? "/genre-all/sort-new/status-all/all-novel" : "/genre-all/sort-popular/status-all/all-novel";
      return cataloguePage(path, requestedPage);
    }
    return cataloguePage(`/search?keyword=${encodeURIComponent(text.slice(0, 160))}`, requestedPage);
  }

  function descriptionFrom(html) {
    const summary = String(html || "").match(/<div\b[^>]*class=(['"])[^'"]*\bsummary\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2];
    const description = summary ? stripHTML(summary) : attribute(String(html || "").match(/<meta\b[^>]*name=(['"])description\1[^>]*>/i)?.[0], "content");
    return decodeEntities(description).replace(/^Read\s+.+?\s+novel\s+online\s+(?:free\s*)?(?:from|now).*$/i, "").trim();
  }

  function genresFrom(html) {
    const region = String(html || "").match(/<div\b[^>]*class=(['"])[^'"]*\bcategories\b[^'"]*\1[^>]*>[\s\S]*?<\/div>/i)?.[0] || "";
    return [...region.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => stripHTML(match[1]))
      .filter((genre, index, all) => genre && all.indexOf(genre) === index);
  }

  function hasUnsafeGenre(genres) {
    return genres.some((genre) => UNSAFE_GENRES.has(String(genre || "").trim().toLowerCase()));
  }

  async function extractDetails(id) {
    const slug = normalizeSlug(id);
    const html = await request(`${BASE_URL}/book/${slug}`);
    const title = stripHTML(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) || decodeEntities(html.match(/<title>([^<]+)<\/title>/i)?.[1] || "").replace(/\s*-\s*Novel Fire\s*$/i, "").trim();
    const author = stripHTML(html.match(/<div\b[^>]*class=(['"])[^'"]*\bauthor\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]);
    const status = stripHTML(html.match(/<strong\b[^>]*class=(['"])[^'"]*\b(?:ongoing|completed)\b[^'"]*\1[^>]*>([\s\S]*?)<\/strong>/i)?.[2]);
    const image = attribute(html.match(/<meta\b[^>]*property=(['"])og:image\1[^>]*>/i)?.[0], "content");
    const genres = genresFrom(html);
    if (hasUnsafeGenre(genres)) throw new Error("NovelFire title is unavailable under the module safety filter.");
    return { id: slug, href: `${BASE_URL}/book/${slug}`, title, author: author.replace(/^Author:\s*/i, "").trim(), status, image: absoluteURL(image), description: descriptionFrom(html), genres };
  }

  function chaptersFromHTML(html, slug) {
    const chapters = [];
    for (const match of String(html || "").matchAll(/<a\b[^>]*href=(['"])(\/book\/([a-z0-9-]+)\/chapter-([0-9]+))\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      if (match[3].toLowerCase() !== slug) continue;
      const chapterTitle = attribute(match[0], "title") || stripHTML(match[5]);
      const releaseDate = attribute(match[0].match(/<time\b[^>]*>/i)?.[0], "datetime");
      chapters.push({ id: `${slug}-chapter-${match[4]}`, href: `${BASE_URL}${match[2]}`, number: Number(match[4]), title: decodeEntities(chapterTitle) || `Chapter ${match[4]}`, releaseDate: releaseDate || undefined, language: "en" });
    }
    return chapters;
  }

  function chapterPageCount(html) {
    const pages = [...String(html || "").matchAll(/[?&]page=([0-9]{1,4})/gi)]
      .map((match) => Number(match[1]))
      .filter((page) => Number.isInteger(page) && page > 0);
    return Math.max(1, ...pages);
  }

  async function extractChapters(id) {
    const slug = normalizeSlug(id);
    if (chapterCache.has(slug)) return chapterCache.get(slug);
    if (chapterLoads.has(slug)) return chapterLoads.get(slug);
    const load = loadChapters(slug);
    chapterLoads.set(slug, load);
    try {
      const chapters = await load;
      chapterCache.set(slug, chapters);
      return chapters;
    } finally {
      chapterLoads.delete(slug);
    }
  }

  async function loadChapters(slug) {
    const path = `${BASE_URL}/book/${slug}/chapters`;
    const firstPage = await request(path, { maxBytesHint: 4 * 1024 * 1024 });
    const totalPages = chapterPageCount(firstPage);
    if (totalPages > MAX_CHAPTER_PAGES) {
      throw new Error("NovelFire chapter list exceeds the source safety limit.");
    }
    const pages = [firstPage];
    for (let page = 2; page <= totalPages; page += 1) {
      pages.push(await request(`${path}?page=${page}`, { maxBytesHint: 4 * 1024 * 1024 }));
    }
    const seen = new Set();
    return pages.flatMap((page) => chaptersFromHTML(page, slug))
      .filter((chapter) => !seen.has(chapter.id) && seen.add(chapter.id))
      .sort((left, right) => left.number - right.number);
  }

  async function extractText(reference) {
    const { slug, number } = chapterReference(reference);
    const html = await request(`${CHAPTER_BASE_URL}/novel/${slug}/chapter-${number}`, { cacheable: false, maxBytesHint: MAX_TEXT_BYTES });
    const content = html.match(/<div\b[^>]*id=(['"])content\1[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=(['"])[^'"]*\bchapternav\b/i)?.[2]
      || html.match(/<div\b[^>]*id=(['"])content\1[^>]*>([\s\S]*?)<\/div>/i)?.[2];
    if (!content) throw new Error("NovelFire chapter text was unavailable.");
    const paragraphs = [...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripHTML(match[1])).filter(Boolean);
    const text = (paragraphs.length ? paragraphs : [stripHTML(content)]).join("\n\n").trim();
    if (!text) throw new Error("NovelFire chapter text was empty.");
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error("NovelFire chapter text exceeds the app size limit.");
    return { title: `Chapter ${number}`, content: text };
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([searchResults("__feed:popular", 1), searchResults("__feed:latest", 1)]);
    return { sections: [{ id: "popular", title: "Popular", items: popular.items }, { id: "latest", title: "Latest", items: latest.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
    return searchResults(`__feed:${feed}`, page);
  }

  globalThis.SynthetiqModule = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractChapters = extractChapters;
  globalThis.extractText = extractText;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
