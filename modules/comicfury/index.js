"use strict";

(() => {
  const SEARCH_URL = "https://comicfury.com/search.php";
  const PROFILE_URL = "https://comicfury.com/comicprofile.php";
  const GOTO_URL = "https://comicfury.com/goto.php";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: "https://comicfury.com/",
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const PAGE_CACHE_TTL = 60_000;
  let archiveCache = { key: "", at: 0, value: null };

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
      throw new Error("Comic Fury requires the fetchv2 bridge.");
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
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response.status || 0);
      if (response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`Comic Fury request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      const body = await responseText(response);
      if (body) return body;
      lastError = new Error("Comic Fury returned an empty response.");
    }
    throw lastError || new Error("Comic Fury request failed.");
  }

  function absoluteURL(value, base) {
    const input = decodeEntities(String(value || "").trim());
    if (input.startsWith("https://") || input.startsWith("http://")) return input;
    if (input.startsWith("//")) return `https:${input}`;
    if (input.startsWith("/")) return `${base}${input}`;
    return "";
  }

  function extractSlug(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:comicprofile\.php\?url=|goto\.php\?[^#]*url=|read\/)([a-z0-9_-]+)/i);
    if (match) return match[1].toLowerCase();
    // Details resolves to the external domain root; recover slug from hostname.
    const domainMatch = input.match(/^https:\/\/([a-z0-9_-]+)\.(?:thecomicseries\.com|webcomic\.ws|[a-z0-9_-]+\.comicfury\.com)\/?$/i);
    if (domainMatch) return domainMatch[1].toLowerCase();
    if (/^[a-z0-9_-]+$/i.test(input)) return input.toLowerCase();
    throw new Error("Invalid Comic Fury series identifier.");
  }

  function seriesBaseURL(slug, domain) {
    return `https://${domain}`;
  }

  function isContentWarningPage(body) {
    return /<form[^>]*method=["']POST["'][^>]*action=["'][^"']*goto\.php[^"']*["'][^>]*>[\s\S]*?<input[^>]*name=["']proceed["']/i.test(String(body || ""));
  }

  async function resolveDomain(slug) {
    const url = `${GOTO_URL}?mode=visit&url=${encodeURIComponent(slug)}`;
    let response = await globalThis.fetchv2(
      url,
      DEFAULT_HEADERS,
      "GET",
      null,
      { followRedirects: false, maxBytesHint: 8192, responseClass: "html" },
    );

    // Content-warning interstitial: POST back with the token to continue.
    if (isContentWarningPage(response.body)) {
      const tokenMatch = String(response.body).match(/<input[^>]*name=["']token["'][^>]*value=["']([0-9]+)["']/i);
      const token = tokenMatch?.[1] || "";
      response = await globalThis.fetchv2(
        url,
        { ...DEFAULT_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        "POST",
        `token=${encodeURIComponent(token)}&proceed=${encodeURIComponent("View Webcomic")}`,
        { followRedirects: false, maxBytesHint: 8192, responseClass: "html" },
      );
    }

    const location = String(response?.headers?.location || "");
    if (location) {
      const parsed = new URL(location);
      return parsed.hostname;
    }
    // Fallback: some bridges only expose finalURL after following.
    const finalUrl = String(response?.finalUrl || response?.url || "");
    if (finalUrl && finalUrl !== url) {
      const parsed = new URL(finalUrl);
      return parsed.hostname;
    }
    throw new Error(`Comic Fury could not resolve domain for ${slug}.`);
  }

  function parseSearchHTML(html) {
    const source = String(html || "");
    const items = [];
    const seen = new Set();
    const blockPattern = /<div class="webcomic-result">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    let block;
    while ((block = blockPattern.exec(source)) !== null) {
      const body = block[1];
      const profile = body.match(/<a\b[^>]*href=["']\/comicprofile\.php\?url=([a-z0-9_-]+)["']/i);
      if (!profile) continue;
      const slug = profile[1].toLowerCase();
      if (seen.has(slug)) continue;
      seen.add(slug);

      const titleLink = body.match(/<div class="webcomic-result-title"[^>]*title=["']([^"']+)["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      const title = stripHTML(titleLink?.[2] || titleLink?.[1] || "");
      if (!title) continue;

      const imgTag = body.match(/<div class="webcomic-result-avatar">[\s\S]*?<img\b[^>]*>/i)?.[0];
      const image = imgTag ? absoluteURL(attribute(imgTag, "src"), "https://comicfury.com") : "";

      items.push({
        id: `https://comicfury.com/comicprofile.php?url=${slug}`,
        href: `https://comicfury.com/comicprofile.php?url=${slug}`,
        title,
        image,
      });
    }
    return { items, hasMore: items.length >= 20 };
  }

  function parseDetailsHTML(html, slug, domain) {
    const source = String(html || "");
    const base = "https://comicfury.com";

    let title = "";
    const titleTag = source.match(/<title>([\s\S]*?)<\/title>/i);
    if (titleTag) {
      title = stripHTML(titleTag[1]).replace(/\s*-\s*Webcomic profile.*$/i, "").trim();
    }
    if (!title) {
      const h1Match = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
      title = stripHTML(h1Match?.[1] || "").replace(/^Comic Profile:\s*/i, "").trim();
    }

    let image = "";
    const bannerTag = source.match(/<img\b[^>]*src=["']\/comicbans\/[^"']+["'][^>]*>/i)?.[0];
    if (bannerTag) image = absoluteURL(attribute(bannerTag, "src"), base);
    if (!image) {
      const avatarTag = source.match(/<img\b[^>]*class=["'][^"']*webcomic-avatar[^"']*["'][^>]*>/i)?.[0]
        || source.match(/<div class="webcomic-result-avatar">[\s\S]*?<img\b[^>]*>/i)?.[0];
      image = avatarTag ? absoluteURL(attribute(avatarTag, "src"), base) : "";
    }
    if (!image) {
      const ogImage = source.match(/<meta\b[^>]*property=["']og:image["'][^>]*>/i);
      image = ogImage ? absoluteURL(attribute(ogImage[0], "content"), base) : "";
    }

    let description = "";
    const descHeading = source.search(/<h2 class="pchead">Webcomic description<\/h2>/i);
    if (descHeading !== -1) {
      const contentMatch = source.slice(descHeading).match(/<div class="pccontent">([\s\S]*?)<div class="description-tags">/i);
      if (contentMatch) {
        description = stripHTML(contentMatch[1]);
      }
    }

    const genreTags = Array.from(source.matchAll(/<a\b[^>]*class=["']webcomic-profile-tag["'][^>]*>([\s\S]*?)<\/a>/gi))
      .map((m) => stripHTML(m[1]))
      .filter(Boolean);

    let authors = [];
    const authorsHeading = source.search(/<h2 class="pchead">Authors<\/h2>/i);
    if (authorsHeading !== -1) {
      const authorsBlock = source.slice(authorsHeading, authorsHeading + 3000);
      authors = Array.from(authorsBlock.matchAll(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi))
        .map((m) => stripHTML(m[1]))
        .filter(Boolean);
      if (!authors.length) {
        authors = Array.from(authorsBlock.matchAll(/<a\b[^>]*href=["']\/user\/[a-z0-9_-]+\/?["'][^>]*>([\s\S]*?)<\/a>/gi))
          .map((m) => stripHTML(m[1]))
          .filter(Boolean);
      }
    }

    let status = "Unknown";
    const statusMatch = source.match(/<span class="infoname">Activity status:<\/span>\s*<span class="info">([\s\S]*?)<\/span>/i);
    if (statusMatch) {
      const value = stripHTML(statusMatch[1]).toLowerCase();
      if (value.includes("completed")) status = "Completed";
      else if (value.includes("ongoing") || value.includes("active")) status = "Ongoing";
      else if (value.includes("hiatus")) status = "Hiatus";
    }

    return {
      id: `https://${domain}/`,
      href: `https://${domain}/`,
      url: `https://${domain}/`,
      title: title || slug,
      description,
      image,
      authors,
      author: authors.join(", ") || "Unknown",
      genres: genreTags,
      status,
    };
  }

  function parseArchiveHTML(html, domain) {
    const source = String(html || "");
    const base = `https://${domain}`;
    const chapters = [];
    const chapterPattern = /<tr class="chaptertitle">[\s\S]*?<h3 class="archivechapter">([\s\S]*?)<\/h3>[\s\S]*?<\/tr>([\s\S]*?)(?=<tr class="chaptertitle">|$)/gi;
    let chapterMatch;
    let chapterIndex = 0;

    while ((chapterMatch = chapterPattern.exec(source)) !== null) {
      chapterIndex += 1;
      const title = stripHTML(chapterMatch[1]);
      const block = chapterMatch[2];
      const pages = [];
      const comicPattern = /<tr class="archivecomic">[\s\S]*?<a href="\/comics\/([0-9]+)\/">([\s\S]*?)<\/a>/gi;
      let comic;
      while ((comic = comicPattern.exec(block)) !== null) {
        const number = Number(comic[1]);
        const comicTitle = stripHTML(comic[2]);
        if (!Number.isFinite(number)) continue;
        pages.push({ number, title: comicTitle });
      }
      if (!pages.length) continue;
      chapters.push({
        index: chapterIndex,
        title,
        startPage: pages[0].number,
        endPage: pages[pages.length - 1].number,
        base,
        pages,
      });
    }

    // If the archive has no explicit chapters, treat every comic as its own chapter.
    if (!chapters.length) {
      const comicPattern = /<tr class="archivecomic">[\s\S]*?<a href="\/comics\/([0-9]+)\/">([\s\S]*?)<\/a>/gi;
      let comic;
      while ((comic = comicPattern.exec(source)) !== null) {
        const number = Number(comic[1]);
        const title = stripHTML(comic[2]);
        if (!Number.isFinite(number)) continue;
        chapters.push({
          index: chapters.length + 1,
          title: title || `Page ${number}`,
          startPage: number,
          endPage: number,
          base,
          pages: [{ number, title }],
        });
      }
    }

    return chapters;
  }

  async function fetchArchive(domain) {
    const key = domain;
    if (archiveCache.key === key && archiveCache.value && Date.now() - archiveCache.at < PAGE_CACHE_TTL) {
      return archiveCache.value;
    }
    const url = `https://${domain}/archive/`;
    const body = await fetchDirect(url, { maxBytesHint: 4 * 1024 * 1024 });
    const chapters = parseArchiveHTML(body, domain);
    archiveCache = { key, at: Date.now(), value: chapters };
    return chapters;
  }

  function parseComicPageImage(html, domain) {
    const source = String(html || "");
    const match = source.match(/<img\b[^>]*id=["']comicimage["'][^>]*>/i);
    if (!match) return "";
    return absoluteURL(attribute(match[0], "src"), `https://${domain}`);
  }

  async function extractComicImage(domain, pageNumber) {
    const url = `https://${domain}/comics/${pageNumber}/`;
    const body = await fetchDirect(url, { maxBytesHint: 2 * 1024 * 1024 });
    return parseComicPageImage(body, domain);
  }

  function normalizeSearchQuery(query) {
    const raw = String(query || "");
    if (raw === "__feed:popular") return { feed: "popular", text: "" };
    if (raw === "__feed:latest") return { feed: "latest", text: "" };
    return { feed: "search", text: raw.trim().slice(0, 200) };
  }

  async function searchResults(query, page = 1) {
    const normalized = normalizeSearchQuery(query);
    const currentPage = Math.max(1, Number(page) || 1);
    const sort = normalized.feed === "popular" ? "1" : "2";
    const url = `${SEARCH_URL}?vr=1&query=${encodeURIComponent(normalized.text)}&sort=${sort}&lastupdate=0&completed=1&fn=2&fv=2&fs=2&fl=2${currentPage > 1 ? `&page=${currentPage}` : ""}`;
    const items = parseSearchHTML(await fetchDirect(url, { maxBytesHint: 2 * 1024 * 1024 })).items;
    return { items, hasMore: items.length >= 20 };
  }

  async function extractDetails(id) {
    const slug = extractSlug(id);
    const profileUrl = `${PROFILE_URL}?url=${encodeURIComponent(slug)}`;
    const [html, domain] = await Promise.all([
      fetchDirect(profileUrl, { maxBytesHint: 2 * 1024 * 1024 }),
      resolveDomain(slug).catch(() => null),
    ]);
    if (!domain) {
      throw new Error("Comic Fury could not resolve an external comic site for this profile.");
    }
    return parseDetailsHTML(html, slug, domain);
  }

  async function extractChapters(id) {
    const details = await extractDetails(id);
    const domain = new URL(details.id).hostname;
    const chapters = await fetchArchive(domain);
    if (!chapters.length) {
      throw new Error("Comic Fury returned no chapters for this series.");
    }
    return chapters.map((chapter) => ({
      id: `https://${domain}/archive/#chapter-${chapter.index}`,
      href: `https://${domain}/archive/#chapter-${chapter.index}`,
      url: `https://${domain}/archive/#chapter-${chapter.index}`,
      title: chapter.title,
      number: chapter.index,
      releaseDate: null,
      language: "en",
    }));
  }

  async function extractImages(id) {
    const input = String(id || "").trim();
    const match = input.match(/^(https:\/\/[^/]+)\/archive\/#chapter-([0-9]+)$/);
    if (!match) {
      throw new Error("Invalid Comic Fury chapter identifier.");
    }
    const domain = new URL(match[1]).hostname;
    const chapterIndex = Number(match[2]);
    const chapters = await fetchArchive(domain);
    const chapter = chapters.find((c) => c.index === chapterIndex);
    if (!chapter) {
      throw new Error("Comic Fury chapter not found in archive.");
    }

    const pages = [];
    const seen = new Set();
    for (const page of chapter.pages) {
      const url = await extractComicImage(domain, page.number);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push({
        url,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*",
          Referer: `https://${domain}/`,
        },
      });
    }
    if (!pages.length) {
      throw new Error("Comic Fury returned no readable pages for this chapter.");
    }
    return pages;
  }

  async function discoveryHome() {
    const search = await searchResults("__feed:popular", 1);
    return {
      sections: [
        { id: "popular", title: "Popular", items: search.items },
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
