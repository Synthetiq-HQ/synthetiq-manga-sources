"use strict";

(() => {
  const BASE_URL = "https://www.mangaworld.mx";
  const CDN_BASE = "https://cdn.mangaworld.mx";
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/*,*/*",
    Referer: `${BASE_URL}/`,
  };
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;

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
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))`, "i"),
    );
    return match ? decodeEntities((match[1] ?? match[2] ?? match[3] ?? "").trim()) : "";
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
      throw new Error("MangaWorld requires the fetchv2 bridge.");
    }
    const method = options.method || "GET";
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1200 * (attempt - 1));
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          method,
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || null,
            responseClass: options.responseClass || "html",
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`MangaWorld request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("MangaWorld returned an empty response.");
    }
    throw lastError || new Error("MangaWorld request failed.");
  }

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    if (/^https?:\/\//i.test(input)) return input;
    if (input.startsWith("//")) return `https:${input}`;
    if (input.startsWith("/")) return `${BASE_URL}${input}`;
    return `${BASE_URL}/${input}`;
  }

  // Series pages live at /manga/<numeric-id>/<slug>; the numeric prefix is the
  // stable identifier used by search results and discovery rails alike.
  function parseSeriesID(value) {
    const match = String(value || "").match(/mangaworld\.mx\/manga\/(\d+)/i)
      || String(value || "").match(/^\/?manga\/(\d+)/i)
      || String(value || "").match(/^(\d+)$/);
    if (!match) throw new Error("Invalid MangaWorld series identifier.");
    return match[1];
  }

  function extractBlocks(html, className) {
    const blocks = [];
    const opening = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, "gi");
    let match;
    while ((match = opening.exec(html)) !== null) {
      const start = match.index + match[0].length;
      const tagRe = /<\/?div\b[^>]*>/gi;
      tagRe.lastIndex = start;
      let depth = 1;
      let next;
      while (depth > 0 && (next = tagRe.exec(html)) !== null) {
        if (next[0].startsWith("</")) depth -= 1;
        else depth += 1;
      }
      if (depth !== 0) continue;
      blocks.push({ tag: match[0], html: html.slice(start, tagRe.lastIndex - 6) });
    }
    return blocks;
  }

  function parseSearchResults(html) {
    const items = [];
    const seen = new Set();
    // Cards appear as <a ... href=/manga/<id>/<slug> ... class="thumb
    // position-relative" ... title="Name"> in either attribute order, with or
    // without quotes on the href.
    const pattern = /<a\b[^>]*>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const tag = match[0];
      if (!/class=["']?thumb position-relative["']?/i.test(tag)) continue;
      const hrefMatch = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!hrefMatch) continue;
      const href = decodeEntities(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim().replace(/\s+/g, "");
      if (!/mangaworld\.mx\/manga\/\d+/.test(href)) continue;
      const titleMatch = tag.match(/title\s*=\s*"([^"]*)"/i);
      const title = decodeEntities(titleMatch ? titleMatch[1] : "").trim();
      if (!title || seen.has(href)) continue;
      seen.add(href);
      const tail = html.slice(match.index + match[0].length, match.index + match[0].length + 300);
      const img = tail.match(/src=(https:\/\/cdn\.mangaworld\.mx\/mangas\/[^\s>]+)/i);
      items.push({ id: href, href, title, image: img ? img[1].split("?")[0] : "" });
    }
    return items;
  }

  function hasNextPage(html) {
    const pagination = /<ul\b[^>]*class=["'][^"']*\bpagination\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html);
    if (!pagination) return false;
    const active = /<li\b[^>]*class=["'][^"']*\bactive\b[^"']*["'][^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>\s*<\/li>/i.exec(pagination[1]);
    if (!active) return false;
    const rest = pagination[1].slice(active.index + active[0].length);
    const nextLi = /^\s*<li\b([^>]*)>/i.exec(rest);
    return Boolean(nextLi && !/\bdisabled\b/i.test(nextLi[1]));
  }

  // The details page embeds server state as many JSON literals; chapters live
  // inside per-volume objects ("chapters":[...]). Parse every chapter object
  // directly and de-duplicate by id.
  function extractChapterObjects(html) {
    const chapters = [];
    const seen = new Set();
    const pattern = /"chapters":\s*\[/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let index = match.index + match[0].length;
      // Each element starts with '{' — walk it as a balanced JSON object.
      while (html[index] !== "{" && index < html.length && html[index] !== "]") index += 1;
      while (html[index] === "{") {
        let depth = 0;
        let inString = false;
        let escaped = false;
        const start = index;
        for (let cursor = index; cursor < html.length; cursor += 1) {
          const char = html[cursor];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
          }
          if (char === '"') inString = true;
          else if (char === "{") depth += 1;
          else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                const chapter = JSON.parse(html.slice(start, cursor + 1));
                const id = chapter._id || chapter.id;
                if (id && !seen.has(id)) {
                  seen.add(id);
                  chapters.push(chapter);
                }
              } catch (_) {}
              index = cursor + 1;
              break;
            }
          } else if (depth > 0 && char === "[") {
            // skip nested arrays (pages) quickly
          }
        }
        while (html[index] !== "{" && index < html.length && html[index] !== "]") index += 1;
      }
    }
    return chapters;
  }

  function parseSeriesDetails(html, seriesURL) {
    const chapters = extractChapterObjects(html);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    let title = h1 ? stripHTML(h1[1]).trim() : "";
    // The reader/details <h1> may carry a suffix; fall back to og:title.
    if (!title) {
      const og = html.match(/property="?og:title"?\s+content=("|)?([^">]+)/i)
        || html.match(/<title>([^<]*)</i);
      title = og ? stripHTML(og[2] || og[1]) : "";
    }
    title = title.replace(/\s*Scan ITA.*$/i, "").replace(/\s*-\s*MangaWorld\s*$/i, "").trim();
    if (!title) throw new Error("MangaWorld details did not contain a title.");

    const coverMatch = html.match(/property="?og:image"?\s+content=("?)(https:[^\s">]+)\1/i)
      || html.match(/content="?(https:\/\/cdn\.mangaworld\.mx\/mangas\/[^"\s>]+)"/i);
    const image = coverMatch ? decodeEntities(coverMatch[2] || coverMatch[1]).split("?")[0] : "";

    // Meta rows: Autore / Artista / Stato rendered as sidebar links.
    const rowValues = (label) => {
      const pattern = new RegExp(`>${label}:\\s*</span>([\\s\\S]{0,400}?)</div>`, "i");
      const row = html.match(pattern);
      if (!row) return [];
      const values = [];
      const re = /<a[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(row[1])) !== null) {
        const value = stripHTML(m[1]).trim();
        if (value && !/^archive\?/.test(value)) values.push(value);
      }
      return values;
    };
    let authors = rowValues("Autore");
    if (!authors.length) authors = rowValues("Author");
    let artists = rowValues("Artista");
    if (!artists.length) artists = rowValues("Artist");

    const genreBlock = html.match(/"genres":\[(\{"_id":[\s\S]{0,1200}?)\]/);
    const genres = [];
    if (genreBlock) {
      const re = /"name":"([^"]+)"/g;
      let gm;
      while ((gm = re.exec(genreBlock[1])) !== null) {
        if (!genres.includes(gm[1])) genres.push(gm[1]);
      }
    }

    const statusRow = html.match(/Stato:\s*<\/span><a[^>]*>([^<]{2,20})</i)
      || html.match(/Status:\s*<\/span><a[^>]*>([^<]{2,20})</i);
    const statusMap = { finito: "Completed", "in corso": "Ongoing", ongoing: "Ongoing", dropped: "Dropped", "in pausa": "Paused", upcoming: "Upcoming", completo: "Completed" };
    const rawStatus = statusRow ? stripHTML(statusRow[1]).toLowerCase() : "";
    const status = statusMap[rawStatus] || (rawStatus ? rawStatus.replace(/^\w/, (c) => c.toUpperCase()) : "Ongoing");

    const trama = html.match(/Trama:\s*<\/span>\s*([\s\S]{10,2000}?)<\/div>/i);
    const parts = [];
    if (artists.length && artists.join(", ") !== authors.join(", ")) parts.push(`Artists: ${artists.join(", ")}`);
    if (genres.length) parts.push(`Genres: ${genres.join(", ")}`);
    if (trama) parts.push(stripHTML(trama[1]).replace(/\s+/g, " ").trim());

    return {
      id: seriesURL,
      href: seriesURL,
      url: seriesURL,
      title,
      description: parts.join("\n\n"),
      image,
      authors,
      author: authors.join(", "),
      genres,
      status,
    };
  }

  // Chapters come from the same embedded JSON. Reader URLs need the canonical
  // path /manga/<id>/<series-slug>/read/<chapter-hash>; both segments are in
  // the page URL itself, so rebuild from the series URL we were given.
  function buildReaderURL(seriesURL, chapterHash) {
    const base = seriesURL.replace(/\/$/, "");
    return `${base}/read/${chapterHash}`;
  }

  function chapterNumber(name) {
    const match = String(name || "").match(/(\d+(?:[.,]\d+)?)/);
    return match ? Number(match[1].replace(",", ".")) : undefined;
  }

  function parseChapters(chapterObjects, seriesURL) {
    const chapters = (chapterObjects || []).map((chapter) => {
      const number = chapterNumber(chapter.name) ?? chapterNumber(chapter.title);
      const readerURL = buildReaderURL(seriesURL, chapter._id || chapter.id);
      return {
        id: readerURL,
        href: readerURL,
        url: readerURL,
        title: [chapter.name, chapter.title].filter(Boolean).join(" - ").trim() || `Chapter ${number ?? ""}`,
        number,
        releaseDate: chapter.createdAtTWithYear || chapter.createdAt,
        language: "it",
      };
    });
    return chapters;
  }

  // Balanced-parse a single JSON object that starts at objStart.
  function parseObjectAt(html, objStart) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = objStart; cursor < html.length; cursor += 1) {
      const char = html[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(objStart, cursor + 1));
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }

  // The reader page embeds the CURRENT chapter as a singular
  // "chapter":{"_id":..., "pages":[...]} object. The "chapters":[...] arrays on
  // that page belong to OTHER chapters (next/prev rails) and must not be used.
  function parseCurrentChapter(html, chapterHash) {
    const anchor = html.indexOf('"chapter":{"_id"');
    if (anchor < 0) return null;
    const objStart = html.indexOf("{", anchor);
    if (objStart < 0) return null;
    const chapter = parseObjectAt(html, objStart);
    if (!chapter || !Array.isArray(chapter.pages)) return null;
    const id = String(chapter._id || "");
    if (chapterHash && id && id !== chapterHash) return null;
    return chapter;
  }

  function chapterHashFromURL(url) {
    const match = String(url || "").match(/\/read\/([0-9a-f]+)/i);
    return match ? match[1] : "";
  }

  // The reader renders one <img> whose src carries the full CDN directory for
  // this exact chapter. Combine that directory with the current chapter's own
  // pages array so every constructed URL belongs to the requested chapter.
  function parseReaderPages(html, chapterId) {
    const imgMatch = html.match(/<img[^>]+src=(["']?(https:\/\/cdn\.mangaworld\.mx\/chapters\/[^\s"'>]+))[^>]*>/i);
    if (!imgMatch) return [];
    const directory = imgMatch[2].slice(0, imgMatch[2].lastIndexOf("/"));
    const expectedHash = chapterHashFromURL(chapterId);
    const renderedHash = chapterHashFromURL(imgMatch[2]);
    if (expectedHash && renderedHash && expectedHash !== renderedHash) {
      throw new Error("MangaWorld reader returned a different chapter than requested.");
    }
    const chapter = parseCurrentChapter(html, expectedHash);
    const pages = Array.isArray(chapter?.pages) && chapter.pages.length
      ? chapter.pages
      : [];
    if (!pages.length) {
      return [{ url: imgMatch[2], headers: IMAGE_HEADERS }];
    }
    return pages.map((name) => ({
      url: `${directory}/${String(name).replace(/^\//, "")}`,
      headers: IMAGE_HEADERS,
    }));
  }

  async function searchResults(query, page = 1) {
    const text = String((query && (query.text || query.query)) || query || "").trim();
    if (text.startsWith("__feed:")) {
      const currentPage = Math.max(1, Number(page) || 1);
      const suffix = currentPage > 1 ? `&page=${currentPage}` : "";
      const html = await fetchDirect(`${BASE_URL}/archive?sort=most-read${suffix}`, { maxBytesHint: 3 * 1024 * 1024 });
      return { items: parseSearchResults(html), hasMore: hasNextPage(html) };
    }
    const idOnly = text.match(/^(?:id:)?(\d+)$/i);
    if (idOnly) {
      const details = await extractDetails(`${BASE_URL}/manga/${idOnly[1]}`);
      return { items: [details], hasMore: false };
    }
    const currentPage = Math.max(1, Number(page) || 1);
    const suffix = currentPage > 1 ? `&page=${currentPage}` : "";
    const html = await fetchDirect(
      `${BASE_URL}/archive?keyword=${encodeURIComponent(text)}${suffix}`,
      { maxBytesHint: 3 * 1024 * 1024 },
    );
    return { items: parseSearchResults(html), hasMore: hasNextPage(html) };
  }

  async function extractDetails(id) {
    const seriesURL = /^https?:\/\//i.test(String(id))
      ? String(id)
      : `${BASE_URL}/manga/${parseSeriesID(id)}`;
    const html = await fetchDirect(seriesURL, { maxBytesHint: 4 * 1024 * 1024 });
    return parseSeriesDetails(html, seriesURL.replace(/\/$/, ""));
  }

  async function extractChapters(id) {
    const seriesURL = /^https?:\/\//i.test(String(id))
      ? String(id).replace(/\/$/, "")
      : `${BASE_URL}/manga/${parseSeriesID(id)}`;
    const html = await fetchDirect(seriesURL, { maxBytesHint: 4 * 1024 * 1024 });
    // Pending/announcement series legitimately have zero chapters yet — the
    // app renders an empty chapter list rather than failing the source.
    return parseChapters(extractChapterObjects(html), seriesURL);
  }

  async function extractImages(chapterId) {
    const url = String(chapterId || "");
    if (!/mangaworld\.mx\/.+\/read\/[0-9a-f]+/i.test(url)) {
      throw new Error("MangaWorld chapter identifier must be a reader URL.");
    }
    const html = await fetchDirect(url, { maxBytesHint: 3 * 1024 * 1024 });
    const pages = parseReaderPages(html, url);
    if (!pages.length) throw new Error("MangaWorld reader returned no readable pages.");
    return pages;
  }

  async function discoveryHome() {
    const html = await fetchDirect(BASE_URL, { maxBytesHint: 3 * 1024 * 1024 });
    // The home page renders named rails as <h2>Section</h2> ... cards.
    const sections = [];
    const headingPattern = /<(h\d|h5)\b[^>]*>([\s\S]{2,60}?)<\/\1>([\s\S]*?)(?=<h\d\b|<h5\b|$)/gi;
    let match;
    while ((match = headingPattern.exec(html)) !== null) {
      const title = stripHTML(match[2]);
      if (!title || /accedi|social|pubblicit/i.test(title)) continue;
      const items = parseSearchResults(match[3]).slice(0, 12);
      if (items.length >= 3) {
        sections.push({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, items });
      }
    }
    if (!sections.length) {
      const items = parseSearchResults(html);
      if (items.length) sections.push({ id: "featured", title: "In evidenza", items });
    }
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    return searchResults("__feed:popular", page);
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
