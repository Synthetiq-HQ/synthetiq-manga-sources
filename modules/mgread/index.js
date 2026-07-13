"use strict";

(() => {
  // likemanga.io permanently redirects here; modules pin the live origin.
  const BASE_URL = "https://mgread.io";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const MAX_CHAPTER_PAGES = 200;

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
      throw new Error("MGRead requires the fetchv2 bridge.");
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
      throw new Error(`MGRead request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) {
      throw new Error(`MGRead response was dropped: ${response.dropReason || "size policy"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error("MGRead returned an empty response.");
    return body;
  }

  function absoluteURL(value) {
    const input = String(value || "").trim().replace(/&amp;/g, "&");
    if (!input) return "";
    if (input.startsWith("https://")) return input.split("#")[0];
    if (input.startsWith("//")) return `https:${input}`.split("#")[0];
    if (input.startsWith("/")) return `${BASE_URL}${input}`.split("#")[0];
    return `${BASE_URL}/${input}`.split("#")[0];
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/(?:mgread\.io|likemanga\.io))?\/?manga\/([a-z0-9][a-z0-9-]*)\/?/i);
    if (match) return `${BASE_URL}/manga/${match[1]}/`;
    if (/^[a-z0-9][a-z0-9-]*$/i.test(input)) return `${BASE_URL}/manga/${input}/`;
    throw new Error("Invalid MGRead series identifier.");
  }

  function seriesSlug(value) {
    return normalizedSeriesURL(value).replace(`${BASE_URL}/manga/`, "").replace(/\/+$/, "");
  }

  function normalizedChapterURL(value) {
    const input = String(value || "").trim();
    const match = input.match(
      /(?:https:\/\/(?:mgread\.io|likemanga\.io))?\/?manga\/([a-z0-9][a-z0-9-]*)\/(chapter-[0-9]+(?:\.[0-9]+)?)\/?/i,
    );
    if (match) return `${BASE_URL}/manga/${match[1]}/${match[2].toLowerCase()}/`;
    throw new Error("Invalid MGRead chapter identifier.");
  }

  function chapterNumber(title, href) {
    const fromHref = String(href || "").match(/\/chapter-([0-9]+(?:\.[0-9]+)?)\/?$/i);
    if (fromHref) return Number(fromHref[1]);
    const fromTitle = String(title || "").match(/(?:chapter|ch\.?)[\s#:-]*([0-9]+(?:\.[0-9]+)?)/i);
    return fromTitle ? Number(fromTitle[1]) : null;
  }

  function parseSearchHTML(html) {
    const items = [];
    const seen = new Set();
    const pattern = /href=(https:\/\/mgread\.io\/manga\/[a-z0-9][a-z0-9-]*)\/?(?:>|\s)/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = `${match[1].replace(/\/+$/, "")}/`;
      if (seen.has(href) || /\/chapter-/i.test(href)) continue;
      // Prefer metadata that follows this specific result link.
      const window = html.slice(match.index, Math.min(html.length, match.index + 900));
      let title = stripHTML((window.match(/alt=["']([^"']+)["']/i) || [])[1] || "");
      if (!title) {
        title = stripHTML((window.match(/class=["']?[^"']*title[^"']*["']?[^>]*>([\s\S]*?)<\//i) || [])[1] || "");
      }
      if (!title) {
        const slug = href.replace(`${BASE_URL}/manga/`, "").replace(/\/+$/, "");
        title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }
      const image = decodeEntities(
        (window.match(/src=(https:\/\/mgread\.io\/wp-content\/uploads\/[^>\s"']+)/i) || [])[1]
        || (window.match(/src=["'](https:\/\/[^"']+)["']/i) || [])[1]
        || "",
      );
      seen.add(href);
      items.push({ id: href, href, title, image });
    }
    const hasMore = /page\/[0-9]+|rel=["']next["']/i.test(html);
    return { items, hasMore };
  }

  function parseDetailsHTML(html, href) {
    const title =
      stripHTML((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "")
      || stripHTML((html.match(/og:title" content="([^"]+)"/i) || [])[1] || "");
    if (!title) throw new Error("MGRead details did not contain a title.");

    const image =
      decodeEntities((html.match(/og:image" content="([^"]+)"/i) || [])[1] || "")
      || decodeEntities((html.match(/src=(https:\/\/mgread\.io\/wp-content\/uploads\/[^>\s"']+)/i) || [])[1] || "");

    let description = decodeEntities((html.match(/name="description" content="([^"]*)"/i) || [])[1] || "");
    if (!description) {
      description = stripHTML((html.match(/class=["']?summary[^"']*["']?[^>]*>([\s\S]*?)<\//i) || [])[1] || "");
    }

    const genres = Array.from(
      html.matchAll(/href=https:\/\/mgread\.io\/genre\/[^>\s]+[^>]*>([\s\S]*?)<\/a>/gi),
    )
      .map((entry) => stripHTML(entry[1]))
      .filter(Boolean);

    let status = "Unknown";
    const statusMatch = html.match(/"name"\s*:\s*"status"\s*,\s*"value"\s*:\s*"([^"]+)"/i)
      || html.match(/Status[\s\S]{0,80}?(Ongoing|Completed|Hiatus|Cancelled)/i);
    if (statusMatch) status = stripHTML(statusMatch[1]);
    status = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

    return {
      id: href,
      href,
      url: href,
      title,
      description,
      image,
      authors: [],
      author: "",
      genres,
      status,
    };
  }

  function parseChaptersHTML(html) {
    const chapters = [];
    const seen = new Set();
    const pattern = /href=(https:\/\/mgread\.io\/manga\/[a-z0-9-]+\/chapter-[0-9]+(?:\.[0-9]+)?\/?)/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = absoluteURL(match[1]);
      if (seen.has(href)) continue;
      const number = chapterNumber("", href);
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
    return chapters;
  }

  function chapterPageURLs(seriesURL) {
    const slug = seriesSlug(seriesURL);
    return {
      first: `${BASE_URL}/manga/${slug}/`,
      page: (page) => `${BASE_URL}/manga/${slug}/chapter/page/${page}/`,
    };
  }

  function maxChapterPage(html) {
    const pages = Array.from(
      String(html).matchAll(/\/chapter\/page\/([0-9]+)\/?#?chapter-list/gi),
    ).map((entry) => Number(entry[1]));
    return pages.length ? Math.max(...pages) : 1;
  }

  async function extractAllChapters(seriesURL) {
    const routes = chapterPageURLs(seriesURL);
    const firstHTML = await fetchDirect(routes.first, { maxBytesHint: 3 * 1024 * 1024 });
    const totalPages = Math.min(maxChapterPage(firstHTML), MAX_CHAPTER_PAGES);
    const merged = parseChaptersHTML(firstHTML);
    const seen = new Set(merged.map((entry) => entry.id));

    for (let page = 2; page <= totalPages; page += 1) {
      const html = await fetchDirect(routes.page(page), { maxBytesHint: 2 * 1024 * 1024 });
      const batch = parseChaptersHTML(html);
      for (const chapter of batch) {
        if (seen.has(chapter.id)) continue;
        merged.push(chapter);
        seen.add(chapter.id);
      }
      if (typeof globalThis.reportProgress === "function") {
        await globalThis.reportProgress({ stage: "chapters", completed: page, total: totalPages });
      }
      if (!batch.length) break;
    }

    // Prefer higher chapter numbers first (site default), then stable reverse-numeric sort.
    merged.sort((left, right) => {
      const a = left.number == null ? -1 : left.number;
      const b = right.number == null ? -1 : right.number;
      return b - a;
    });
    return merged;
  }

  function parseImagesHTML(html) {
    const pages = [];
    const seen = new Set();
    const pattern = /<img\b[^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const tag = match[0];
      const url = absoluteURL(attribute(tag, "data-src") || attribute(tag, "src"));
      if (!url.startsWith("https://") || seen.has(url)) continue;
      if (/wp-content\/uploads\/.*logo/i.test(url) || /custom-logo|site-logo/i.test(tag)) continue;
      if (/image-3-4|Cover image of/i.test(tag)) continue;
      // Prefer the dedicated image CDN used for chapter pages.
      const isChapterCDN = /https:\/\/mg\.mgread\.io\//i.test(url);
      const isUploadImage = /https:\/\/mgread\.io\/wp-content\/uploads\//i.test(url)
        && /\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|$)/i.test(url);
      if (!isChapterCDN && !isUploadImage) continue;
      if (!isChapterCDN && /-\d+x\d+\.(?:jpg|jpeg|png|webp|avif)$/i.test(url)) continue;
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: `${BASE_URL}/`,
        },
      });
      seen.add(url);
    }
    return pages.filter((page) => /https:\/\/mg\.mgread\.io\//i.test(page.url)).length
      ? pages.filter((page) => /https:\/\/mg\.mgread\.io\//i.test(page.url))
      : pages;
  }

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    if (query === "__feed:popular") {
      return currentPage <= 1
        ? `${BASE_URL}/manga-ranking/`
        : `${BASE_URL}/manga-ranking/page/${currentPage}/`;
    }
    if (query === "__feed:latest") {
      return currentPage <= 1
        ? `${BASE_URL}/recently-updated/`
        : `${BASE_URL}/recently-updated/page/${currentPage}/`;
    }
    const text = String(query || "").trim().slice(0, 200);
    if (currentPage <= 1) return `${BASE_URL}/?s=${encodeURIComponent(text)}`;
    return `${BASE_URL}/page/${currentPage}/?s=${encodeURIComponent(text)}`;
  }

  async function searchResults(query, page = 1) {
    return parseSearchHTML(await fetchDirect(searchURL(query, page), { maxBytesHint: 2 * 1024 * 1024 }));
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 3 * 1024 * 1024 }), href);
  }

  async function extractChapters(id) {
    const href = normalizedSeriesURL(id);
    const chapters = await extractAllChapters(href);
    if (!chapters.length) throw new Error("MGRead returned no chapters for this series.");
    return chapters;
  }

  async function extractImages(id) {
    const href = normalizedChapterURL(id);
    const pages = parseImagesHTML(await fetchDirect(href, { maxBytesHint: 4 * 1024 * 1024 }));
    if (!pages.length) {
      throw new Error("MGRead chapter returned no readable page images (video-only chapters are unsupported).");
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
        { id: "popular", title: "Manga Ranking", items: popular.items },
        { id: "latest", title: "Recently Updated", items: latest.items },
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
