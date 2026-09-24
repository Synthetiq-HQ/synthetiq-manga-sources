"use strict";

(() => {
  const BASE_URL = "https://novelneko.fr";
  const LIGHTNOVEL_ROOT = `${BASE_URL}/lightnovels/`;
  const CATALOG_URL = `${LIGHTNOVEL_ROOT}lightnovel.json`;
  const PAGE_SIZE = 24;
  const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
  const MAX_DETAIL_BYTES = 4 * 1024 * 1024;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
    Referer: LIGHTNOVEL_ROOT,
  };
  const UNSAFE_MARKER_RE = /(^|[^a-z0-9])(adult|adulte|adult-only|ecchi|erotica|erotic|explicit|fanservice|harem|hentai|mature|nsfw|porn|sexual|smut|yaoi|yuri)([^a-z0-9]|$)/i;
  const VOLUME_RESTRICTED_MARKER_RE = /(^|[^a-z0-9])(adult|adulte|adult-only|ecchi|erotica|erotique|erotic|explicit|fanservice|harem|hentai|mature|nsfw|porn|r18|sexual|smut|yaoi|yuri|paid|payant|premium|locked|verrouille|login-required|login required|requires-login|requires login|unavailable|indisponible|not-available|not available|non-disponible|non disponible)(?=$|[^a-z0-9])/i;
  const VOLUME_SAFETY_KEYS = new Set([
    "safety", "content-safety", "rating", "age-rating", "adult", "mature", "nsfw", "explicit",
    "data-safety", "data-content-safety", "data-rating", "data-age-rating", "data-adult",
    "data-mature", "data-nsfw", "data-explicit",
  ]);
  const VOLUME_AVAILABILITY_KEYS = new Set([
    "availability", "access", "accessibility", "access-status", "status", "premium", "paid", "locked",
    "login-required", "requires-login", "unavailable", "data-availability", "data-access",
    "data-accessibility", "data-access-status", "data-status", "data-premium", "data-paid",
    "data-locked", "data-login-required", "data-requires-login", "data-unavailable",
  ]);
  const SAFE_VOLUME_VALUES = /^(?:safe|clean|general|all-ages|all ages|tout public|tous publics|false|no|non|0)$/i;
  const PUBLIC_VOLUME_VALUES = /^(?:public|available|accessible|free|gratuit|gratuitement|libre|true|yes|oui|1)$/i;
  const catalogCache = new Map();
  const detailCache = new Map();

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(String(value || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function normalizeForSearch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function hasUnsafeMarker(values) {
    return values.some((value) => UNSAFE_MARKER_RE.test(normalizeForSearch(value)));
  }

  function normalizeMetadata(value) {
    return decodeEntities(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[+_]/g, " ")
      .replace(/[^a-z0-9-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasRestrictedVolumeMetadata(values) {
    return values.some((value) => VOLUME_RESTRICTED_MARKER_RE.test(normalizeMetadata(value)));
  }

  function hostAllowed(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "novelneko.fr" || host.endsWith(".novelneko.fr");
  }

  function safeURL(value, kind = "URL") {
    let parsed;
    try {
      parsed = new URL(String(value || ""), LIGHTNOVEL_ROOT);
    } catch (_) {
      throw new Error(`NovelNeko returned an invalid ${kind}.`);
    }
    if (parsed.protocol !== "https:" || !hostAllowed(parsed.hostname)) {
      throw new Error(`NovelNeko returned an out-of-scope ${kind}.`);
    }
    return parsed;
  }

  function seriesURL(value) {
    const parsed = safeURL(value, "series URL");
    const match = parsed.pathname.match(/^\/lightnovels\/([a-z0-9][a-z0-9_-]{0,120})\/?$/i);
    if (!match) throw new Error("NovelNeko returned an invalid light-novel URL.");
    return `${BASE_URL}/lightnovels/${match[1]}/`;
  }

  function responseBody(response) {
    if (!response) return "";
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return responseBody(response);
  }

  function assertResponse(response, label) {
    const status = Number(response && response.status);
    if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`NovelNeko ${label} request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) throw new Error(`NovelNeko ${label} response was dropped.`);
  }

  async function fetchResponse(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("NovelNeko requires the fetchv2 bridge.");
    const parsed = safeURL(url, "request URL");
    const response = await globalThis.fetchv2(
      parsed.toString(),
      { ...DEFAULT_HEADERS, ...(options.headers || {}) },
      options.method || "GET",
      options.body || null,
      {
        followRedirects: true,
        maxBytesHint: options.maxBytesHint || MAX_DETAIL_BYTES,
        responseClass: options.responseClass || "html",
      },
    );
    assertResponse(response, options.label || "source");
    return response;
  }

  async function fetchJSON(url, label, maxBytesHint) {
    const response = await fetchResponse(url, { label, maxBytesHint, responseClass: "json" });
    if (typeof response.json === "function") {
      try {
        return await response.json();
      } catch (_) {
        // Use the body parser below for runtimes that only expose text().
      }
    }
    try {
      return JSON.parse(await responseText(response));
    } catch (_) {
      throw new Error(`NovelNeko returned invalid ${label} JSON.`);
    }
  }

  async function fetchHTML(url) {
    const response = await fetchResponse(url, { label: "detail", maxBytesHint: MAX_DETAIL_BYTES, responseClass: "html" });
    const body = await responseText(response);
    if (!body.trim()) throw new Error("NovelNeko returned an empty detail page.");
    return body;
  }

  function attribute(tag, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
    return match ? decodeEntities(match[2].trim()) : "";
  }

  function attributes(tag) {
    const values = [];
    const pattern = /([a-z_:][a-z0-9:._-]*)\s*=\s*(["'])([\s\S]*?)\2/gi;
    let match;
    while ((match = pattern.exec(String(tag || "")))) {
      values.push({ name: match[1].toLowerCase(), value: decodeEntities(match[3].trim()) });
    }
    return values;
  }

  function classBlock(html, className) {
    const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class=[\"'][^\"']*\\b${className}\\b[^\"']*[\"'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
    return html.match(pattern)?.[2] || "";
  }

  function strongField(html, label) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<[^>]+>\\s*<strong>\\s*${escaped}\\s*:\\s*<\\/strong>\\s*([\\s\\S]*?)<\\/[^>]+>`, "i");
    return stripHTML(html.match(pattern)?.[1] || "");
  }

  function titleFromHTML(html, fallback) {
    const h1 = stripHTML(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
    if (h1) return h1;
    const title = stripHTML(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/\s*[–-]\s*NovelNeko\s*$/i, "")
      .trim();
    return title || fallback;
  }

  function detailCover(html, series) {
    const coverTag = html.match(/<img\b[^>]*class=["'][^"']*\bcover\b[^"']*["'][^>]*>/i)?.[0] || "";
    const source = attribute(coverTag, "src");
    if (!source) return "";
    const cover = safeURL(new URL(source, series).toString(), "cover URL");
    return cover.toString();
  }

  function parseVolumeNumber(label, href) {
    const value = `${label} ${href}`;
    const match = value.match(/(?:tome|volume|vol\.?)[\s._-]*(\d+)(?:[.,_-](\d+))?/i);
    if (!match) return null;
    const number = Number(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
    return Number.isFinite(number) ? number : null;
  }

  function volumeContext(html, anchorIndex, anchorEnd) {
    const prefix = html.slice(0, anchorIndex);
    const openings = [...prefix.matchAll(/<div\b[^>]*class=["'][^"']*\bchapter-item\b[^"']*["'][^>]*>/gi)];
    const opening = openings.at(-1);
    if (!opening) return { block: "", openingTag: "" };
    const start = opening.index;
    const end = html.indexOf("</div>", anchorEnd);
    if (end < start) return { block: "", openingTag: "" };
    return { block: html.slice(start, end + 6), openingTag: opening[0] };
  }

  function volumeMetadata(context, anchorTag) {
    const block = context.block || anchorTag;
    const tags = [...block.matchAll(/<[^>]+>/g)].flatMap((match) => attributes(match[0]));
    const safetyValues = [];
    const availabilityValues = [];
    const markerValues = [stripHTML(block)];
    for (const entry of tags) {
      markerValues.push(entry.value);
      if (VOLUME_SAFETY_KEYS.has(entry.name)) safetyValues.push(entry.value);
      if (VOLUME_AVAILABILITY_KEYS.has(entry.name)) availabilityValues.push(entry.value);
    }
    const labelled = [...block.matchAll(/<([a-z0-9]+)\b[^>]*class=["'][^"']*\b(safety|rating|availability|access|status)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)];
    for (const match of labelled) {
      const value = stripHTML(match[3]);
      if (!value) continue;
      markerValues.push(value);
      if (/safety|rating/i.test(match[2])) safetyValues.push(value);
      if (/availability|access|status/i.test(match[2])) availabilityValues.push(value);
    }
    const normalizedSafety = safetyValues.map(normalizeMetadata).filter(Boolean);
    const normalizedAvailability = availabilityValues.map(normalizeMetadata).filter(Boolean);
    const safe = normalizedSafety.some((value) => SAFE_VOLUME_VALUES.test(value));
    const publicallyAvailable = normalizedAvailability.some((value) => PUBLIC_VOLUME_VALUES.test(value));
    const restricted = hasRestrictedVolumeMetadata(markerValues);
    const hasExplicitVolumeMetadata = safetyValues.length > 0 || availabilityValues.length > 0;
    const hasCompletePublicMetadata = safetyValues.length > 0
      && availabilityValues.length > 0
      && safe
      && publicallyAvailable;
    return {
      // NovelNeko's live pages use direct public PDF links without per-volume
      // data attributes. Treat that ordinary public-link shape as available,
      // while rejecting any partial or contradictory restriction metadata.
      accepted: !restricted && (!hasExplicitVolumeMetadata || hasCompletePublicMetadata),
      restricted,
    };
  }

  function parseVolumes(html, series) {
    const volumes = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    let sourceOrder = 0;
    while ((match = anchorPattern.exec(html))) {
      const href = match[1];
      if (!/\.pdf(?:$|[?#])/i.test(href)) continue;
      const parsed = safeURL(new URL(href, series).toString(), "PDF volume URL");
      const pathname = parsed.pathname;
      const seriesPath = new URL(series).pathname.replace(/\/?$/, "/");
      if (!pathname.startsWith(seriesPath) || !/\.pdf$/i.test(pathname)) {
        throw new Error("NovelNeko returned a PDF outside its light-novel series directory.");
      }
      const url = parsed.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const metadata = volumeMetadata(volumeContext(html, match.index, anchorPattern.lastIndex), match[0]);
      if (!metadata.accepted) continue;
      const title = stripHTML(match[2]) || decodeURIComponent(pathname.split("/").pop() || "Volume");
      const number = parseVolumeNumber(title, pathname);
      const containerStart = Math.max(0, match.index - 220);
      const container = html.slice(containerStart, Math.min(html.length, anchorPattern.lastIndex + 220));
      const releaseDate = stripHTML(container.match(/<span\b[^>]*>([^<]+)<\/span>/i)?.[1] || "");
      volumes.push({
        id: url,
        url,
        title,
        number,
        releaseDate: releaseDate || null,
        language: "fr",
        format: "pdf",
        sourceOrder: sourceOrder++,
      });
    }
    volumes.sort((left, right) => {
      const leftNumber = left.number == null ? Number.POSITIVE_INFINITY : left.number;
      const rightNumber = right.number == null ? Number.POSITIVE_INFINITY : right.number;
      return leftNumber - rightNumber || left.sourceOrder - right.sourceOrder;
    });
    return volumes.map(({ sourceOrder, ...volume }) => volume);
  }

  function safetyCheck({ title, genres, synopsis, type, status }) {
    if (!Array.isArray(genres) || genres.length === 0) {
      throw new Error("NovelNeko safety filter rejected the title: safety metadata is missing.");
    }
    if (hasUnsafeMarker([title, ...genres, synopsis, type, status])) {
      throw new Error("NovelNeko safety filter rejected the title: adult or unsafe metadata marker.");
    }
  }

  function catalogEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const title = String(entry.title || "").trim();
    if (!title || !entry.link) return null;
    let url;
    try {
      url = seriesURL(new URL(String(entry.link), LIGHTNOVEL_ROOT).toString());
    } catch (_) {
      return null;
    }
    let image = "";
    if (entry.image) {
      try {
        image = safeURL(new URL(String(entry.image), LIGHTNOVEL_ROOT).toString(), "catalog image URL").toString();
      } catch (_) {
        image = "";
      }
    }
    return { title, url, image, subtitle: String(entry.subtitle || "").trim() };
  }

  async function catalog() {
    if (catalogCache.has(CATALOG_URL)) return catalogCache.get(CATALOG_URL);
    const payload = await fetchJSON(CATALOG_URL, "catalog", MAX_CATALOG_BYTES);
    if (!Array.isArray(payload)) throw new Error("NovelNeko light-novel catalog is not an array.");
    const entries = payload.map(catalogEntry).filter(Boolean);
    if (!entries.length) throw new Error("NovelNeko light-novel catalog contained no valid titles.");
    catalogCache.set(CATALOG_URL, entries);
    return entries;
  }

  async function extractDetails(value) {
    const url = seriesURL(value);
    if (detailCache.has(url)) return detailCache.get(url);
    const entries = await catalog();
    const entry = entries.find((candidate) => candidate.url === url) || null;
    const html = await fetchHTML(url);
    const title = titleFromHTML(html, entry?.title || url.split("/").filter(Boolean).pop());
    const genresBlock = classBlock(html, "genres");
    const genres = [...genresBlock.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((match) => stripHTML(match[1]))
      .filter(Boolean);
    const synopsis = stripHTML(classBlock(html, "synopsis-box")).replace(/^Synopsis\s*:\s*/i, "").trim();
    const details = {
      id: url,
      href: url,
      url,
      title,
      image: detailCover(html, url) || entry?.image || "",
      description: synopsis,
      synopsis,
      author: strongField(html, "Auteur"),
      authors: strongField(html, "Auteur") ? [strongField(html, "Auteur")] : [],
      status: strongField(html, "Status"),
      type: strongField(html, "Type"),
      genres,
      volumes: parseVolumes(html, url),
    };
    safetyCheck(details);
    if (!details.volumes.length) throw new Error("NovelNeko light-novel title has no public PDF volumes.");
    detailCache.set(url, details);
    return details;
  }

  function itemFromDetails(details) {
    return {
      id: details.id,
      href: details.href,
      url: details.url,
      title: details.title,
      image: details.image,
      description: details.description,
      author: details.author,
      genres: details.genres,
      status: details.status,
      volumeCount: details.volumes.length,
    };
  }

  async function mapLimited(items, concurrency, mapper) {
    const output = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return output;
  }

  async function searchResults(query, page = 1) {
    const entries = await catalog();
    const text = typeof query === "object" && query !== null
      ? (query.text ?? query.query ?? "")
      : query;
    const normalizedQuery = /^\s*__feed:/i.test(String(text ?? "")) ? "" : normalizeForSearch(text);
    const matched = normalizedQuery
      ? entries.filter((entry) => normalizeForSearch(entry.title).includes(normalizedQuery))
      : entries;
    const currentPage = Math.max(1, Number(page) || 1);
    const start = (currentPage - 1) * PAGE_SIZE;
    const candidates = matched.slice(start, start + PAGE_SIZE);
    const checked = await mapLimited(candidates, 3, async (entry) => {
      try {
        return itemFromDetails(await extractDetails(entry.url));
      } catch (_) {
        return null;
      }
    });
    return { items: checked.filter(Boolean), hasMore: start + candidates.length < matched.length };
  }

  async function extractChapters(value) {
    return (await extractDetails(value)).volumes;
  }

  async function extractResources(value) {
    const details = await extractDetails(value);
    return details.volumes.map((volume) => ({
      format: "pdf",
      url: volume.url,
      fileName: decodeURIComponent(new URL(volume.url).pathname.split("/").pop() || "volume.pdf"),
      size: null,
      headers: { Referer: details.url },
      title: volume.title,
      number: volume.number,
      releaseDate: volume.releaseDate,
    }));
  }

  async function discoveryHome() {
    const result = await searchResults("__feed:lightnovels", 1);
    return { sections: [{ id: "lightnovels", title: "Light-Novels", items: result.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase();
    if (feed !== "lightnovels" && feed !== "popular" && feed !== "latest") return { items: [], hasMore: false };
    return searchResults(`__feed:${feed}`, page);
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractResources, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
