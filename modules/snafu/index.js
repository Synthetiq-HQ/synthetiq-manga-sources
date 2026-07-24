"use strict";

/**
 * SNAFU Comics — official co-owner preview module for Synthetiq Books.
 * Site: https://www.snafu-comics.com (ComicControl / Hiveworks layout)
 *
 * Model: each series is a title; each archive strip is a chapter with one page image.
 * Do not publish to public users without written co-owner / rights confirmation.
 */
(() => {
  const BASE_URL = "https://www.snafu-comics.com";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;

  function sleep(ms) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, ms);
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

  function absoluteURL(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
    return `${BASE_URL}/${raw.replace(/^\/+/, "")}`;
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
      throw new Error("SNAFU requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1000 * (attempt - 1));
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          options.method || "GET",
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint: options.maxBytesHint || 4 * 1024 * 1024,
            responseClass: options.responseClass || "html",
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`SNAFU request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) {
        throw new Error(`SNAFU response dropped: ${response.dropReason || "size policy"}.`);
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("SNAFU returned an empty response.");
    }
    throw lastError || new Error("SNAFU request failed.");
  }

  function seriesSlugFromURL(value) {
    const abs = absoluteURL(value);
    const match = abs.match(/snafu-comics\.com\/([a-z0-9-]+)(?:\/|$)/i);
    if (!match) {
      const bare = String(value || "").replace(/^\/+|\/+$/g, "");
      if (/^[a-z0-9-]+$/i.test(bare)) return bare.toLowerCase();
      throw new Error("Invalid SNAFU series identifier.");
    }
    const slug = match[1].toLowerCase();
    if (["all-comics", "about-us", "all-rss", "comiccontrol", "assets", "images"].includes(slug)) {
      throw new Error("Invalid SNAFU series identifier.");
    }
    return slug;
  }

  function pagePathFromURL(value) {
    const abs = absoluteURL(value);
    const match = abs.match(/snafu-comics\.com\/([a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)\/?$/i)
      || abs.match(/snafu-comics\.com\/([a-z0-9-]+)$/i);
    if (!match) throw new Error("Invalid SNAFU page identifier.");
    return match[1].replace(/\/+$/, "");
  }

  function parseCatalogueHTML(html) {
    const tiles = String(html).matchAll(
      /<div\b[^>]*class=["'][^"']*\bhome-single-tile\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi,
    );
    const items = [];
    const seen = new Set();
    for (const match of tiles) {
      const href = absoluteURL(match[1]);
      // Series home only: /slug — skip individual update pages /slug/page-slug
      const path = href.replace(BASE_URL, "").replace(/\/+$/, "");
      if (!/^\/[a-z0-9-]+$/i.test(path)) continue;
      if (seen.has(href)) continue;
      const body = match[2];
      const title = stripHTML(
        (body.match(/class=["'][^"']*\bhome-tile-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
          || (body.match(/alt=["']([^"']+)["']/i) || [])[1]
          || "",
      );
      if (!title) continue;
      const authorRaw = stripHTML(
        (body.match(/class=["'][^"']*\bhome-tile-author\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
          || "",
      );
      const author = authorRaw.replace(/^by\s+/i, "").trim();
      const image = absoluteURL(
        (body.match(/<img\b[^>]*src=["']([^"']+)["']/i) || [])[1] || "",
      );
      seen.add(href);
      items.push({
        id: href,
        href,
        url: href,
        title,
        image: image || null,
        author: author || null,
        authors: author ? [author] : [],
      });
    }
    return items;
  }

  function parseLatestUpdates(html) {
    const tiles = String(html).matchAll(
      /<div\b[^>]*class=["'][^"']*\bhome-single-tile\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi,
    );
    const items = [];
    const seen = new Set();
    for (const match of tiles) {
      const href = absoluteURL(match[1]);
      // Prefer update pages /series/page
      if (!/snafu-comics\.com\/[a-z0-9-]+\/[a-z0-9-]+/i.test(href)) continue;
      const body = match[2];
      const seriesTitle = stripHTML(
        (body.match(/class=["'][^"']*\bhome-tile-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
          || "",
      );
      const update = stripHTML(
        (body.match(/class=["'][^"']*\bhome-tile-update\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
          || "",
      );
      const title = update ? `${seriesTitle}: ${update}` : seriesTitle;
      if (!title || seen.has(href)) continue;
      const image = absoluteURL(
        (body.match(/<img\b[^>]*src=["']([^"']+)["']/i) || [])[1] || "",
      );
      // Map to series for details navigation
      let seriesHref = href;
      try {
        seriesHref = `${BASE_URL}/${seriesSlugFromURL(href)}`;
      } catch {
        // keep page href
      }
      seen.add(href);
      items.push({
        id: seriesHref,
        href: seriesHref,
        url: seriesHref,
        title: seriesTitle || title,
        image: image || null,
        description: update || null,
      });
    }
    return items;
  }

  function parseArchivePages(html, seriesSlug) {
    const options = [...String(html).matchAll(
      /<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi,
    )];
    const chapters = [];
    const seen = new Set();
    let index = 0;
    for (const match of options) {
      const value = decodeEntities(match[1]).trim();
      if (!value || value === "Select a comic...") continue;
      // value is like powerpuffgirls/ppg-chapter-1
      const href = absoluteURL(value.includes("/") ? value : `${seriesSlug}/${value}`);
      if (seen.has(href)) continue;
      const label = stripHTML(match[2]);
      if (!label || /^select/i.test(label)) continue;
      index += 1;
      // "January 18, 2004 - PPG Chapter 1"
      const dateMatch = label.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s*[-–—]\s*(.+)$/);
      const title = dateMatch ? dateMatch[2].trim() : label;
      const releaseDate = dateMatch ? dateMatch[1] : null;
      const numberMatch = title.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i);
      chapters.push({
        id: href,
        href,
        url: href,
        title: title || `Page ${index}`,
        number: numberMatch ? Number(numberMatch[1]) : index,
        releaseDate,
        language: "en",
      });
      seen.add(href);
    }
    return chapters;
  }

  function parseComicImage(html) {
    const sources = [
      html.match(/<img\b[^>]*\bid=["']cc-comic["'][^>]*>/i),
      html.match(/<img\b[^>]*\bsrc=["'][^"']*\/comics\/[^"']+["'][^>]*>/i),
    ];
    for (const tagMatch of sources) {
      if (!tagMatch) continue;
      const tag = tagMatch[0];
      const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
      if (src && /\/comics\//i.test(src)) {
        return absoluteURL(src);
      }
    }
    const fallback = html.match(/https:\/\/www\.snafu-comics\.com\/comics\/[^\s"'<>]+/i);
    return fallback ? fallback[0] : "";
  }

  function parseDetailsFromSeriesPage(html, seriesURL) {
    const title =
      stripHTML((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")
        .replace(/^SNAFU\s*[-–—]\s*/i, "")
        .replace(/\s*[-–—]\s*Archive\s*$/i, "")
        .trim()
      || seriesSlugFromURL(seriesURL);
    // Prefer structured tile author; avoid matching body copy like "by going here".
    let author = stripHTML(
      (html.match(/class=["'][^"']*\bhome-tile-author\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
        || "",
    ).replace(/^by\s+/i, "").trim();
    if (!author) {
      const authorMatch = html.match(/\bby\s+([A-Z][A-Za-z0-9 .'"&-]{1,60})(?:\s*<|\s*$)/);
      const candidate = authorMatch ? stripHTML(authorMatch[1]).trim() : "";
      if (candidate && !/^(going|select|reading|starting)/i.test(candidate)) {
        author = candidate.slice(0, 80);
      }
    }
    const image = absoluteURL(
      (html.match(/class=["'][^"']*\bhome-tile-img\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i) || [])[1]
        || (html.match(/\/images\/thumbs\/[a-z0-9._-]+\.(?:jpg|jpeg|png|webp)/i) || [])[0]
        || "",
    );
    let description = stripHTML(
      (html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1]
        || "",
    );
    if (!description) {
      description = `Read ${title} on SNAFU Comics.`;
    }
    return {
      id: seriesURL,
      href: seriesURL,
      url: seriesURL,
      title,
      description,
      image: image || null,
      author: author || null,
      authors: author ? [author] : [],
      status: "Unknown",
      genres: ["Webcomic"],
    };
  }

  async function loadCatalogue() {
    return parseCatalogueHTML(await fetchDirect(`${BASE_URL}/all-comics`));
  }

  async function searchResults(query, page = 1) {
    // Support niche JSON envelope from the app
    let text = query;
    let status = null;
    if (typeof query === "string" && query.startsWith("__niche__:")) {
      try {
        const payload = JSON.parse(query.slice("__niche__:".length));
        text = payload.text || payload.query || "";
        status = payload.status || null;
      } catch {
        // keep string
      }
    } else if (query && typeof query === "object" && !Array.isArray(query)) {
      text = query.text || query.query || "";
      status = query.status || null;
    }

    const raw = String(text || "");
    const currentPage = Math.max(1, Number(page) || 1);
    if (raw === "__feed:popular" || raw === "__feed:latest" || raw === "__feed:niche") {
      if (raw === "__feed:latest") {
        const home = await fetchDirect(`${BASE_URL}/`);
        const latest = parseLatestUpdates(home);
        // Deduplicate by series
        const bySeries = [];
        const seen = new Set();
        for (const item of latest) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          bySeries.push(item);
        }
        return { items: bySeries, hasMore: false };
      }
      const all = await loadCatalogue();
      // Simple paging over static catalogue
      const pageSize = 24;
      const start = (currentPage - 1) * pageSize;
      const slice = all.slice(start, start + pageSize);
      return { items: slice, hasMore: start + pageSize < all.length };
    }

    const all = await loadCatalogue();
    const needle = raw.trim().toLowerCase();
    const filtered = !needle
      ? all
      : all.filter((item) => {
        const hay = `${item.title} ${item.author || ""}`.toLowerCase();
        return hay.includes(needle);
      });
    // status not exposed by site — ignored (status param reserved)
    void status;
    const pageSize = 40;
    const start = (currentPage - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return { items: slice, hasMore: start + pageSize < filtered.length };
  }

  async function extractDetails(id) {
    const slug = seriesSlugFromURL(id);
    const seriesURL = `${BASE_URL}/${slug}`;
    // Prefer archive page (richer) but series home works too
    let html = "";
    try {
      html = await fetchDirect(`${seriesURL}/archive`);
    } catch {
      html = await fetchDirect(seriesURL);
    }
    const details = parseDetailsFromSeriesPage(html, seriesURL);
    // Fill author from catalogue when missing
    if (!details.author) {
      try {
        const cat = await loadCatalogue();
        const hit = cat.find((item) => item.id === seriesURL || item.href === seriesURL);
        if (hit?.author) {
          details.author = hit.author;
          details.authors = hit.authors || [hit.author];
        }
        if (!details.image && hit?.image) details.image = hit.image;
      } catch {
        // ignore
      }
    }
    return details;
  }

  async function extractChapters(id) {
    const slug = seriesSlugFromURL(id);
    const archiveURL = `${BASE_URL}/${slug}/archive`;
    const html = await fetchDirect(archiveURL, { maxBytesHint: 8 * 1024 * 1024 });
    const chapters = parseArchivePages(html, slug);
    if (!chapters.length) {
      // Single-page series: use series root as the only chapter
      chapters.push({
        id: `${BASE_URL}/${slug}`,
        href: `${BASE_URL}/${slug}`,
        url: `${BASE_URL}/${slug}`,
        title: "Latest page",
        number: 1,
        releaseDate: null,
        language: "en",
      });
    }
    return chapters;
  }

  async function extractImages(id) {
    const path = pagePathFromURL(id);
    const pageURL = `${BASE_URL}/${path}`;
    const html = await fetchDirect(pageURL);
    const image = parseComicImage(html);
    if (!image) {
      throw new Error("SNAFU page did not include a comic image.");
    }
    return [
      {
        url: image,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: `${BASE_URL}/`,
        },
      },
    ];
  }

  async function discoveryHome() {
    const [popular, latest] = await Promise.all([
      searchResults("__feed:popular", 1),
      searchResults("__feed:latest", 1),
    ]);
    return {
      sections: [
        { id: "popular", title: "All Series", items: popular.items },
        { id: "latest", title: "Latest Updates", items: latest.items },
      ].filter((section) => section.items && section.items.length),
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase();
    if (feed === "latest") return searchResults("__feed:latest", page);
    return searchResults("__feed:popular", page);
  }

  async function extractTags() {
    return ["Webcomic", "Action", "Comedy", "Adventure", "Fantasy", "Parody"];
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
