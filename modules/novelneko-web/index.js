"use strict";

(() => {
  const BASE_URL = "https://novelneko.fr";
  const WEBNOVEL_BASE_URL = `${BASE_URL}/webnovels/`;
  const CATALOG_URL = `${WEBNOVEL_BASE_URL}webnovel.json`;
  const MAX_TEXT_BYTES = 4 * 1024 * 1024;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_CHAPTERS = 10_000;
  const PAGE_SIZE = 24;
  const MAX_CACHED_RESPONSES = 64;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
    Referer: WEBNOVEL_BASE_URL,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const REQUIRED_ENTRY_TYPE = "web novel";
  const ALTERNATE_ENTRY_TYPE = "light novel";
  const UNSAFE_MARKERS = [
    "adult",
    "adulte",
    "adult-only",
    "erotica",
    "erotique",
    "explicit",
    "hentai",
    "paid",
    "payant",
    "premium",
    "locked",
    "lock",
    "nsfw",
    "porn",
    "r18",
    "smut",
    "sexual",
    "verrouille",
    "verrouillage",
    "yaoi",
    "yuri",
  ];
  const RESTRICTED_CHAPTER_TEXT_RE = /(?:^|\b)(?:this chapter|ce chapitre|chapitre)\b[\s\S]{0,180}\b(?:paid|payant|premium|locked|verrouille|verrouillage|login required|requires login|requires payment|necessite un paiement|unavailable|indisponible)\b|^\s*(?:paid|payant|premium|locked|verrouille|verrouillage|login required|requires login|requires payment|necessite un paiement|unavailable|indisponible)\b/i;
  const responseCache = new Map();
  const responseLoads = new Map();
  const detailLoads = new Map();
  let catalogLoad = null;

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
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function normalizeSafety(value) {
    return decodeEntities(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[+_]/g, " ")
      .replace(/[^a-z0-9-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasUnsafeMarker(values) {
    const haystack = (Array.isArray(values) ? values : [values]).map(normalizeSafety).join(" ");
    return UNSAFE_MARKERS.some((marker) => {
      const normalized = normalizeSafety(marker);
      return new RegExp(`(?:^|\\s)${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`, "i").test(haystack)
        || haystack.includes(normalized);
    });
  }

  function hasRestrictedChapterNotice(value) {
    return RESTRICTED_CHAPTER_TEXT_RE.test(normalizeSafety(value));
  }

  function isSupportedEntryType(value) {
    const normalized = normalizeSafety(value);
    return normalized === REQUIRED_ENTRY_TYPE || normalized === ALTERNATE_ENTRY_TYPE;
  }

  function ensureAllowedURL(value, base = WEBNOVEL_BASE_URL) {
    const input = String(value || "").trim();
    if (!input) throw new Error("NovelNeko returned an empty URL.");
    let parsed;
    try {
      parsed = new URL(input, base);
    } catch (_) {
      throw new Error("NovelNeko returned an invalid URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "novelneko.fr") {
      throw new Error("NovelNeko returned a URL outside the module allowlist.");
    }
    return parsed.toString();
  }

  function optionalURL(value, base = WEBNOVEL_BASE_URL) {
    if (!String(value || "").trim()) return "";
    try {
      return ensureAllowedURL(value, base);
    } catch (_) {
      return "";
    }
  }

  function slugFromValue(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("NovelNeko identifier is empty.");
    let slug = input;
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.hostname !== "novelneko.fr") throw new Error("Invalid NovelNeko identifier.");
      const match = url.pathname.match(/^\/webnovels\/([^/]+)(?:\/|$)/i);
      if (!match) throw new Error("Invalid NovelNeko web-novel URL.");
      slug = decodeURIComponent(match[1]);
    } else {
      slug = input.replace(/^\/+|\/+$/g, "").replace(/^webnovels\//i, "").split("/")[0];
    }
    if (!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,199}$/u.test(slug)) throw new Error("Invalid NovelNeko web-novel identifier.");
    return slug;
  }

  function novelURL(slug) {
    return `${WEBNOVEL_BASE_URL}${slug}/`;
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") return response.text();
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function cachedResponse(url) {
    if (!responseCache.has(url)) return "";
    const body = responseCache.get(url);
    responseCache.delete(url);
    responseCache.set(url, body);
    return body;
  }

  function cacheResponse(url, body) {
    if (responseCache.has(url)) responseCache.delete(url);
    responseCache.set(url, body);
    while (responseCache.size > MAX_CACHED_RESPONSES) responseCache.delete(responseCache.keys().next().value);
  }

  async function request(url, options = {}) {
    const requestURL = ensureAllowedURL(url);
    const cacheable = options.cacheable !== false;
    if (cacheable) {
      const cached = cachedResponse(requestURL);
      if (cached) return cached;
    }
    if (responseLoads.has(requestURL)) return responseLoads.get(requestURL);
    const load = (async () => {
      if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelNeko requires the fetchv2 bridge.");
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (attempt > 1) await sleep(500 * attempt);
        try {
          const response = await globalThis.fetchv2(
            requestURL,
            { ...DEFAULT_HEADERS, ...(options.headers || {}) },
            "GET",
            null,
            {
              followRedirects: true,
              maxBytesHint: options.maxBytesHint || MAX_RESPONSE_BYTES,
              responseClass: options.responseClass || "html",
            },
          );
          const status = Number(response && response.status);
          if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
            lastError = new Error(`NovelNeko request failed with HTTP ${status || "error"}.`);
            if (!RETRYABLE_STATUS.has(status)) break;
            continue;
          }
          if (response.bodyDropped) throw new Error("NovelNeko response exceeded the module size limit.");
          if (response.finalUrl) ensureAllowedURL(response.finalUrl);
          const body = await responseText(response);
          if (!body) throw new Error("NovelNeko returned an empty response.");
          if (options.responseClass === "text" && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(String(response.contentType || "").trim())) {
            throw new Error("NovelNeko returned HTML instead of chapter text.");
          }
          if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(body) && options.responseClass === "text") {
            throw new Error("NovelNeko returned HTML instead of chapter text.");
          }
          if (cacheable) cacheResponse(requestURL, body);
          return body;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!/HTTP (408|425|429|500|502|503|504)/.test(lastError.message)) break;
        }
      }
      throw lastError || new Error("NovelNeko request failed.");
    })();
    responseLoads.set(requestURL, load);
    try {
      return await load;
    } finally {
      responseLoads.delete(requestURL);
    }
  }

  function parseCatalog(body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      throw new Error("NovelNeko web-novel catalog was not valid JSON.");
    }
    if (!Array.isArray(parsed)) throw new Error("NovelNeko web-novel catalog was not an array.");
    const seen = new Set();
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      try {
        const slug = slugFromValue(entry.link);
        const href = novelURL(slug);
        if (seen.has(slug)) return [];
        const title = decodeEntities(String(entry.title || "")).trim();
        if (!title) return [];
        const declaredType = decodeEntities(String(entry.type || "")).trim();
        if (declaredType && !isSupportedEntryType(declaredType)) return [];
        if (hasUnsafeMarker([title, entry.subtitle, declaredType])) return [];
        seen.add(slug);
        return [{
          id: href,
          href,
          slug,
          title,
          image: optionalURL(entry.image, WEBNOVEL_BASE_URL),
          subtitle: decodeEntities(String(entry.subtitle || "")).trim(),
          type: declaredType,
        }];
      } catch (_) {
        return [];
      }
    });
  }

  async function catalog() {
    if (!catalogLoad) catalogLoad = request(CATALOG_URL, { responseClass: "json", maxBytesHint: MAX_RESPONSE_BYTES }).then(parseCatalog);
    return catalogLoad;
  }

  function section(html, className) {
    return String(html || "").match(new RegExp(`<[^>]+class=(['"])[^'"]*\\b${className}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"))?.[2] || "";
  }

  function labelledValue(html, label) {
    const labels = Array.isArray(label) ? label : [label];
    for (const candidate of labels) {
      const pattern = new RegExp(`<div\\b[^>]*>\\s*<strong\\b[^>]*>\\s*${candidate}\\s*:?\\s*<\\/strong>\\s*([\\s\\S]*?)<\\/div>`, "i");
      const value = stripHTML(String(html || "").match(pattern)?.[1] || "");
      if (value) return value;
    }
    return "";
  }

  function parseGenres(html) {
    const region = String(html || "").match(/<div\b[^>]*class=(['"])[^'"]*\bgenres\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2] || "";
    return [...region.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => stripHTML(match[1]))
      .filter((value, index, all) => value && all.indexOf(value) === index);
  }

  function parseDetailsHTML(html, href, catalogEntry = null) {
    const source = String(html || "");
    const title = stripHTML(source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
    const genres = parseGenres(source);
    if (!title || !genres.length) throw new Error("NovelNeko safety metadata is missing; title rejected.");
    const author = labelledValue(source, "Auteur");
    const translator = labelledValue(source, "Traducteur");
    const status = labelledValue(source, ["Statut", "Status"]);
    const type = labelledValue(source, "Type");
    const publicationDate = labelledValue(source, "Date de parution");
    const synopsis = stripHTML(source.match(/<div\b[^>]*class=(['"])[^'"]*\bsynopsis-box\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2])
      .replace(/^Synopsis\s*:\s*/i, "")
      .trim();
    if (hasUnsafeMarker([
      title,
      ...genres,
      catalogEntry?.subtitle || "",
      catalogEntry?.type || "",
      synopsis,
      status,
      type,
      publicationDate,
    ])) {
      throw new Error("NovelNeko title is unavailable under the strict safety filter: adult, paid, premium, or locked metadata.");
    }
    if (type && !isSupportedEntryType(type)) {
      throw new Error("NovelNeko entry type is not a supported novel format.");
    }
    const countText = stripHTML(source.match(/<div\b[^>]*class=(['"])[^'"]*\bchapter-count\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/i)?.[2]);
    const chapterCount = Number((countText.match(/\d[\d\s.,]*/)?.[0] || "").replace(/[\s.,]/g, ""));
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > MAX_CHAPTERS) {
      throw new Error("NovelNeko chapter metadata is missing or invalid.");
    }
    const coverTag = source.match(/<img\b[^>]*\bclass=(['"])[^'"]*\bcover\b[^'"]*\1[^>]*>/i)?.[0] || "";
    const slug = slugFromValue(href);
    const item = {
      id: novelURL(slug),
      href: novelURL(slug),
      title,
      image: ensureAllowedURL(attribute(coverTag, "src"), novelURL(slug)),
      description: synopsis,
      synopsis,
      author,
      translator,
      status,
      type: type || "Web Novel",
      publicationDate,
      genres,
      chapterCount,
      language: "fr",
    };
    if (!item.author || !item.description) {
      throw new Error("NovelNeko detail metadata is incomplete; title rejected.");
    }
    return item;
  }

  function detailsForEntry(entry) {
    if (detailLoads.has(entry.slug)) return detailLoads.get(entry.slug);
    const load = request(entry.href, { maxBytesHint: MAX_RESPONSE_BYTES }).then((html) => parseDetailsHTML(html, entry.href, entry));
    detailLoads.set(entry.slug, load);
    return load;
  }

  function normalizeSearchText(value) {
    return decodeEntities(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function matchesQuery(item, query) {
    const needle = normalizeSearchText(query);
    if (!needle) return true;
    return [item.title, item.author, ...(item.genres || [])].some((value) => normalizeSearchText(value).includes(needle));
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

  async function safeCatalogueItems(query) {
    const entries = (await catalog()).filter((entry) => !query || matchesQuery(entry, query));
    const checked = await mapWithConcurrency(entries, 3, async (entry) => {
      try {
        const details = await detailsForEntry(entry);
        return { ...details, image: details.image || entry.image };
      } catch (_) {
        return null;
      }
    });
    return checked.filter(Boolean);
  }

  async function searchResults(query, page = 1) {
    const text = String(query || "").trim();
    const effectiveQuery = text.startsWith("__feed:") ? "" : text;
    const items = await safeCatalogueItems(effectiveQuery);
    const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
    const start = (requestedPage - 1) * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), hasMore: start + PAGE_SIZE < items.length };
  }

  async function extractDetails(id) {
    const slug = slugFromValue(id);
    const entry = (await catalog()).find((candidate) => candidate.slug === slug) || {
      id: novelURL(slug),
      href: novelURL(slug),
      slug,
      title: "",
      subtitle: "",
    };
    return detailsForEntry(entry);
  }

  function chapterReaderURL(slug, number) {
    return `${novelURL(slug)}lecture.html?chapitre=${number}`;
  }

  function parseChapterReference(value) {
    const input = String(value || "").trim();
    const url = new URL(input, WEBNOVEL_BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "novelneko.fr") throw new Error("Invalid NovelNeko chapter URL.");
    const match = url.pathname.match(/^\/webnovels\/([^/]+)\/lecture\.html$/i);
    if (!match) throw new Error("NovelNeko chapter identifier must be a public reader URL.");
    const number = Number(url.searchParams.get("chapitre"));
    if (!Number.isInteger(number) || number < 1 || number > MAX_CHAPTERS) throw new Error("Invalid NovelNeko chapter number.");
    return { slug: decodeURIComponent(match[1]), number, url: url.toString() };
  }

  async function extractChapters(id) {
    const details = await extractDetails(id);
    const slug = slugFromValue(details.id);
    return Array.from({ length: details.chapterCount }, (_, index) => {
      const number = index + 1;
      const href = chapterReaderURL(slug, number);
      return {
        id: href,
        href,
        title: `Chapitre ${String(number).padStart(3, "0")}`,
        number,
        language: "fr",
      };
    });
  }

  function chapterFileCandidates(readerHTML, readerURL, number) {
    const block = String(readerHTML || "").match(/const\s+possibleFiles\s*=\s*\[([\s\S]*?)\];/i)?.[1] || "";
    const templates = [...block.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((match) => match[1]);
    const fallback = [
      "chapters/chapitre_${chapitreStr}_fr.txt",
      "chapters/chapitre_${chapitreStr}.txt",
      "chapters/chapitre-${chapitreStr}.txt",
      "chapters/${chapitreStr}.txt",
      "chapters/chapitre_${chapitreStr}/chapter.txt",
      "chapters/chapitre_${chapitreStr}/text.txt",
      "chapters/chapitre_${chapitreStr}/content.txt",
      "chapters/chapitre_${chapitreStr}/${chapitreStr}.txt",
      "chapters/chapitre_${chapitre}/chapter.txt",
    ];
    const paddedNumber = String(number).padStart(3, "0");
    const candidates = (templates.length ? templates : fallback).map((template) => template
      .replaceAll("${chapitreStr}", paddedNumber)
      .replaceAll("${chapitre}", String(number)));
    const seen = new Set();
    return candidates.flatMap((candidate) => {
      try {
        const url = ensureAllowedURL(candidate, readerURL);
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith(`/webnovels/${encodeURIComponent(slugFromValue(readerURL))}/`)) return [];
        if (!parsed.pathname.toLowerCase().endsWith(".txt") || seen.has(url)) return [];
        seen.add(url);
        return [url];
      } catch (_) {
        return [];
      }
    });
  }

  function normalizeChapterText(value) {
    const text = String(value || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!text) throw new Error("NovelNeko chapter text was empty.");
    if (/^\s*(?:<!doctype\s+html|<html\b|<title>404)/i.test(text)) throw new Error("NovelNeko chapter file was not valid text.");
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new Error("NovelNeko chapter text exceeded the module size limit.");
    if (hasRestrictedChapterNotice(text)) throw new Error("NovelNeko chapter text is unavailable because it is paid, locked, or requires access.");
    return text;
  }

  function chapterTitle(readerHTML, number) {
    const requested = `Chapitre ${String(number).padStart(3, "0")}`;
    const sourceTitle = stripHTML(String(readerHTML || "").match(/<h1\b[^>]*id=(['"])titreChapitre\1[^>]*>([\s\S]*?)<\/h1>/i)?.[2]);
    if (!sourceTitle) return requested;
    return sourceTitle.replace(/Chapitre\s+\d+/i, requested);
  }

  async function extractText(id) {
    const reference = parseChapterReference(id);
    const details = await extractDetails(reference.slug);
    if (reference.number > details.chapterCount) throw new Error("NovelNeko chapter number is outside the public chapter range.");
    const readerHTML = await request(reference.url, { maxBytesHint: MAX_RESPONSE_BYTES });
    const candidates = chapterFileCandidates(readerHTML, reference.url, reference.number);
    let contentError = null;
    for (const candidate of candidates) {
      try {
        const body = await request(candidate, { responseClass: "text", maxBytesHint: MAX_TEXT_BYTES, cacheable: false });
        const content = normalizeChapterText(body);
        return { title: chapterTitle(readerHTML, reference.number), content };
      } catch (error) {
        contentError = error;
      }
    }
    throw contentError || new Error("NovelNeko chapter text was unavailable.");
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:all", 1);
    return { sections: [{ id: "webnovels", title: "Web-Novels", items: result.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (String(feedID || "").toLowerCase() !== "webnovels") return { items: [], hasMore: false };
    return searchResults("__feed:webnovels", page);
  }

  globalThis.SynthetiqModule = { searchResults, extractDetails, extractChapters, extractText, discoveryHome, discoveryFeed };
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractChapters = extractChapters;
  globalThis.extractText = extractText;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
