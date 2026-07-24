"use strict";

(() => {
  const BASE_URL = "https://weebcentral.com";
  const SEARCH_LIMIT = 32;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const searchMetadata = new Map();

  // Known WeebCentral filter tags used when the search page cannot be parsed.
  // Values must match the site's included_tag query parameter names.
  const FALLBACK_TAGS = [
    "Action",
    "Adventure",
    "Comedy",
    "Drama",
    "Ecchi",
    "Fantasy",
    "Gender Bender",
    "Harem",
    "Historical",
    "Horror",
    "Isekai",
    "Josei",
    "Martial Arts",
    "Mature",
    "Mecha",
    "Mystery",
    "Psychological",
    "Romance",
    "School Life",
    "Sci-Fi",
    "Seinen",
    "Shoujo",
    "Shounen",
    "Slice of Life",
    "Sports",
    "Supernatural",
    "Tragedy",
    "Wuxia",
    "Yuri",
  ];

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
      throw new Error("WeebCentral requires the fetchv2 bridge.");
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
        lastError = new Error(`WeebCentral request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("WeebCentral returned an empty response.");
    }
    throw lastError || new Error("WeebCentral request failed.");
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/weebcentral\.com)?\/?series\/([a-z0-9]+)(?:\/([^?#]+))?/i);
    if (match) {
      return `${BASE_URL}/series/${match[1]}${match[2] ? `/${match[2].replace(/^\/+|\/+$/g, "")}` : ""}`;
    }
    if (/^[a-z0-9]+(?:\/[a-z0-9-]+)?$/i.test(input)) {
      return `${BASE_URL}/series/${input}`;
    }
    throw new Error("Invalid WeebCentral series identifier.");
  }

  function normalizedChapterID(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/weebcentral\.com)?\/?chapters\/([a-z0-9]+)/i);
    if (match) return match[1];
    if (/^[a-z0-9]+$/i.test(input)) return input;
    throw new Error("Invalid WeebCentral chapter identifier.");
  }

  const BLOCKED_TAGS = new Set([
    "adult", "hentai", "lolicon", "shotacon", "smut", "explicit",
  ]);

  function mapStatusFilter(status) {
    const raw = String(status || "").trim().toLowerCase();
    if (!raw || raw === "any") return null;
    // Site form uses included_status with these exact values.
    if (raw === "ongoing" || raw === "publishing") return "Ongoing";
    if (raw === "completed" || raw === "complete" || raw === "finished") return "Complete";
    if (raw === "hiatus") return "Hiatus";
    if (raw === "canceled" || raw === "cancelled" || raw === "dropped") return "Canceled";
    return String(status).trim();
  }

  function tagList(value) {
    if (!Array.isArray(value)) return [];
    return uniqueStrings(value.map((tag) => {
      if (tag && typeof tag === "object") {
        return tag.name || tag.label || tag.id || tag.value || "";
      }
      return tag;
    })).filter((tag) => !BLOCKED_TAGS.has(tag.toLowerCase()));
  }

  function normalizeSearchQuery(query) {
    // App may pass a JSON envelope so WebKit always delivers a plain string.
    if (typeof query === "string" && query.startsWith("__niche__:")) {
      try {
        return normalizeSearchQuery(JSON.parse(query.slice("__niche__:".length)));
      } catch {
        // fall through
      }
    }
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const text = String(query.text || query.query || query.q || "").trim();
      return {
        feed: null,
        text,
        tags: tagList(query.tags || query.includeTags || query.includedTags),
        excludeTags: tagList(query.excludeTags || query.excludedTags),
        status: mapStatusFilter(query.status),
      };
    }

    const raw = String(query || "");
    if (raw === "__feed:popular") {
      return { feed: "popular", text: "", tags: [], excludeTags: [], status: null };
    }
    if (raw === "__feed:latest") {
      return { feed: "latest", text: "", tags: [], excludeTags: [], status: null };
    }
    if (raw === "__feed:niche") {
      return { feed: "niche", text: "", tags: [], excludeTags: [], status: null };
    }
    return {
      feed: "search",
      text: raw.replace(/[!#:(),-]+/g, " ").trim().slice(0, 200),
      tags: [],
      excludeTags: [],
      status: null,
    };
  }

  function parseSearchHTML(html) {
    const source = String(html || "");
    // WeebCentral renders branded 400/challenge pages with HTTP 200 and a
    // `/series/random` link. Never let that navigation card masquerade as a
    // title in discovery or search results.
    if (/<title\b[^>]*>\s*400\s*\|\s*Weeb Central\s*<\/title>/i.test(source)
      || /<link\b[^>]*rel=["']canonical["'][^>]*href=["']https:\/\/weebcentral\.com\/400["']/i.test(source)) {
      return { items: [], hasMore: false };
    }
    // Prefer article cards; fall back to any series-link blocks if the class changes.
    let chunks = source.split(
      /<article\b[^>]*class=["'][^"']*\bbg-base-300\b[^"']*["'][^>]*>/i,
    ).slice(1);
    if (!chunks.length) {
      chunks = source.split(/(?=<a\b[^>]*href=(["'])[^"']*\/series\/[^"']+\1)/i).slice(1);
    }

    const seen = new Set();
    const items = [];

    for (const chunk of chunks) {
      const hrefMatch = chunk.match(/<a\b[^>]*href=(["'])([^"']*\/series\/[^"']+)\1/i);
      if (!hrefMatch) continue;
      const href = decodeEntities(hrefMatch[2]);
      const absoluteHref = href.startsWith("https://")
        ? href
        : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      if (/\/series\/random(?:[/?#]|$)/i.test(absoluteHref)) continue;
      if (seen.has(absoluteHref)) continue;

      const linkedTitle = chunk.match(/<a\b[^>]*class=["'][^"']*line-clamp[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      const compactTitle = chunk.match(/<div\b[^>]*class=["'][^"']*text-ellipsis[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const headingTitle = chunk.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
      const altTitle = chunk.match(/<img\b[^>]*alt=(["'])(.*?)\s+cover\1/i)
        || chunk.match(/<img\b[^>]*alt=(["'])([^"']+)\1/i);
      const title = stripHTML(
        linkedTitle?.[1] || compactTitle?.[1] || headingTitle?.[1] || altTitle?.[2] || "",
      );
      if (!title || /^cover$/i.test(title)) continue;

      const normalCover = chunk.match(/https:\/\/[^"'\s]+\/cover\/normal\/[^"'\s]+/i);
      const imageTag = chunk.match(/<(?:source|img)\b[^>]*(?:srcset|src)=(["'])(https:\/\/[^"']+)\1/i);
      const image = decodeEntities(normalCover?.[0] || imageTag?.[2] || "");
      seen.add(absoluteHref);
      items.push({ id: absoluteHref, href: absoluteHref, title, image });
    }

    return {
      items,
      hasMore: items.length >= SEARCH_LIMIT
        || /<button\b[^>]*>[\s\S]*?(?:next|load more|show more)/i.test(source)
        || /data-offset=["']\d+["']/i.test(source),
    };
  }

  function labeledSegment(html, labelPattern) {
    const expression = new RegExp(`<strong\\b[^>]*>\\s*${labelPattern}\\s*:?\\s*<\\/strong>`, "i");
    const match = expression.exec(html);
    if (!match) return "";
    const end = html.indexOf("</li>", match.index);
    return html.slice(match.index, end === -1 ? match.index + 2000 : end + 5);
  }

  function parseDetailsHTML(html, href) {
    const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const title = stripHTML(titleMatch?.[1] || "");
    if (!title) throw new Error("WeebCentral details did not contain a title.");

    const cover = html.match(/https:\/\/[^"'\s]+\/cover\/normal\/[^"'\s]+/i)?.[0]
      || attribute(html.match(/<img\b[^>]*>/i)?.[0], "src");
    const authorBlock = labeledSegment(html, "Author(?:\\(s\\))?");
    const statusBlock = labeledSegment(html, "Status");
    const descriptionBlock = labeledSegment(html, "Description");
    const tagBlock = labeledSegment(html, "(?:Tag|Type)(?:\\(s\\))?");
    const authors = Array.from(authorBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi))
      .map((match) => stripHTML(match[1]))
      .filter(Boolean);
    const genres = Array.from(tagBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi))
      .map((match) => stripHTML(match[1]))
      .filter(Boolean);
    let status = stripHTML(statusBlock).replace(/^Status\s*:?\s*/i, "");
    if (/^complete$/i.test(status)) status = "Completed";
    if (/^canceled$/i.test(status)) status = "Cancelled";

    return {
      id: href,
      href,
      url: href,
      title,
      description: stripHTML(descriptionBlock).replace(/^Description\s*:?\s*/i, ""),
      image: cover,
      authors,
      author: authors.join(", "),
      genres,
      status: status || "Unknown",
    };
  }

  function chapterNumber(title) {
    const match = String(title || "").match(/(?:chapter|ch\.?)[\s#:-]*([0-9]+(?:\.[0-9]+)?)/i);
    return match ? Number(match[1]) : null;
  }

  function parseChaptersHTML(html) {
    const chapters = [];
    const seen = new Set();
    const anchorPattern = /<a\b([^>]*href=(["'])([^"']*\/chapters\/[^"']+)\2[^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(html)) !== null) {
      const rawHref = decodeEntities(match[3]);
      const href = rawHref.startsWith("https://")
        ? rawHref
        : `${BASE_URL}${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;
      if (seen.has(href)) continue;
      const body = match[4];
      const nestedTitle = body.match(/<span\b[^>]*class=["'][^"']*\bflex\b[^"']*["'][^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i)
        || body.match(/<span\b[^>]*class=["'][^"']*\bgrow\b[^"']*["'][^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i);
      const title = stripHTML(nestedTitle?.[1] || body).split("\n")[0].trim();
      if (!title) continue;
      const timeTag = body.match(/<time\b[^>]*>/i)?.[0] || "";
      const releaseDate = attribute(timeTag, "datetime");
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number: chapterNumber(title),
        releaseDate: releaseDate || null,
        language: "en",
      });
      seen.add(href);
    }
    return chapters;
  }

  function imageURLFromTag(tag) {
    const candidates = [
      attribute(tag, "src"),
      attribute(tag, "data-src"),
      attribute(tag, "data-lazy-src"),
    ];
    for (const value of candidates) {
      if (value.startsWith("https://")) return value;
    }
    const srcset = attribute(tag, "srcset");
    if (srcset) {
      const first = srcset.split(",")[0].trim().split(/\s+/)[0];
      if (first.startsWith("https://")) return first;
    }
    return "";
  }

  function isReaderPageURL(url) {
    return url.startsWith("https://")
      && !/\/static\/images\/broken_image/i.test(url)
      && !/\/cover\/normal\//i.test(url);
  }

  function collectImagesFromHTML(html) {
    const pages = [];
    const seen = new Set();
    const pattern = /<img\b[^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = imageURLFromTag(match[0]);
      if (!isReaderPageURL(url) || seen.has(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,*/*",
          Referer: `${BASE_URL}/`,
        },
      });
      seen.add(url);
    }
    return pages;
  }

  function parseImagesHTML(html) {
    const reader = String(html).match(
      /<section\b[^>]*x-data=(["'])[^"']*scroll[^"']*\1[^>]*>([\s\S]*?)<\/section>/i,
    );
    if (reader) {
      const sectionPages = collectImagesFromHTML(reader[2]);
      if (sectionPages.length) return sectionPages;
    }
    return collectImagesFromHTML(String(html));
  }

  function parseTagsFromSearchPage(html) {
    const source = String(html || "");
    const found = [];

    // id="tag-Action-value" style controls
    for (const match of source.matchAll(/id=["']tag-([^"']+)-value["']/gi)) {
      found.push(decodeEntities(match[1].replace(/_/g, " ")));
    }

    // checkboxes / inputs for included_tag
    for (const match of source.matchAll(
      /<(?:input|option)\b[^>]*(?:name|data-name)=["']included_tag["'][^>]*>/gi,
    )) {
      const value = attribute(match[0], "value") || attribute(match[0], "data-value");
      if (value) found.push(value);
    }

    // label text next to tag inputs
    for (const match of source.matchAll(
      /<label\b[^>]*(?:for=["']tag-[^"']+["']|class=["'][^"']*tag[^"']*["'])[^>]*>([\s\S]*?)<\/label>/gi,
    )) {
      const text = stripHTML(match[1]);
      if (text && text.length < 40) found.push(text);
    }

    // Alpine / data attributes
    for (const match of source.matchAll(/data-tag=(["'])([^"']+)\1/gi)) {
      found.push(decodeEntities(match[2]));
    }

    return uniqueStrings(found)
      .filter((tag) => !BLOCKED_TAGS.has(tag.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  }

  function searchURL(normalized, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const feed = normalized.feed;
    const hasFilters = Boolean(
      (normalized.tags && normalized.tags.length)
      || (normalized.excludeTags && normalized.excludeTags.length)
      || normalized.status,
    );
    // Tag/status-only Surprise Me searches rank better with Popularity than empty Best Match.
    const sort = feed === "popular"
      ? "Popularity"
      : feed === "latest"
        ? "Latest Updates"
        : feed === "niche"
          ? "Subscribers"
          : hasFilters
            ? "Popularity"
            : "Best Match";
    const order = feed === "niche" ? "Ascending" : "Descending";
    const text = feed === "search" || !feed ? normalized.text : "";
    const params = [
      ["text", text],
      ["sort", sort],
      ["order", order],
      ["official", "Any"],
      ["anime", "Any"],
      ["adult", "False"],
      ["limit", String(SEARCH_LIMIT)],
      ["offset", String((currentPage - 1) * SEARCH_LIMIT)],
      ["display_mode", "Full Display"],
    ];

    // Critical: WeebCentral's form field is `included_status`, not `status`.
    if (normalized.status) {
      params.push(["included_status", normalized.status]);
    }

    for (const tag of normalized.tags || []) {
      params.push(["included_tag", tag]);
    }
    for (const tag of normalized.excludeTags || []) {
      params.push(["excluded_tag", tag]);
    }

    return `${BASE_URL}/search/data?${params
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&")}`;
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    if (!normalized.feed) normalized.feed = "search";
    const result = parseSearchHTML(
      await fetchDirect(searchURL(normalized, page), { maxBytesHint: 2 * 1024 * 1024 }),
    );
    for (const item of result.items) {
      const genres = uniqueStrings(normalized.tags || []);
      if (genres.length) {
        searchMetadata.set(item.id, { genres });
      }
    }
    return result;
  }

  async function extractTags() {
    try {
      const html = await fetchDirect(`${BASE_URL}/search`, { maxBytesHint: 2 * 1024 * 1024 });
      const parsed = parseTagsFromSearchPage(html);
      if (parsed.length >= 8) return parsed;
    } catch {
      // Fall through to curated tags so Surprise Me still works offline-ish.
    }
    return FALLBACK_TAGS.slice();
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    const details = parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 2 * 1024 * 1024 }), href);
    for (const genre of searchMetadata.get(href)?.genres || []) {
      if (!details.genres.some((value) => value.toLowerCase() === genre.toLowerCase())) {
        details.genres.push(genre);
      }
    }
    return details;
  }

  async function extractChapters(id) {
    const seriesURL = normalizedSeriesURL(id);
    const parts = seriesURL.replace(`${BASE_URL}/series/`, "").split("/");
    const endpoint = `${BASE_URL}/series/${parts[0]}/full-chapter-list`;
    return parseChaptersHTML(await fetchDirect(endpoint, { maxBytesHint: 12 * 1024 * 1024 }));
  }

  async function extractImages(id) {
    const chapterID = normalizedChapterID(id);
    const endpoint = `${BASE_URL}/chapters/${chapterID}/images?is_prev=False&reading_style=long_strip`;
    const pages = parseImagesHTML(await fetchDirect(endpoint, { maxBytesHint: 4 * 1024 * 1024 }));
    if (!pages.length) {
      throw new Error("WeebCentral returned no readable pages for this chapter.");
    }
    return pages;
  }

  async function discoveryHome() {
    const [popular, latest, niche] = await Promise.all([
      searchResults("__feed:popular", 1),
      searchResults("__feed:latest", 1),
      searchResults("__feed:niche", 1),
    ]);
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
