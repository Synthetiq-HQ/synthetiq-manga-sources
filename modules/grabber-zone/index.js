"use strict";

(() => {
  const BASE_URL = "https://grabber.zone";
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
    const match = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(?:(["'])(.*?)\\1|([^"'\\s>]+))`, "i"),
    );
    return match ? decodeEntities((match[2] !== undefined ? match[2] : match[3]).trim()) : "";
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
      throw new Error("Grabber Zone requires the fetchv2 bridge.");
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
        lastError = new Error(`Grabber Zone request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("Grabber Zone returned an empty response.");
    }
    throw lastError || new Error("Grabber Zone request failed.");
  }

  async function fetchList(url, maxBytesHint) {
    if (listCache.key === url && listCache.value && Date.now() - listCache.at < LIST_CACHE_TTL) {
      return listCache.value;
    }
    const body = await fetchDirect(url, { maxBytesHint });
    listCache = { key: url, at: Date.now(), value: body };
    return body;
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/grabber\.zone)?\/?comics\/([a-z0-9-]+)\/?/i);
    if (!match) throw new Error("Invalid Grabber Zone series identifier.");
    return `${BASE_URL}/comics/${match[1]}/`;
  }

  function normalizedChapterURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/grabber\.zone)?\/?comics\/([a-z0-9-]+)\/([a-z0-9-]+)\/?/i);
    if (!match) throw new Error("Invalid Grabber Zone chapter identifier.");
    return `${BASE_URL}/comics/${match[1]}/${match[2]}/`;
  }

  function isSeriesURL(url) {
    return /\/comics\/[a-z0-9-]+\/$/i.test(url)
      && !/\/comics\/(?:feed|page)\//i.test(url);
  }

  function imageURLFromTag(tag) {
    const candidates = [
      attribute(tag, "data-src"),
      attribute(tag, "data-lazy-src"),
      attribute(tag, "src"),
    ];
    for (const raw of candidates) {
      const value = String(raw || "").trim();
      if (value.startsWith("https://")) return value;
    }
    const srcset = attribute(tag, "srcset");
    if (srcset) {
      const first = srcset.split(",")[0].trim().split(/\s+/)[0];
      if (first.startsWith("https://")) return first;
    }
    return "";
  }

  function parseSeriesCards(html) {
    const source = String(html || "");
    // Series cards and plain series links both name the canonical /comics/<slug>/ URL.
    const chunks = source.split(/(?=<a\b[^>]*href=(["'])[^"']*\/comics\/[a-z0-9-]+\/\1)/i).slice(1);
    const seen = new Set();
    const items = [];
    for (const chunk of chunks) {
      const hrefMatch = chunk.match(/<a\b[^>]*href=(["'])([^"']*\/comics\/[a-z0-9-]+\/)\1/i);
      if (!hrefMatch) continue;
      const href = decodeEntities(hrefMatch[2]);
      if (!isSeriesURL(href) || seen.has(href)) continue;
      const window_ = chunk.slice(0, 3000);
      const titleAttr = hrefMatch[0].match(/title=(["'])([^"']+)\1/i);
      const imgAlt = window_.match(/<img\b[^>]*alt=(["'])([^"']+)\1/i);
      const heading = window_.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
      const linkText = window_.match(/^[^>]*>([\s\S]*?)<\/a>/i);
      const title = stripHTML(
        titleAttr?.[2] || imgAlt?.[2] || heading?.[1] || linkText?.[1] || "",
      );
      if (!title || /^read more$/i.test(title)) continue;
      const imageTag = window_.match(/<img\b[^>]*>/i);
      const image = imageTag ? imageURLFromTag(imageTag[0]) : "";
      seen.add(href);
      items.push({ id: href, href, title, image });
    }
    return items;
  }

  function parseDetailsHTML(html, href) {
    const source = String(html || "");
    const titleMatch = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const title = stripHTML(titleMatch?.[1] || "").replace(/^Read\s+/i, "").trim();
    if (!title) throw new Error("Grabber Zone details did not contain a title.");

    const coverTag = source.match(/<div\b[^>]*class=["'][^"']*summary_image[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*>/i)?.[0]
      || source.match(/<img\b[^>]*class=["'][^"']*wp-post-image[^"']*["'][^>]*>/i)?.[0]
      || source.match(/<img\b[^>]*>/i)?.[0];
    const cover = coverTag ? imageURLFromTag(coverTag) : "";

    const descriptionBlock = source.match(/<div\b[^>]*class=["'][^"']*summary__content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      || source.match(/<div\b[^>]*class=["'][^"']*description-summary[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const description = stripHTML(descriptionBlock?.[1] || "");

    const authorBlock = source.match(/<div\b[^>]*class=["'][^"']*author-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const authors = authorBlock
      ? uniqueStrings(Array.from(authorBlock[1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)).map((m) => stripHTML(m[1])))
      : [];

    const genreBlock = source.match(/<div\b[^>]*class=["'][^"']*genres-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const genres = genreBlock
      ? uniqueStrings(Array.from(genreBlock[1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)).map((m) => stripHTML(m[1])))
      : [];

    const statusBlock = source.match(/<div\b[^>]*class=["'][^"']*summary-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    let status = stripHTML(statusBlock?.[1] || "");
    if (/complete/i.test(status)) status = "Completed";
    else if (/ongoing|publishing|hiatus/i.test(status)) status = "Ongoing";
    else status = "Unknown";

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
      status,
    };
  }

  function chapterNumber(text, href) {
    const fromText = String(text || "").match(/(?:chapter|ch\.?|issue|#)[\s#:-]*([0-9]+(?:\.[0-9]+)?)/i);
    if (fromText) return Number(fromText[1]);
    const fromHref = String(href || "").match(/(?:chapter|issue)-([0-9]+(?:-[0-9]+)?)/i);
    if (fromHref) return Number(fromHref[1].replace("-", "."));
    return null;
  }

  function parseChaptersHTML(html, seriesURL) {
    const chapters = [];
    const seen = new Set();
    const seriesPrefix = normalizedSeriesURL(seriesURL);
    const rowPattern = /<li\b[^>]*class=["'][^"']*wp-manga-chapter[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    let row;
    while ((row = rowPattern.exec(html)) !== null) {
      const body = row[1];
      const anchor = body.match(/<a\b[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/i);
      if (!anchor) continue;
      const href = new URL(decodeEntities(anchor[2]), BASE_URL).toString();
      if (!href.startsWith(seriesPrefix) || !/\/comics\/[a-z0-9-]+\/[a-z0-9-]+\/$/i.test(href) || seen.has(href)) continue;
      const title = stripHTML(anchor[3]);
      if (!title) continue;
      const dateMatch = body.match(/<span\b[^>]*class=["'][^"']*chapter-release-date[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number: chapterNumber(title, href),
        releaseDate: null,
        releaseDateText: dateMatch ? stripHTML(dateMatch[1]) : null,
        language: "en",
      });
      seen.add(href);
    }
    return chapters;
  }

  function parseImagesHTML(html) {
    const source = String(html || "");
    const reader = source.match(/<div\b[^>]*class=["'][^"']*reading-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div\b[^>]*class=["'][^"']*(?:nav|manga-ad)[^"']*)/i);
    const scope = reader ? reader[1] : source;
    const pages = [];
    const seen = new Set();
    // WP-Manga chapter pages are marked with the wp-manga-chapter-img class and
    // lazy-load their real URL from data-src. Generic <img> matches can pick up
    // the site logo or loading spinner, so we restrict to chapter images only.
    const pattern = /<img\b[^>]*class=["'][^"']*wp-manga-chapter-img[^"']*["'][^>]*>/gi;
    let match;
    while ((match = pattern.exec(scope)) !== null) {
      const tag = match[0];
      const url = attribute(tag, "data-src") || attribute(tag, "src");
      if (!url || seen.has(url)) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      if (!/\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|#|$)/i.test(url)) continue;
      if (/loading\.gif|ajax-loader|logo/i.test(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: `${BASE_URL}/`,
        },
      });
      seen.add(url);
    }
    return pages;
  }

  function normalizeSearchQuery(query) {
    const raw = String(query || "");
    if (raw === "__feed:popular") return { feed: "popular", text: "" };
    if (raw === "__feed:latest") return { feed: "latest", text: "" };
    return { feed: "search", text: raw.replace(/[!#:(),-]+/g, " ").trim().slice(0, 200) };
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    const currentPage = Math.max(1, Number(page) || 1);
    let url;
    if (normalized.feed === "popular") {
      url = `${BASE_URL}/comics/?m_orderby=views${currentPage > 1 ? `&paged=${currentPage}` : ""}`;
    } else if (normalized.feed === "latest") {
      url = `${BASE_URL}/comics/?m_orderby=latest${currentPage > 1 ? `&paged=${currentPage}` : ""}`;
    } else {
      const text = encodeURIComponent(normalized.text);
      url = `${BASE_URL}/?s=${text}&post_type=wp-manga${currentPage > 1 ? `&paged=${currentPage}` : ""}`;
    }
    const items = parseSeriesCards(await fetchList(url, 2 * 1024 * 1024));
    return { items, hasMore: items.length >= SEARCH_LIMIT };
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 2 * 1024 * 1024 }), href);
  }

  async function extractChapters(id) {
    const href = normalizedSeriesURL(id);
    const chapters = parseChaptersHTML(await fetchDirect(href, { maxBytesHint: 8 * 1024 * 1024 }), href);
    if (!chapters.length) {
      throw new Error("Grabber Zone returned no chapters for this series.");
    }
    return chapters;
  }

  async function extractImages(id) {
    const href = normalizedChapterURL(id);
    const pages = parseImagesHTML(await fetchDirect(href, { maxBytesHint: 4 * 1024 * 1024 }));
    if (!pages.length) {
      throw new Error("Grabber Zone returned no readable pages for this chapter.");
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
