"use strict";

(() => {
  const BASE_URL = "https://www.read-haikyuu.com";
  const SERIES_TITLE = "Haikyuu!!";
  const SERIES_SLUG = "haikyuu";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };

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
      new RegExp(`\\b${name}\\s*=\\s*(["']?)([^"'\\s>]+)\\1`, "i"),
    );
    return match ? decodeEntities(match[2].trim()) : "";
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.body === "string") return response.body;
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error(`${SERIES_TITLE} requires the fetchv2 bridge.`);
    }
    const response = await globalThis.fetchv2(
      url,
      { ...DEFAULT_HEADERS, ...(options.headers || {}) },
      options.method || "GET",
      options.body || null,
      {
        followRedirects: true,
        maxBytesHint: options.maxBytesHint || null,
        responseClass: options.responseClass || "html",
      },
    );
    const status = Number(response && response.status);
    if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`${SERIES_TITLE} request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) {
      throw new Error(`${SERIES_TITLE} response was dropped: ${response.dropReason || "size policy"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error(`${SERIES_TITLE} returned an empty response.`);
    return { body, finalUrl: response.finalUrl || url };
  }

  function absoluteURL(value, base = BASE_URL) {
    const input = String(value || "").trim().replace(/&amp;/g, "&");
    if (!input) return "";
    if (input.startsWith("https://")) return input.split("#")[0];
    if (input.startsWith("//")) return `https:${input}`.split("#")[0];
    if (input.startsWith("/")) return `${base.replace(/\/+$/, "")}${input}`.split("#")[0];
    return `${base.replace(/\/+$/, "")}/${input}`.split("#")[0];
  }

  function chapterNumber(href, title) {
    const fromHref = String(href || "").match(/chapter[- ]([0-9]+(?:\.[0-9]+)?)/i)
      || String(href || "").match(/ch[-_]?([0-9]+(?:\.[0-9]+)?)/i);
    if (fromHref) return Number(fromHref[1]);
    const fromTitle = String(title || "").match(/(?:chapter|ch\.?)[\s#:-]*([0-9]+(?:\.[0-9]+)?)/i);
    return fromTitle ? Number(fromTitle[1]) : null;
  }

  function isChapterURL(url) {
    const value = String(url || "").toLowerCase();
    if (!value.includes("/manga/")) return false;
    if (!/chapter|ch-\d|ch_\d|ch\d/i.test(value)) return false;
    if (value.includes("#") && value.indexOf("#") < value.length - 1 && !/chapter/i.test(value.split("#")[0])) return false;
    return true;
  }

  function parseChaptersHTML(html, base) {
    const chapters = [];
    const seen = new Set();
    const pattern = /href=(["']?)(https?:\/\/[^"'>\s]+|\/[^"'>\s]*)\1/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = absoluteURL(decodeEntities(match[2]), base);
      if (!isChapterURL(href) || seen.has(href)) continue;
      const number = chapterNumber(href, "");
      const title = number == null ? "Chapter" : `Chapter ${number}`;
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number,
        releaseDate: null,
        language: "en",
      });
      seen.add(href);
    }
    chapters.sort((left, right) => {
      const a = left.number == null ? -1 : left.number;
      const b = right.number == null ? -1 : right.number;
      return b - a;
    });
    return chapters;
  }

  function parseCover(html, base) {
    const og = decodeEntities((html.match(/og:image" content="([^"]+)"/i) || [])[1] || "");
    if (og.startsWith("https://")) return og;
    const candidates = Array.from(
      html.matchAll(/(?:data-src|src)=["']?(https?:\/\/[^"'\s>]+\.(?:jpg|jpeg|png|webp|avif))/gi),
    ).map((entry) => absoluteURL(entry[1], base));
    for (const url of candidates) {
      if (/logo|icon|emoji|avatar|sprite/i.test(url)) continue;
      return url;
    }
    return candidates[0] || "";
  }

  function parseDescription(html) {
    const meta = decodeEntities((html.match(/name=["']description["'] content=["']([^"']*)["']/i) || [])[1] || "");
    if (meta) return meta;
    const paragraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    return paragraph ? stripHTML(paragraph[1]).slice(0, 1200) : "";
  }

  function parseImagesHTML(html, pageURL) {
    const pages = [];
    const seen = new Set();
    const pattern = /<img\b[^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const tag = match[0];
      const url = absoluteURL(
        attribute(tag, "data-src")
          || attribute(tag, "data-lazy-src")
          || attribute(tag, "src"),
        pageURL,
      );
      if (!url.startsWith("https://") || seen.has(url)) continue;
      if (/logo|icon|emoji|avatar|sprite|gravatar|adservice|doubleclick/i.test(url)) continue;
      if (/data:image\//i.test(url)) continue;
      if (!/\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|$)/i.test(url) && !/\/uploads\//i.test(url)) continue;
      // Skip tiny WordPress thumbnails when a full-size sibling exists later.
      if (/-\d{2,4}x\d{2,4}\.(?:jpg|jpeg|png|webp|avif)$/i.test(url)) continue;
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

  function seriesIdentity(cover = "") {
    const href = `${BASE_URL.replace(/\/+$/, "")}/`;
    return {
      id: href,
      href,
      url: href,
      title: SERIES_TITLE,
      image: cover,
      description: "",
      authors: [],
      author: "",
      genres: [],
      status: "Unknown",
    };
  }

  async function loadHome() {
    const result = await fetchDirect(`${BASE_URL.replace(/\/+$/, "")}/`, { maxBytesHint: 4 * 1024 * 1024 });
    return result;
  }

  async function searchResults(query, page = 1) {
    if (Number(page) > 1) return { items: [], hasMore: false };
    const home = await loadHome();
    const cover = parseCover(home.body, home.finalUrl || BASE_URL);
    const identity = seriesIdentity(cover);
    const item = {
      id: identity.id,
      href: identity.href,
      title: identity.title,
      image: identity.image,
    };
    const q = String(query || "").trim().toLowerCase();
    if (q && q !== "__feed:popular" && q !== "__feed:latest") {
      const hay = `${SERIES_TITLE} ${SERIES_SLUG}`.toLowerCase();
      if (!q.split(/\s+/).every((token) => hay.includes(token) || token.length < 2)) {
        return { items: [], hasMore: false };
      }
    }
    return { items: [item], hasMore: false };
  }

  async function extractDetails(id) {
    const home = await loadHome();
    const base = home.finalUrl || BASE_URL;
    const cover = parseCover(home.body, base);
    const title =
      stripHTML((home.body.match(/og:title" content="([^"]+)"/i) || [])[1] || "")
      || stripHTML((home.body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "")
      || SERIES_TITLE;
    return {
      ...seriesIdentity(cover),
      id: `${BASE_URL.replace(/\/+$/, "")}/`,
      href: `${BASE_URL.replace(/\/+$/, "")}/`,
      url: `${BASE_URL.replace(/\/+$/, "")}/`,
      title: title.toLowerCase().includes(SERIES_TITLE.toLowerCase()) ? SERIES_TITLE : (title || SERIES_TITLE),
      description: parseDescription(home.body),
      status: /complete/i.test(home.body) ? "Completed" : "Ongoing",
    };
  }

  async function extractChapters(id) {
    const home = await loadHome();
    const chapters = parseChaptersHTML(home.body, home.finalUrl || BASE_URL);
    if (!chapters.length) {
      throw new Error(`${SERIES_TITLE} homepage returned no chapter links.`);
    }
    return chapters;
  }

  async function extractImages(id) {
    const input = String(id || "").trim();
    if (!isChapterURL(input) && !/https?:\/\//i.test(input)) {
      throw new Error(`Invalid ${SERIES_TITLE} chapter identifier.`);
    }
    const url = absoluteURL(input);
    const page = await fetchDirect(url, { maxBytesHint: 4 * 1024 * 1024 });
    const pages = parseImagesHTML(page.body, page.finalUrl || url);
    if (!pages.length) {
      throw new Error(`${SERIES_TITLE} chapter returned no readable page images.`);
    }
    return pages;
  }

  async function discoveryHome() {
    const search = await searchResults("__feed:popular", 1);
    return {
      sections: [
        { id: "popular", title: SERIES_TITLE, items: search.items },
        { id: "latest", title: "Latest", items: search.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    return searchResults(`__feed:${String(feedID || "popular").toLowerCase()}`, page);
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

