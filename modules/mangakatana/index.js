"use strict";

(() => {
  const BASE_URL = "https://mangakatana.com";
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
    return "";
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("MangaKatana requires the fetchv2 bridge.");
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
      throw new Error(`MangaKatana request failed with HTTP ${status || "error"}.`);
    }
    if (response.bodyDropped) {
      throw new Error(`MangaKatana response was dropped: ${response.dropReason || "size policy"}.`);
    }
    const body = await responseText(response);
    if (!body) throw new Error("MangaKatana returned an empty response.");
    return body;
  }

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    if (input.startsWith("https://")) return input;
    if (input.startsWith("//")) return `https:${input}`;
    if (input.startsWith("/")) return `${BASE_URL}${input}`;
    return `${BASE_URL}/${input}`;
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/mangakatana\.com)?\/?manga\/([a-z0-9][a-z0-9.-]*)/i);
    if (match) return `${BASE_URL}/manga/${match[1]}`;
    if (/^[a-z0-9][a-z0-9.-]*$/i.test(input)) return `${BASE_URL}/manga/${input}`;
    throw new Error("Invalid MangaKatana series identifier.");
  }

  function normalizedChapterURL(value) {
    const input = String(value || "").trim();
    const match = input.match(
      /(?:https:\/\/mangakatana\.com)?\/?manga\/([a-z0-9][a-z0-9.-]*)\/(c[0-9]+(?:\.[0-9]+)?)/i,
    );
    if (match) return `${BASE_URL}/manga/${match[1]}/${match[2].toLowerCase()}`;
    throw new Error("Invalid MangaKatana chapter identifier.");
  }

  function chapterNumber(title, href) {
    const fromHref = String(href || "").match(/\/c([0-9]+(?:\.[0-9]+)?)$/i);
    if (fromHref) return Number(fromHref[1]);
    const fromTitle = String(title || "").match(/(?:chapter|ch\.?)[\s#:-]*([0-9]+(?:\.[0-9]+)?)/i);
    return fromTitle ? Number(fromTitle[1]) : null;
  }

  function parseSearchHTML(html) {
    const items = [];
    const seen = new Set();
    const pattern = /<h3 class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = absoluteURL(decodeEntities(match[1]));
      if (!/\/manga\//i.test(href) || seen.has(href)) continue;
      const title = stripHTML(match[2]);
      if (!title) continue;
      // Cover images sit before the title inside the same result card.
      const previousTitle = html.lastIndexOf('<h3 class="title">', match.index - 1);
      const start = previousTitle === -1 ? Math.max(0, match.index - 800) : previousTitle + 1;
      const window = html.slice(start, match.index);
      const imageCandidates = Array.from(
        window.matchAll(/<img\b[^>]*src=(["'])(https:\/\/[^"']+)\1/gi),
      );
      const image = imageCandidates.length
        ? decodeEntities(imageCandidates[imageCandidates.length - 1][2])
        : "";
      seen.add(href);
      items.push({ id: href, href, title, image });
    }
    const totalMatch = String(html).match(/Search results\s*\((\d+)\)/i);
    const total = totalMatch ? Number(totalMatch[1]) : items.length;
    const hasPageLink = /href=["'][^"']*page\/[0-9]+[^"']*search=/i.test(html)
      || /href=["'][^"']*search=[^"']*page=/i.test(html);
    return {
      items,
      hasMore: hasPageLink || (Number.isFinite(total) && items.length > 0 && items.length < total),
    };
  }

  function parseListHTML(html) {
    return parseSearchHTML(html);
  }

  function parseDetailsHTML(html, href) {
    const title =
      stripHTML((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "")
      || stripHTML((html.match(/og:title" content="([^"]+)"/i) || [])[1] || "");
    if (!title) throw new Error("MangaKatana details did not contain a title.");

    const image =
      decodeEntities((html.match(/og:image" content="([^"]+)"/i) || [])[1] || "")
      || decodeEntities((html.match(/<div class="cover[\s\S]*?<img\b[^>]*src=(["'])(https:\/\/[^"']+)\1/i) || [])[2] || "");

    const authors = Array.from(
      html.matchAll(/href="https:\/\/mangakatana\.com\/author\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
    )
      .map((entry) => stripHTML(entry[1]))
      .filter(Boolean);

    const genres = Array.from(
      html.matchAll(/href="https:\/\/mangakatana\.com\/genre\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
    )
      .map((entry) => stripHTML(entry[1]))
      .filter((value) => value && !/genres?/i.test(value));

    let status = "Unknown";
    const statusMatch = html.match(
      /Status:[\s\S]*?<div class="d-cell-small value status[^"]*">([\s\S]*?)<\/div>/i,
    );
    if (statusMatch) status = stripHTML(statusMatch[1]) || status;

    let description = "";
    const summaryMatch = html.match(/<div class="summary">([\s\S]*?)<\/div>/i)
      || html.match(/class="summary"[\s\S]*?<div class="text">([\s\S]*?)<\/div>/i);
    if (summaryMatch) {
      description = stripHTML(summaryMatch[1]).replace(/^Description\s*/i, "").trim();
    }

    return {
      id: href,
      href,
      url: href,
      title,
      description,
      image,
      authors,
      author: authors.join(", "),
      genres,
      status,
    };
  }

  function parseChaptersHTML(html) {
    const chapters = [];
    const seen = new Set();
    const pattern = /<div class="chapter">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = absoluteURL(decodeEntities(match[1]));
      if (!/\/manga\/[^/]+\/c[0-9]/i.test(href) || seen.has(href)) continue;
      const title = stripHTML(match[2]);
      if (!title) continue;
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number: chapterNumber(title, href),
        releaseDate: null,
        language: "en",
      });
      seen.add(href);
    }
    return chapters;
  }

  function parseImagesHTML(html) {
    const pages = [];
    const seen = new Set();
    const thzq = String(html).match(/var\s+thzq\s*=\s*(\[[\s\S]*?\]);/i);
    if (thzq) {
      let list = [];
      try {
        list = JSON.parse(thzq[1].replace(/'/g, '"'));
      } catch (_) {
        list = Array.from(thzq[1].matchAll(/'(https:\/\/[^']+)'/g)).map((entry) => entry[1]);
      }
      for (const url of list) {
        const absolute = absoluteURL(url);
        if (!absolute.startsWith("https://") || seen.has(absolute)) continue;
        if (!/\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|$)/i.test(absolute) && !/\/token\//i.test(absolute)) {
          continue;
        }
        pages.push({
          url: absolute,
          headers: {
            Accept: "image/avif,image/webp,image/*,*/*",
            Referer: `${BASE_URL}/`,
          },
        });
        seen.add(absolute);
      }
    }
    if (!pages.length) {
      const pattern = /<img\b[^>]*>/gi;
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const tag = match[0];
        const url = attribute(tag, "data-src") || attribute(tag, "src");
        if (!url.startsWith("https://") || seen.has(url)) continue;
        if (/\/static\/img\//i.test(url) || /\/imgs\/cover\//i.test(url)) continue;
        if (!/\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|$)/i.test(url) && !/\/token\//i.test(url)) continue;
        pages.push({
          url,
          headers: {
            Accept: "image/avif,image/webp,image/*,*/*",
            Referer: `${BASE_URL}/`,
          },
        });
        seen.add(url);
      }
    }
    return pages;
  }

  function searchURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    if (query === "__feed:popular" || query === "__feed:latest") {
      const path = query === "__feed:popular" ? "/new-manga" : "/latest";
      return currentPage <= 1 ? `${BASE_URL}${path}` : `${BASE_URL}${path}/page/${currentPage}`;
    }
    const text = String(query || "").trim().slice(0, 200);
    if (currentPage <= 1) {
      return `${BASE_URL}/?search=${encodeURIComponent(text)}`;
    }
    return `${BASE_URL}/page/${currentPage}?search=${encodeURIComponent(text)}`;
  }

  async function searchResults(query, page = 1) {
    const html = await fetchDirect(searchURL(query, page), { maxBytesHint: 2 * 1024 * 1024 });
    return query === "__feed:popular" || query === "__feed:latest"
      ? parseListHTML(html)
      : parseSearchHTML(html);
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 3 * 1024 * 1024 }), href);
  }

  async function extractChapters(id) {
    const href = normalizedSeriesURL(id);
    const chapters = parseChaptersHTML(await fetchDirect(href, { maxBytesHint: 8 * 1024 * 1024 }));
    if (!chapters.length) throw new Error("MangaKatana returned no chapters for this series.");
    return chapters;
  }

  async function extractImages(id) {
    const href = normalizedChapterURL(id);
    const pages = parseImagesHTML(await fetchDirect(href, { maxBytesHint: 4 * 1024 * 1024 }));
    if (!pages.length) throw new Error("MangaKatana chapter returned no readable pages.");
    return pages;
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      searchResults("__feed:popular", 1),
      searchResults("__feed:latest", 1),
    ]);
    return {
      sections: [
        { id: "popular", title: "New Manga", items: popular.items },
        { id: "latest", title: "Latest Updates", items: latest.items },
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
