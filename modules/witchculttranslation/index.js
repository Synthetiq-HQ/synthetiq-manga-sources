"use strict";

(() => {
  const BASE_URL = "https://witchculttranslation.com";
  const SERIES_ID = "rezero-web-novel";
  const TOC_URL = `${BASE_URL}/table-of-content/`;
  const LOGO_URL = `${BASE_URL}/wp-content/uploads/2024/08/wct_logo_new_100.svg?x97423`;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const responseCache = new Map();
  const responseLoads = new Map();

  const SERIES = {
    id: SERIES_ID,
    href: TOC_URL,
    title: "Re:Zero Web Novel Translations",
    image: LOGO_URL,
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

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    try {
      const url = new URL(input, BASE_URL);
      if (url.hostname !== "witchculttranslation.com") return "";
      if (url.protocol === "http:") url.protocol = "https:";
      if (url.protocol !== "https:") return "";
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function normalizeSeries(value) {
    const input = String(value || "").trim();
    if (input === SERIES_ID || input === "re-zero" || input === "rezero") return SERIES_ID;
    const url = absoluteURL(input);
    if (url && new URL(url).pathname.replace(/\/$/, "") === "/table-of-content") return SERIES_ID;
    throw new Error("Invalid Witch Cult Translations series identifier.");
  }

  function normalizeChapter(value) {
    const url = absoluteURL(value);
    if (!url) throw new Error("Invalid Witch Cult Translations chapter URL.");
    const parsed = new URL(url);
    if (parsed.pathname.includes("/wp-content/uploads/") || /\.pdf$/i.test(parsed.pathname)) {
      throw new Error("Witch Cult Translations PDF chapters are not text chapters.");
    }
    if (!/^\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9][a-z0-9%_~.-]*\/?$/i.test(parsed.pathname)) {
      throw new Error("Invalid Witch Cult Translations chapter URL.");
    }
    parsed.hash = "";
    return parsed.toString();
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
    while (responseCache.size > 24) responseCache.delete(responseCache.keys().next().value);
  }

  async function request(url, options = {}) {
    const normalized = absoluteURL(url);
    if (!normalized) throw new Error("Witch Cult Translations rejected an out-of-scope URL.");
    const existing = cached(normalized);
    if (existing) return existing;
    if (responseLoads.has(normalized)) return responseLoads.get(normalized);
    const load = (async () => {
      if (typeof globalThis.fetchv2 !== "function") throw new Error("Witch Cult Translations requires the fetchv2 bridge.");
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
              maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
              responseClass: "html",
            },
          );
          const status = Number(response && response.status);
          if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
            lastError = new Error(`Witch Cult Translations request failed with HTTP ${status || "error"}.`);
            if (!RETRYABLE_STATUS.has(status) || attempt === 3) break;
            continue;
          }
          if (response.bodyDropped) throw new Error("Witch Cult Translations response exceeded the app size limit.");
          const body = await responseText(response);
          if (!body) throw new Error("Witch Cult Translations returned an empty response.");
          if (isChallengePage(body)) throw new Error("Witch Cult Translations returned a browser-verification page.");
          if (new TextEncoder().encode(body).byteLength > (options.maxBytes || MAX_RESPONSE_BYTES)) {
            throw new Error("Witch Cult Translations response exceeded the module safety limit.");
          }
          cache(normalized, body);
          return body;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < 3 && /HTTP (408|425|429|500|502|503|504)/.test(lastError.message)) continue;
          break;
        }
      }
      throw lastError || new Error("Witch Cult Translations request failed.");
    })();
    responseLoads.set(normalized, load);
    try {
      return await load;
    } finally {
      responseLoads.delete(normalized);
    }
  }

  function searchMatches(query) {
    const text = String(query || "").trim().toLowerCase();
    return !text || /re\s*:?\s*zero|rezero|witch\s*cult|web\s*novel|wct/.test(text);
  }

  function chapterLabelAllowed(label) {
    return /^(?:arc\s+[ivx0-9]+\s*[,:-]?\s*)?(?:chapter\s+\d+|interlude\b|prologue\b|curtain(?:['’]s)?\s+close\b)/i.test(label);
  }

  function chapterSortInfo(item, order) {
    const arcMatch = `${item.title} ${item.href}`.match(/arc[-\s]+([0-9]+)/i);
    const chapterMatch = item.title.match(/\bchapter\s+(\d+)/i);
    const arc = arcMatch ? Number(arcMatch[1]) : /prologue/i.test(item.title) ? 1 : Number.MAX_SAFE_INTEGER;
    const chapter = chapterMatch ? Number(chapterMatch[1]) : /prologue/i.test(item.title) ? 0 : Number.MAX_SAFE_INTEGER;
    return { ...item, arc, chapter, order };
  }

  function parseChapterLinks(html) {
    const candidates = [];
    const seen = new Set();
    let order = 0;
    for (const match of String(html || "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const anchor = match[0];
      const rawHref = attribute(anchor.match(/^<a\b[^>]*>/i)?.[0], "href");
      const href = absoluteURL(rawHref);
      if (!href) continue;
      const url = new URL(href);
      if (url.pathname.includes("/wp-content/uploads/") || /\.(?:pdf|zip)$/i.test(url.pathname)) continue;
      if (!/^\/\d{4}\/\d{2}\/\d{2}\//.test(url.pathname)) continue;
      const title = stripHTML(anchor);
      if (!chapterLabelAllowed(title)) continue;
      const canonical = `${url.origin}${url.pathname}${url.search}`;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      candidates.push(chapterSortInfo({ id: canonical, href: canonical, title, language: "en" }, order));
      order += 1;
    }
    candidates.sort((left, right) => left.arc - right.arc || left.chapter - right.chapter || left.order - right.order);
    return candidates.map(({ arc, chapter, order: originalOrder, ...chapterItem }, index) => ({
      ...chapterItem,
      number: index + 1,
      volume: Number.isFinite(arc) && arc !== Number.MAX_SAFE_INTEGER ? `Arc ${arc}` : undefined,
    }));
  }

  function parseArticleText(html) {
    const article = String(html || "").match(/<article\b[\s\S]*?<\/article>/i)?.[0] || "";
    const content = article.match(/<div\b[^>]*class=(['"])[^'\"]*\bentry-content\b[^'\"]*\1[^>]*>([\s\S]*)<\/div>/i)?.[2] || "";
    if (!content) throw new Error("Witch Cult Translations chapter text was unavailable.");
    const parts = [];
    const clean = content
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<figure\b[\s\S]*?<\/figure>/gi, " ")
      .replace(/<img\b[^>]*>/gi, " ");
    for (const match of clean.matchAll(/<(p|h[2-6]|blockquote|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      if (/\b(?:sharedaddy|share-buttons|post-edit-link)\b/i.test(match[2])) continue;
      const value = stripHTML(match[3]);
      if (value && parts.at(-1) !== value) parts.push(value);
    }
    const contentText = parts.join("\n\n").trim();
    if (!contentText) throw new Error("Witch Cult Translations chapter text was empty.");
    if (new TextEncoder().encode(contentText).byteLength > MAX_TEXT_BYTES) throw new Error("Witch Cult Translations chapter text exceeds the app limit.");
    const title = stripHTML(article.match(/<h1\b[^>]*class=(['"])[^'\"]*\bentry-title\b[^'\"]*\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2]) || "Re:Zero Web Novel chapter";
    return { title, content: contentText };
  }

  async function searchResults(query) {
    return { items: searchMatches(query) ? [{ ...SERIES }] : [], hasMore: false };
  }

  async function extractDetails(id) {
    normalizeSeries(id);
    const html = await request(TOC_URL, { maxBytesHint: MAX_RESPONSE_BYTES });
    const image = absoluteURL(attribute(String(html || "").match(/<img\b[^>]*alt=(['"])WCT Logo\1[^>]*>/i)?.[0], "src")) || SERIES.image;
    return {
      ...SERIES,
      title: "Re:Zero Web Novel Translations",
      author: "Tappei Nagatsuki",
      image,
      description: "Free public Re:Zero web novel translation chapters collected by arc.",
      genres: ["Fantasy", "Web Novel"],
    };
  }

  async function extractChapters(id) {
    normalizeSeries(id);
    return parseChapterLinks(await request(TOC_URL, { maxBytesHint: MAX_RESPONSE_BYTES }));
  }

  async function extractText(id) {
    return parseArticleText(await request(normalizeChapter(id), { maxBytes: MAX_TEXT_BYTES, maxBytesHint: MAX_TEXT_BYTES }));
  }

  async function discoveryHome() {
    return { sections: [{ id: "rezero", title: "Re:Zero Web Novel", items: [{ ...SERIES }] }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (String(feedID || "").toLowerCase() !== "rezero" || Number(page) > 1) return { items: [], hasMore: false };
    return { items: [{ ...SERIES }], hasMore: false };
  }

  globalThis.SynthetiqModule = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractChapters = extractChapters;
  globalThis.extractText = extractText;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
