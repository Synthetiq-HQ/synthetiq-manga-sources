"use strict";

(() => {
  const BASE_URL = "https://lnori.com";
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
  const PAGE_SIZE = 40;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const UNSAFE_TAGS = new Set([
    "adult",
    "adult-only",
    "ecchi",
    "erotica",
    "explicit",
    "fanservice",
    "harem",
    "hentai",
    "mature",
    "nsfw",
    "porn",
    "sexual",
    "smut",
  ]);
  const responseCache = new Map();
  const responseLoads = new Map();
  const MAX_CACHED_RESPONSES = 16;

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
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function hostAllowed(hostname) {
    return hostname === "lnori.com" || hostname.endsWith(".lnori.com");
  }

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, BASE_URL);
      if (url.protocol !== "https:" || !hostAllowed(url.hostname)) return "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function sourcePath(value, kind) {
    const input = String(value || "").trim();
    let url;
    try {
      url = new URL(input, BASE_URL);
    } catch (_) {
      throw new Error(`Invalid Lnori ${kind} identifier.`);
    }
    if (url.protocol !== "https:" || url.hostname !== "lnori.com") throw new Error(`Invalid Lnori ${kind} host.`);
    const pattern = kind === "series"
      ? /^\/series\/(\d{1,8})\/([a-z0-9][a-z0-9-]{0,199})\/?$/i
      : /^\/book\/(\d{1,8})\/([a-z0-9][a-z0-9-]{0,199})\/?$/i;
    const match = url.pathname.match(pattern);
    if (!match) throw new Error(`Invalid Lnori ${kind} identifier.`);
    return `${BASE_URL}${url.pathname.replace(/\/$/, "")}`;
  }

  function isChallengePage(body) {
    const page = String(body || "").toLowerCase();
    const head = page.match(/<head\b[\s\S]*?<\/head>/i)?.[0] || page.slice(0, 16 * 1024);
    return /<title\b[^>]*>[\s\S]*?(?:just a moment|attention required|checking your browser)/i.test(head)
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

  function cached(url) {
    if (!responseCache.has(url)) return "";
    const body = responseCache.get(url);
    responseCache.delete(url);
    responseCache.set(url, body);
    return body;
  }

  function cache(url, body) {
    responseCache.delete(url);
    responseCache.set(url, body);
    while (responseCache.size > MAX_CACHED_RESPONSES) responseCache.delete(responseCache.keys().next().value);
  }

  async function request(url, options = {}) {
    const normalized = absoluteURL(url);
    if (!normalized) throw new Error("Lnori rejected a non-HTTPS or out-of-scope URL.");
    const existing = cached(normalized);
    if (existing) return existing;
    if (responseLoads.has(normalized)) return responseLoads.get(normalized);
    const load = (async () => {
      if (typeof globalThis.fetchv2 !== "function") throw new Error("Lnori requires the fetchv2 bridge.");
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await globalThis.fetchv2(
            normalized,
            { ...DEFAULT_HEADERS, ...(options.headers || {}) },
            "GET",
            null,
            {
              followRedirects: true,
              maxBytesHint: options.maxBytesHint || MAX_CATALOG_BYTES,
              responseClass: "html",
            },
          );
          const status = Number(response && response.status);
          if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
            lastError = new Error(`Lnori request failed with HTTP ${status || "error"}.`);
            if (!RETRYABLE_STATUS.has(status) || attempt === 3) break;
            continue;
          }
          if (response.bodyDropped) throw new Error("Lnori response exceeded the app size limit.");
          const body = await responseText(response);
          if (!body) throw new Error("Lnori returned an empty response.");
          if (isChallengePage(body)) throw new Error("Lnori returned a browser-verification page.");
          if (new TextEncoder().encode(body).byteLength > (options.maxBytes || MAX_CATALOG_BYTES)) {
            throw new Error("Lnori response exceeded the module safety limit.");
          }
          cache(normalized, body);
          return body;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < 3 && /HTTP (408|425|429|500|502|503|504)/.test(lastError.message)) continue;
          break;
        }
      }
      throw lastError || new Error("Lnori request failed.");
    })();
    responseLoads.set(normalized, load);
    try {
      return await load;
    } finally {
      responseLoads.delete(normalized);
    }
  }

  function tagsFrom(value) {
    return String(value || "")
      .split(",")
      .map((tag) => decodeEntities(tag).trim().toLowerCase())
      .filter(Boolean);
  }

  function hasUnsafeTags(tags) {
    return tags.some((tag) => UNSAFE_TAGS.has(tag) || [...UNSAFE_TAGS].some((unsafe) => tag.includes(unsafe)));
  }

  function titleLooksUnsafe(title) {
    return /(?:\badult(?:[- ]only)?\b|\becchi\b|\berotic(?:a)?\b|\bexplicit\b|\bharem\b|\bhentai\b|\bmature\b|\bnsfw\b|\bporn(?:ographic)?\b|\bsexual\b|\bsmut\b|18\+)/i.test(String(title || ""));
  }

  function normalizeSearchText(value) {
    return decodeEntities(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function matchesSearch(item, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return true;
    return [item.title, item.author, ...(item.genres || [])].some((field) => {
      const normalizedField = normalizeSearchText(field);
      return normalizedField.includes(normalizedQuery)
        || normalizedField.replace(/\s+/g, "").includes(normalizedQuery.replace(/\s+/g, ""));
    });
  }

  function itemFromSeriesCard(card) {
    const opening = String(card).match(/^<article\b[^>]*>/i)?.[0] || "";
    const seriesID = attribute(opening, "data-id");
    const link = String(card).match(/<a\b[^>]*href=(['"])(\/series\/\d{1,8}\/[a-z0-9][a-z0-9-]{0,199})\1[^>]*>/i)?.[2] || "";
    const title = attribute(opening, "data-t") || attribute(String(card).match(/<a\b[^>]*aria-label=(['"])[\s\S]*?\1[^>]*>/i)?.[0], "aria-label");
    const author = attribute(opening, "data-a");
    const tags = tagsFrom(attribute(opening, "data-tags"));
    const imageTag = String(card).match(/<img\b[^>]*>/i)?.[0] || "";
    const image = absoluteURL(attribute(imageTag, "data-src") || attribute(imageTag, "src") || String(card).match(/data-bg=(['"])([\s\S]*?)\1/i)?.[2]);
    if (!seriesID || !link || !title || hasUnsafeTags(tags) || titleLooksUnsafe(title)) return null;
    const href = `${BASE_URL}${link}`;
    return {
      id: href,
      href,
      title: decodeEntities(title).trim(),
      image,
      author: decodeEntities(author).trim(),
      genres: tags,
    };
  }

  function parseSeriesCards(html) {
    const items = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<article\b[^>]*\bdata-id=[\s\S]*?<\/article>/gi)) {
      const item = itemFromSeriesCard(match[0]);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function parseSeriesLinks(html) {
    const items = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<a\b[^>]*href=(['"])(\/series\/\d{1,8}\/[a-z0-9][a-z0-9-]{0,199})\1[^>]*>[\s\S]*?<\/a>/gi)) {
      const anchor = match[0];
      const href = `${BASE_URL}${match[2]}`;
      if (seen.has(href)) continue;
      const imageTag = anchor.match(/<img\b[^>]*>/i)?.[0] || "";
      const title = attribute(anchor.match(/<a\b[^>]*>/i)?.[0], "aria-label")
        || attribute(imageTag, "alt")
        || stripHTML(anchor.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
      if (!title || titleLooksUnsafe(title)) continue;
      seen.add(href);
      items.push({ id: href, href, title: decodeEntities(title).trim(), image: absoluteURL(attribute(imageTag, "data-src") || attribute(imageTag, "src")) });
    }
    return items;
  }

  function parseDetails(html, seriesURL) {
    const hero = String(html || "").match(/<article\b[^>]*class=(['"])[^'\"]*\bhero-card\b[^'\"]*\1[^>]*>[\s\S]*?<\/article>/i)?.[0] || String(html || "");
    const title = stripHTML(hero.match(/<h1\b[^>]*class=(['"])[^'\"]*\bs-title\b[^'\"]*\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2])
      || stripHTML(String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s*\|\s*Lnori\s*$/i, "");
    const author = stripHTML(hero.match(/<p\b[^>]*class=(['"])[^'\"]*\bauthor\b[^'\"]*\1[^>]*>([\s\S]*?)<\/p>/i)?.[2]);
    const tagRegion = hero.match(/<nav\b[^>]*class=(['"])[^'\"]*\btags-box\b[^'\"]*\1[^>]*>[\s\S]*?<\/nav>/i)?.[0] || "";
    const genres = [...tagRegion.matchAll(/<a\b[^>]*class=(['"])[^'\"]*\btag\b[^'\"]*\1[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => stripHTML(match[2]).toLowerCase())
      .filter((genre, index, all) => genre && all.indexOf(genre) === index);
    if (!title || hasUnsafeTags(genres) || titleLooksUnsafe(title)) throw new Error("Lnori title is unavailable under the module safety filter.");
    // Prefer the hero cover. Lnori's series-level og:image can be a collage
    // and does not match the cover returned by the library card.
    const heroImageTag = hero.match(/<img\b[^>]*>/i)?.[0] || "";
    const image = absoluteURL(
      attribute(heroImageTag, "data-src")
        || attribute(heroImageTag, "src")
        || attribute(String(html || "").match(/<meta\b[^>]*property=(['"])og:image\1[^>]*>/i)?.[0], "content"),
    );
    const description = decodeEntities(attribute(String(html || "").match(/<meta\b[^>]*name=(['"])description\1[^>]*>/i)?.[0], "content")).trim();
    return { id: seriesURL, href: seriesURL, title, author, image, description, genres };
  }

  function parseVolumes(html, seriesURL) {
    const chapters = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(/<article\b[^>]*\bdata-id=[\s\S]*?<\/article>/gi)) {
      const card = match[0];
      const hrefMatch = card.match(/<a\b[^>]*href=(['"])(\/book\/\d{1,8}\/[a-z0-9][a-z0-9-]{0,199})\1[^>]*>/i);
      if (!hrefMatch) continue;
      const href = `${BASE_URL}${hrefMatch[2]}`;
      if (seen.has(href)) continue;
      const label = attribute(hrefMatch[0], "aria-label") || stripHTML(card.match(/<h3\b[^>]*class=(['"])[^'\"]*\bcard-title\b[^'\"]*\1[^>]*>([\s\S]*?)<\/h3>/i)?.[2]) || "";
      const numberMatch = label.match(/\bvolume\s*([0-9]{1,4})\b/i) || href.match(/-vol(?:ume)?-?0*([0-9]{1,4})(?:\D|$)/i);
      if (!numberMatch) continue;
      const number = Number(numberMatch[1]);
      const image = absoluteURL(attribute(card.match(/<img\b[^>]*>/i)?.[0] || "", "data-src") || attribute(card.match(/<img\b[^>]*>/i)?.[0] || "", "src"));
      seen.add(href);
      chapters.push({ id: href, href, number, title: decodeEntities(label).trim() || `Volume ${number}`, image, language: "en" });
    }
    return chapters.sort((left, right) => left.number - right.number);
  }

  function parseBookSections(html) {
    const content = String(html || "").match(/<article\b[^>]*class=(['"])[^'\"]*\bcontent-body\b[^'\"]*\1[^>]*>([\s\S]*?)<\/article>/i)?.[2]
      || String(html || "").match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
      || "";
    if (!content) throw new Error("Lnori volume text was unavailable.");
    const headings = [];
    const headingPattern = /<h[1-6]\b[^>]*class=(['"])[^'\"]*\bchapter-title\b[^'\"]*\1[^>]*>([^<]+)<\/h[1-6]>/gi;
    for (const match of content.matchAll(headingPattern)) {
      const title = stripHTML(match[2]);
      if (title) headings.push({ title, start: match.index ?? 0 });
    }
    if (!headings.length) return [{ title: "Volume", content }];
    return headings.map((heading, index) => ({
      title: heading.title,
      content: content.slice(heading.start, headings[index + 1]?.start ?? content.length),
    }));
  }

  function chapterText(html, sectionIndex = 0) {
    const sections = parseBookSections(html);
    const selected = sections[Math.max(0, Number(sectionIndex) || 0)] || sections[0];
    const content = selected.content;
    const withoutMedia = content
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<picture\b[\s\S]*?<\/picture>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
    const parts = [];
    for (const match of withoutMedia.matchAll(/<(p|h[1-6]|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const value = stripHTML(match[3]);
      if (!value) continue;
      if (/^h[2-6]$/i.test(match[1]) && /\bsect1\b/i.test(match[2]) && /^\d+$/.test(value)) continue;
      if (parts.at(-1) !== value) parts.push(value);
    }
    const contentText = (parts.length ? parts : [stripHTML(withoutMedia)]).filter(Boolean).join("\n\n").trim();
    if (!contentText) throw new Error("Lnori volume text was empty.");
    if (new TextEncoder().encode(contentText).byteLength > MAX_TEXT_BYTES) throw new Error("Lnori volume text exceeds the app size limit.");
    return { title: selected.title || stripHTML(String(html || "").match(/<h1\b[^>]*id=(['"])book-title\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2]) || "Lnori volume", content: contentText };
  }

  async function mapWithConcurrency(values, limit, worker) {
    const output = new Array(values.length);
    let next = 0;
    async function run() {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await worker(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return output;
  }

  async function searchResults(query, page = 1) {
    const html = await request(`${BASE_URL}/library`, { maxBytes: MAX_CATALOG_BYTES, maxBytesHint: MAX_CATALOG_BYTES });
    const text = String(query || "").trim().toLowerCase();
    const items = parseSeriesCards(html).filter((item) => {
      if (!text || text.startsWith("__feed:")) return true;
      return matchesSearch(item, text);
    });
    const requestedPage = Math.max(1, Number(page) || 1);
    const start = (requestedPage - 1) * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), hasMore: start + PAGE_SIZE < items.length };
  }

  async function extractDetails(id) {
    const seriesURL = sourcePath(id, "series");
    return parseDetails(await request(seriesURL), seriesURL);
  }

  async function extractChapters(id) {
    const seriesURL = sourcePath(id, "series");
    const volumes = parseVolumes(await request(seriesURL), seriesURL);
    const expanded = await mapWithConcurrency(volumes, 2, async (volume) => {
      const bookURL = sourcePath(volume.id, "book");
      const sections = parseBookSections(await request(bookURL, { maxBytes: MAX_TEXT_BYTES, maxBytesHint: MAX_TEXT_BYTES }));
      return sections.map((section, sectionIndex) => ({
        id: `${bookURL}#section=${sectionIndex}`,
        href: `${bookURL}#section=${sectionIndex}`,
        number: 0,
        title: `Volume ${volume.number} — ${section.title}`,
        image: volume.image,
        language: "en",
      }));
    });
    let ordinal = 0;
    return expanded.flat().map((chapter) => ({ ...chapter, number: ++ordinal }));
  }

  async function extractText(id) {
    const parsed = new URL(String(id || ""), BASE_URL);
    const bookURL = sourcePath(parsed.toString().split("#")[0], "book");
    const sectionIndex = parsed.hash.match(/section=(\d+)/i)?.[1] || 0;
    return chapterText(await request(bookURL, { maxBytes: MAX_TEXT_BYTES, maxBytesHint: MAX_TEXT_BYTES }), sectionIndex);
  }

  async function discoveryHome() {
    const html = await request(BASE_URL, { maxBytes: 2 * 1024 * 1024, maxBytesHint: 2 * 1024 * 1024 });
    return { sections: [{ id: "featured", title: "Featured", items: parseSeriesLinks(html).slice(0, PAGE_SIZE) }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase();
    if (feed !== "featured" && feed !== "popular" && feed !== "latest") return { items: [], hasMore: false };
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
