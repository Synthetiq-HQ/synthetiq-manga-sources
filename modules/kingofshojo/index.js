"use strict";

(() => {
  const BASE_URL = "https://kingofshojo.com";
  const BASE_HOST = "kingofshojo.com";
  const CDN_HOST = "cdn.kingofshojo.com";
  const COVER_PROXY_HOSTS = new Set(["i1.wp.com", "i2.wp.com"]);
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const RESPONSE_CACHE_TTL_MS = 30_000;
  const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  const MAX_ITEMS = 300;
  const MAX_CHAPTERS = 10_000;
  const MAX_IMAGES = 2_000;
  const responseCache = new Map();
  const searchPageCache = new Map();
  const searchAliases = new Map();
  const chapterCache = new Map();
  const chapterLoads = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else resolve();
    });
  }

  function uniqueStrings(values) {
    const output = [];
    const seen = new Set();
    for (const value of values) {
      const normalized = String(value ?? "").trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
    }
    return output;
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
      .replace(/\\u0026/gi, "&")
      .replace(/\\u0027/gi, "'")
      .replace(/\\u003d/gi, "=")
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
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
      new RegExp(`\\b${name}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"),
    );
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function metaContent(html, key) {
    for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
      const tag = match[0];
      const name = attribute(tag, "property") || attribute(tag, "name");
      if (name.toLowerCase() === String(key).toLowerCase()) return attribute(tag, "content");
    }
    return "";
  }

  function sourceURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) throw new Error("KingOfShojo identifier is empty.");
    let parsed;
    try {
      parsed = new URL(raw, BASE_URL);
    } catch {
      throw new Error("Invalid KingOfShojo URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== BASE_HOST) {
      throw new Error("KingOfShojo URL is outside the source host.");
    }
    return parsed;
  }

  function mangaReference(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(/^\/manga\/([^\/?#]+)\/?$/i);
    if (!match) throw new Error("Invalid KingOfShojo manga identifier.");
    let slug;
    try {
      slug = decodeURIComponent(match[1]).toLowerCase();
    } catch {
      throw new Error("Invalid KingOfShojo manga identifier.");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug)) {
      throw new Error("Invalid KingOfShojo manga identifier.");
    }
    return { slug, href: `${BASE_URL}/manga/${slug}/` };
  }

  function chapterReference(value) {
    const parsed = sourceURL(value);
    const match = parsed.pathname.match(
      /^\/([a-z0-9][a-z0-9-]{0,199})-chapter-([0-9]{1,8}(?:\.[0-9]{1,6})?)\/?$/i,
    );
    if (!match) throw new Error("Invalid KingOfShojo chapter identifier.");
    const slug = match[1].toLowerCase();
    const token = match[2];
    const number = Number(token);
    if (!Number.isFinite(number)) throw new Error("Invalid KingOfShojo chapter number.");
    const href = `${BASE_URL}/${slug}-chapter-${token}/`;
    return { slug, token, number, href, key: href.toLowerCase() };
  }

  function isChallenge(body) {
    return /<title\b[^>]*>[\s\S]{0,200}?(?:just a moment|attention required)[\s\S]{0,200}?<\/title>|cf-chl-|cf-error-code|verify you are human|enable javascript and cookies|access denied/i.test(
      String(body || ""),
    );
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    if (typeof response.text === "function") {
      const body = await response.text();
      if (typeof body === "string") return body;
    }
    if (typeof response.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  function cachedResponse(key) {
    const entry = responseCache.get(key);
    if (!entry || Date.now() - entry.storedAt >= RESPONSE_CACHE_TTL_MS) {
      responseCache.delete(key);
      return "";
    }
    return entry.body;
  }

  function cacheResponse(key, body) {
    responseCache.set(key, { storedAt: Date.now(), body });
    while (responseCache.size > 64) responseCache.delete(responseCache.keys().next().value);
  }

  async function request(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("KingOfShojo requires the fetchv2 bridge.");
    const requestURL = String(url);
    const cacheKey = `${options.responseClass || "html"}:${requestURL}`;
    if (options.cacheable !== false) {
      const cached = cachedResponse(cacheKey);
      if (cached) return cached;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(650 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          requestURL,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
            responseClass: options.responseClass || "html",
          },
        );
        const status = Number(response?.status || 0);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`KingOfShojo request failed with HTTP ${status || "error"}.`);
          if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) continue;
          throw lastError;
        }
        if (response.bodyDropped) throw new Error("KingOfShojo response exceeded the app size limit.");
        const body = await responseText(response);
        if (!body) throw new Error("KingOfShojo returned an empty response.");
        if (isChallenge(body)) throw new Error("KingOfShojo returned a browser challenge instead of source data.");
        if (options.cacheable !== false) cacheResponse(cacheKey, body);
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          attempt >= MAX_ATTEMPTS
          || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)
        ) throw lastError;
      }
    }
    throw lastError || new Error("KingOfShojo request failed.");
  }

  function hasOnlyQueryKeys(parsed, allowedKeys) {
    return [...parsed.searchParams.keys()].every((key) => allowedKeys.has(key.toLowerCase()));
  }

  function safeCoverURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw, BASE_URL);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase();
    const sourceCover = host === BASE_HOST
      && /^\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)
      && !parsed.search && !parsed.hash;
    const proxiedCover = COVER_PROXY_HOSTS.has(host)
      && /^\/kingofshojo\.com\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)
      && hasOnlyQueryKeys(parsed, new Set(["resize", "w", "h", "crop", "fit", "quality"]));
    const CDNcover = host === CDN_HOST
      && /^\/king-bucket\/images\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)
      && !parsed.search && !parsed.hash;
    return sourceCover || proxiedCover || CDNcover ? parsed.toString() : "";
  }

  function safePageURL(value) {
    const raw = decodeEntities(String(value || "").trim());
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw, BASE_URL);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:" || parsed.search || parsed.hash) return "";
    const host = parsed.hostname.toLowerCase();
    const CDNpage = host === CDN_HOST
      && /^\/king-bucket\/[0-9]{1,12}\/[0-9]{1,8}(?:\.[0-9]{1,6})?\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp)$/i.test(parsed.pathname);
    const sourcePage = host === BASE_HOST
      && /^\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp)$/i.test(parsed.pathname);
    return CDNpage || sourcePage ? parsed.toString() : "";
  }

  function findOpeningTagWithClass(source, tagName, className, startAt = 0) {
    const pattern = new RegExp(
      `<${tagName}\\b[^>]*class=(['\"])[^'\"]*\\b${className}\\b[^'\"]*\\1[^>]*>`,
      "gi",
    );
    for (const match of source.slice(startAt).matchAll(pattern)) {
      return { index: startAt + match.index, tag: match[0] };
    }
    return null;
  }

  function titleFromCard(block, openingTag) {
    const title = stripHTML(attribute(openingTag, "title"));
    if (title) return title;
    const selectors = [
      /<div\b[^>]*class=(['\"])[^'\"]*\btt\b[^'\"]*\1[^>]*>([\s\S]*?)<\/div>/i,
      /<span\b[^>]*class=(['\"])[^'\"]*\bname\b[^'\"]*\1[^>]*>([\s\S]*?)<\/span>/i,
      /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i,
    ];
    for (const selector of selectors) {
      const match = block.match(selector);
      const value = stripHTML(match?.[2] || match?.[1] || "");
      if (value) return value;
    }
    const imageTag = block.match(/<img\b[^>]*>/i)?.[0] || "";
    return stripHTML(attribute(imageTag, "alt") || attribute(imageTag, "title"));
  }

  function parseCatalogueCards(html) {
    const source = String(html || "");
    const anchorMatches = [...source.matchAll(/<a\b[^>]*>/gi)];
    const items = [];
    const seen = new Set();
    for (const match of anchorMatches) {
      const openingTag = match[0];
      const rawHref = attribute(openingTag, "href");
      if (!/\/manga\//i.test(rawHref)) continue;
      let manga;
      try {
        manga = mangaReference(rawHref);
      } catch {
        continue;
      }
      if (seen.has(manga.href)) continue;
      const closeIndex = source.toLowerCase().indexOf("</a>", match.index + openingTag.length);
      const endIndex = closeIndex >= 0 ? closeIndex + 4 : source.length;
      const block = source.slice(match.index, endIndex);
      const title = titleFromCard(block, openingTag);
      if (!title) continue;
      const imageTag = block.match(/<img\b[^>]*>/i)?.[0] || "";
      const image = safeCoverURL(
        attribute(imageTag, "data-src")
          || attribute(imageTag, "data-lazy-src")
          || attribute(imageTag, "src"),
      );
      const item = { id: manga.href, href: manga.href, title };
      if (image) item.image = image;
      const chapterText = stripHTML(
        block.match(/<[^>]+class=(['\"])[^'\"]*\bepxs\b[^'\"]*\1[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[2] || "",
      );
      const chapterNumber = chapterText.match(/chapter\s+([0-9]+(?:\.[0-9]+)?)/i)?.[1];
      if (chapterNumber) item.latestChapter = Number(chapterNumber);
      seen.add(manga.href);
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  }

  function searchResultRegion(html) {
    const source = String(html || "");
    let headingEnd = -1;
    for (const match of source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
      if (/^search\b/i.test(stripHTML(match[1]))) {
        headingEnd = match.index + match[0].length;
        break;
      }
    }
    if (headingEnd < 0) return "";
    const list = findOpeningTagWithClass(source, "div", "listupd", headingEnd);
    if (!list) return "";
    const boundaryCandidates = [
      findOpeningTagWithClass(source, "div", "pagination", list.index + list.tag.length)?.index ?? -1,
      findOpeningTagWithClass(source, "div", "releases", list.index + list.tag.length)?.index ?? -1,
    ].filter((index) => index >= 0);
    const end = boundaryCandidates.length ? Math.min(...boundaryCandidates) : source.length;
    return source.slice(list.index, end);
  }

  function parseSearchCards(html) {
    return parseCatalogueCards(searchResultRegion(html));
  }

  function hasNextSearchPage(html, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    for (const match of String(html || "").matchAll(/<a\b[^>]*>/gi)) {
      const tag = match[0];
      const rawHref = attribute(tag, "href");
      if (!rawHref) continue;
      let parsed;
      try {
        parsed = sourceURL(rawHref);
      } catch {
        continue;
      }
      const pageMatch = parsed.pathname.match(/^\/page\/(\d+)\/?$/i);
      if (pageMatch && Number(pageMatch[1]) > currentPage && parsed.searchParams.has("s")) return true;
      if (/\bnext\b/i.test(attribute(tag, "rel")) && parsed.searchParams.has("s")) return true;
    }
    return false;
  }

  function searchCacheKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function searchQueryVariants(value) {
    const original = String(value || "").trim();
    if (!original) return [];
    const expanded = original
      .replace(/[’']/g, " ")
      .replace(/\b(dont|doesnt|didnt|wont|cant|couldnt|wouldnt|shouldnt|isnt|arent|wasnt|werent|hasnt|havent|hadnt)\b/gi, (word) => `${word.slice(0, -1)} t`)
      .replace(/\s+/g, " ")
      .trim();
    const words = expanded.split(/\s+/).filter(Boolean);
    return uniqueStrings([
      expanded,
      words.slice(0, 4).join(" "),
      words.slice(0, 3).join(" "),
    ]).filter((candidate) => searchCacheKey(candidate) !== searchCacheKey(original));
  }

  function uniqueSearchPageItems(cacheKey, page, rawItems) {
    let pages = searchPageCache.get(cacheKey);
    if (!pages) {
      pages = new Map();
      searchPageCache.set(cacheKey, pages);
    }
    pages.set(page, rawItems);
    while (searchPageCache.size > 32) searchPageCache.delete(searchPageCache.keys().next().value);

    const priorIDs = new Set();
    for (const [pageNumber, pageItems] of pages) {
      if (pageNumber >= page) continue;
      for (const item of pageItems) priorIDs.add(String(item.id || item.href || item.url));
    }
    return rawItems.filter((item) => !priorIDs.has(String(item.id || item.href || item.url)));
  }

  function rowValues(html) {
    const rows = new Map();
    for (const rowMatch of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((match) => stripHTML(match[1]))
        .filter(Boolean);
      if (cells.length < 2) continue;
      rows.set(cells[0].toLowerCase(), cells[1]);
    }
    return rows;
  }

  function parseDetailsHTML(html, href) {
    const source = String(html || "");
    const title = stripHTML(
      source.match(/<h1\b[^>]*class=(['\"])[^'\"]*\bentry-title\b[^'\"]*\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2]
        || source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        || metaContent(source, "og:title"),
    );
    if (!title) throw new Error("KingOfShojo details did not contain a title.");

    const description = stripHTML(
      source.match(/<div\b[^>]*class=(['\"])[^'\"]*\bentry-content-single\b[^'\"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]
        || metaContent(source, "og:description")
        || metaContent(source, "description"),
    );
    const rows = rowValues(source);
    const genresBlock = source.match(
      /<div\b[^>]*class=(['\"])[^'\"]*\bseriestugenre\b[^'\"]*\1[^>]*>([\s\S]*?)<\/div>/i,
    )?.[2] || "";
    const genres = uniqueStrings(
      [...genresBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => stripHTML(match[1])),
    );
    const authors = uniqueStrings([rows.get("author"), rows.get("artist")]
      .filter((value) => value && !/^n\/?a$/i.test(value)));
    const image = safeCoverURL(
      metaContent(source, "og:image")
        || metaContent(source, "twitter:image")
        || source.match(/<img\b[^>]*itemprop=(['\"])image\1[^>]*>/i)?.[0] && attribute(
          source.match(/<img\b[^>]*itemprop=(['\"])image\1[^>]*>/i)?.[0],
          "src",
        ),
    );
    const sourceID = source.match(/data-id=(['\"])(\d{1,12})\1/i)?.[2]
      || source.match(/id=(['\"])post-(\d{1,12})\1/i)?.[2]
      || "";
    const result = {
      id: href,
      href,
      url: href,
      title,
      description,
      author: authors.join(", "),
      authors,
      genres,
      status: rows.get("status") || "Unknown",
    };
    if (image) result.image = image;
    if (sourceID) result.sourceID = sourceID;
    if (rows.get("type")) result.type = rows.get("type");
    if (rows.get("released")) result.released = rows.get("released");
    return result;
  }

  function parseChapters(html, manga) {
    const source = String(html || "");
    const records = new Map();
    for (const match of source.matchAll(/<a\b[^>]*>/gi)) {
      const openingTag = match[0];
      let chapter;
      try {
        chapter = chapterReference(attribute(openingTag, "href"));
      } catch {
        continue;
      }
      if (chapter.slug !== manga.slug) continue;
      const closeIndex = source.toLowerCase().indexOf("</a>", match.index + openingTag.length);
      const endIndex = closeIndex >= 0 ? closeIndex + 4 : source.length;
      const block = source.slice(match.index, endIndex);
      const title = stripHTML(
        block.match(/<span\b[^>]*class=(['\"])[^'\"]*\bchapternum\b[^'\"]*\1[^>]*>([\s\S]*?)<\/span>/i)?.[2]
          || `Chapter ${chapter.token}`,
      ) || `Chapter ${chapter.token}`;
      const releaseDate = stripHTML(
        block.match(/<span\b[^>]*class=(['\"])[^'\"]*\bchapterdate\b[^'\"]*\1[^>]*>([\s\S]*?)<\/span>/i)?.[2] || "",
      );
      const record = {
        id: chapter.href,
        href: chapter.href,
        url: chapter.href,
        title,
        number: chapter.number,
        language: "en",
      };
      if (releaseDate) record.releaseDate = releaseDate;
      if (!records.has(chapter.key)) records.set(chapter.key, record);
      if (records.size >= MAX_CHAPTERS) break;
    }
    const output = [...records.values()];
    output.sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
    return output;
  }

  function parseReaderImages(html, chapterHref) {
    const reader = String(html || "").match(
      /<div\b[^>]*id=(['\"])readerarea\1[^>]*>([\s\S]*?)<\/div>/i,
    )?.[2] || "";
    const pages = [];
    const seen = new Set();
    for (const match of reader.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const rawURL = attribute(tag, "data-src")
        || attribute(tag, "data-lazy-src")
        || attribute(tag, "data-original")
        || attribute(tag, "src");
      const pageURL = safePageURL(rawURL);
      if (!pageURL || seen.has(pageURL)) continue;
      seen.add(pageURL);
      pages.push({
        url: pageURL,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
          Referer: chapterHref,
        },
      });
      if (pages.length > MAX_IMAGES) throw new Error("KingOfShojo returned too many page images.");
    }
    if (!pages.length) throw new Error("KingOfShojo chapter returned no readable page images.");
    return pages;
  }

  async function searchResults(query, page = 1) {
    const text = typeof query === "object" ? String(query?.text || "").trim() : String(query || "").trim();
    const currentPage = Math.max(1, Number(page) || 1);
    const isFeed = !text || text === "*" || text.startsWith("__feed:");
    const makeSearchURL = (term) => {
      const encoded = encodeURIComponent(String(term || "").slice(0, 160));
      return currentPage > 1
        ? `${BASE_URL}/page/${currentPage}/?s=${encoded}`
        : `${BASE_URL}/?s=${encoded}`;
    };
    let html;
    let rawItems;
    if (isFeed) {
      html = await request(`${BASE_URL}/`, { maxBytesHint: 12 * 1024 * 1024 });
      rawItems = parseCatalogueCards(html);
    } else {
      const cacheKey = searchCacheKey(text);
      const knownAlias = searchAliases.get(cacheKey);
      const terms = uniqueStrings([knownAlias, text, ...searchQueryVariants(text)]);
      let selectedTerm = text;
      for (const term of terms) {
        const candidateHTML = await request(makeSearchURL(term), { maxBytesHint: 12 * 1024 * 1024 });
        const candidateItems = parseSearchCards(candidateHTML);
        html = candidateHTML;
        rawItems = candidateItems;
        selectedTerm = term;
        if (candidateItems.length || term === terms[terms.length - 1]) break;
      }
      if (selectedTerm !== text) searchAliases.set(cacheKey, selectedTerm);
    }
    const items = isFeed ? rawItems : uniqueSearchPageItems(searchCacheKey(text), currentPage, rawItems);
    return {
      items,
      hasMore: !isFeed && items.length > 0 && hasNextSearchPage(html, currentPage),
    };
  }

  async function extractDetails(value) {
    const manga = mangaReference(value);
    const html = await request(manga.href, { maxBytesHint: 12 * 1024 * 1024, headers: { Referer: manga.href } });
    return parseDetailsHTML(html, manga.href);
  }

  async function extractChapters(value) {
    const manga = mangaReference(value);
    if (chapterCache.has(manga.href)) return chapterCache.get(manga.href);
    if (chapterLoads.has(manga.href)) return chapterLoads.get(manga.href);
    const load = (async () => {
      const html = await request(manga.href, { maxBytesHint: 12 * 1024 * 1024, headers: { Referer: manga.href } });
      const chapters = parseChapters(html, manga);
      if (!chapters.length) throw new Error("KingOfShojo returned no owned chapter links.");
      return chapters;
    })();
    chapterLoads.set(manga.href, load);
    try {
      const chapters = await load;
      chapterCache.set(manga.href, chapters);
      return chapters;
    } finally {
      chapterLoads.delete(manga.href);
    }
  }

  async function extractImages(value) {
    const chapter = chapterReference(value);
    const html = await request(chapter.href, { maxBytesHint: 16 * 1024 * 1024, headers: { Referer: chapter.href } });
    return parseReaderImages(html, chapter.href);
  }

  async function discoveryHome() {
    const html = await request(`${BASE_URL}/`, { maxBytesHint: 12 * 1024 * 1024 });
    const items = parseCatalogueCards(html);
    if (!items.length) throw new Error("KingOfShojo returned no discovery items.");
    return { sections: [{ id: "home", title: "KingOfShojo Home", items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    if (currentPage > 1) return { items: [], hasMore: false };
    const html = await request(`${BASE_URL}/`, { maxBytesHint: 12 * 1024 * 1024 });
    const items = parseCatalogueCards(html);
    if (!items.length) throw new Error(`KingOfShojo returned no ${String(feedID || "home")} items.`);
    return { items, hasMore: false };
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
