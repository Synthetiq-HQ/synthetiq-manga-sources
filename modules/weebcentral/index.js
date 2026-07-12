"use strict";

(() => {
  const BASE_URL = "https://weebcentral.com";
  const SEARCH_LIMIT = 32;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
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
    const response = await globalThis.fetchv2(
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

    const status = Number(response.status || 0);
    if (response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`WeebCentral request failed with HTTP ${status || "error"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error("WeebCentral returned an empty response.");
    return body;
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

  function parseSearchHTML(html) {
    const chunks = String(html).split(
      /<article\b[^>]*class=["'][^"']*\bbg-base-300\b[^"']*["'][^>]*>/i,
    ).slice(1);
    const seen = new Set();
    const items = [];

    for (const chunk of chunks) {
      const hrefMatch = chunk.match(/<a\b[^>]*href=(["'])([^"']*\/series\/[^"']+)\1/i);
      if (!hrefMatch) continue;
      const href = decodeEntities(hrefMatch[2]);
      const absoluteHref = href.startsWith("https://") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      if (seen.has(absoluteHref)) continue;

      const linkedTitle = chunk.match(/<a\b[^>]*class=["'][^"']*line-clamp[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      const compactTitle = chunk.match(/<div\b[^>]*class=["'][^"']*text-ellipsis[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      const altTitle = chunk.match(/<img\b[^>]*alt=(["'])(.*?)\s+cover\1/i);
      const title = stripHTML(linkedTitle?.[1] || compactTitle?.[1] || altTitle?.[2] || "");
      if (!title) continue;

      const normalCover = chunk.match(/https:\/\/[^"'\s]+\/cover\/normal\/[^"'\s]+/i);
      const imageTag = chunk.match(/<(?:source|img)\b[^>]*(?:srcset|src)=(["'])(https:\/\/[^"']+)\1/i);
      const image = decodeEntities(normalCover?.[0] || imageTag?.[2] || "");
      seen.add(absoluteHref);
      items.push({ id: absoluteHref, href: absoluteHref, title, image });
    }

    return {
      items,
      hasMore: /<button\b/i.test(html),
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
      const href = rawHref.startsWith("https://") ? rawHref : `${BASE_URL}${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;
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

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const feed = query === "__feed:popular" ? "popular" : query === "__feed:latest" ? "latest" : "search";
    const text = feed === "search" ? String(query || "").replace(/[!#:(),-]+/g, " ").trim().slice(0, 200) : "";
    const sort = feed === "popular" ? "Popularity" : feed === "latest" ? "Latest Updates" : "Best Match";
    const params = [
      ["text", text],
      ["sort", sort],
      ["order", "Descending"],
      ["official", "Any"],
      ["anime", "Any"],
      ["adult", "False"],
      ["limit", String(SEARCH_LIMIT)],
      ["offset", String((currentPage - 1) * SEARCH_LIMIT)],
      ["display_mode", "Full Display"],
    ];
    return `${BASE_URL}/search/data?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
  }

  async function searchResults(query, page = 1) {
    return parseSearchHTML(await fetchDirect(searchURL(query, page), { maxBytesHint: 2 * 1024 * 1024 }));
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 2 * 1024 * 1024 }), href);
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
