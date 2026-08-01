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
  const MAX_CHAPTERS = 120;
  const MAX_PAGES_PER_CHAPTER = 400;
  let archiveCache = { key: "", at: 0, value: null };
  const warningsCookieCache = new Map();

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
    // The interstitial form declares no method attribute (defaults to GET), so
    // only the action target and the proceed field identify it reliably.
    return /<form\b[^>]*action=["'][^"']*goto\.php[^"']*["'][^>]*>[\s\S]*?<input[^>]*name=["']proceed["']/i.test(String(body || ""));
  }

  async function resolveDomain(slug, profileHTML) {
    const url = `${GOTO_URL}?mode=visit&url=${encodeURIComponent(slug)}`;
    const cachedWarningsCookie = warningsCookieCache.get(slug) || "";
    let response = await globalThis.fetchv2(
      url,
      { ...DEFAULT_HEADERS, ...(cachedWarningsCookie ? { Cookie: cachedWarningsCookie } : {}) },
      "GET",
      null,
      { followRedirects: false, maxBytesHint: 8192, responseClass: "html" },
    );

    // The interstitial issues a token cookie on the first visit; keep it so the
    // proceed POST works even without a persistent cookie store.
    const setCookie = String(response?.headers?.["set-cookie"] || response?.headers?.["Set-Cookie"] || "");
    let cookieValue = setCookie.match(/^([^=;]+=[^;]+)/)?.[1] || "";

    // Content-warning interstitial: POST back with the token to continue.
    if (isContentWarningPage(response.body)) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const tokenMatch = String(response.body).match(/<input[^>]*name=["']token["'][^>]*value=["']([0-9]+)["']/i);
        const token = tokenMatch?.[1] || "";
        response = await globalThis.fetchv2(
          url,
          {
            ...DEFAULT_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            ...(cookieValue ? { Cookie: cookieValue } : {}),
          },
          "POST",
          `token=${encodeURIComponent(token)}&proceed=${encodeURIComponent("View Webcomic")}`,
          { followRedirects: false, maxBytesHint: 8192, responseClass: "html" },
        );
        const location = String(response?.headers?.location || "");
        if (location) {
          // A successful proceed POST sets a webcomic_warnings cookie that
          // bypasses the interstitial on subsequent requests to this comic.
          const warnings = String(response?.headers?.["set-cookie"] || "").match(/webcomic_warnings=[^;]+/i);
          if (warnings) warningsCookieCache.set(slug, warnings[0]);
          const parsed = new URL(location);
          return parsed.hostname;
        }
        // The interstitial re-renders with a fresh token and cookie; retry once
        // with the rotated values.
        const rotatedCookie = String(response?.headers?.["set-cookie"] || response?.headers?.["Set-Cookie"] || "");
        if (rotatedCookie) {
          const rotatedValue = rotatedCookie.match(/^([^=;]+=[^;]+)/)?.[1] || "";
          if (rotatedValue) cookieValue = rotatedValue;
        }
        if (!isContentWarningPage(response.body)) break;
      }
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
    // Fallback: the profile page links the comic's own host, which for
    // ComicFury-hosted comics is <slug>.thecomicseries.com / <slug>.webcomic.ws.
    const profileHost = String(profileHTML || "").match(
      new RegExp(`https?://${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.((?:thecomicseries\\.com|webcomic\\.ws|comicfury\\.com))`, "i"),
    );
    if (profileHost) return `${slug}.${profileHost[1]}`;
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
      authors = Array.from(authorsBlock.matchAll(/<a\b[^>]*href=["']\/user\/[a-z0-9_-]+\/?["'][^>]*>([\s\S]*?)<\/a>/gi))
        .map((m) => stripHTML(m[1]))
        .filter(Boolean);
      if (!authors.length) {
        authors = Array.from(authorsBlock.matchAll(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi))
          .map((m) => stripHTML(m[1]))
          .filter((value) => value && !/^image$/i.test(value));
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

  function pageNumberFromURL(value) {
    const match = String(value || "").match(/(?:^|\/)comics\/(?:pl\/)?([0-9]+)\/?/i);
    return match ? Number(match[1]) : NaN;
  }

  // Rows in the modern archive layouts: <div class="archivecomic"> blocks
  // (flex theme), their custom "nl-" variants, or legacy
  // <tr class="archivecomic"> table rows.
  function parseComicRows(source, base) {
    const rows = [];
    const seen = new Set();
    const variants = ['<div class="archivecomic">', '<div class="nl-archivecomic">'];
    for (let v = 0; v < variants.length; v += 1) {
      const marker = variants[v];
      const blocks = String(source || "").split(marker).slice(1);
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        const end = block.indexOf(marker);
        const body = end === -1 ? block : block.slice(0, end);
        const numberMatch = body.match(/<div class="(?:archivecomicnumber|nl-archivecomicnumber)">\s*([0-9]+)\.?\s*<\/div>/i);
        const linkMatch = body.match(/<a class="(?:archivecomictitle|nl-archivecomictitle)"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const number = numberMatch ? Number(numberMatch[1]) : NaN;
        const title = stripHTML(linkMatch[2]) || (Number.isFinite(number) ? `Page ${number}` : "");
        const href = absoluteURL(linkMatch[1], base);
        if (!href || seen.has(href)) continue;
        seen.add(href);
        rows.push({ number, title, url: href });
      }
    }
    if (!rows.length) {
      const canonical = domainFromSource(source);
      for (const block of String(source || "").split('<tr class="archivecomic">').slice(1)) {
        const end = block.indexOf('<tr class="archivecomic">');
        const body = end === -1 ? block : block.slice(0, end);
        const linkMatch = body.match(/<a\b[^>]*href=["']\/(?:comics|comic)\/([0-9]+)\/?["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const number = Number(linkMatch[1]);
        const title = stripHTML(linkMatch[2]) || `Page ${number}`;
        if (!Number.isFinite(number) || seen.has(`/comics/${number}/`) || !canonical) continue;
        seen.add(`/comics/${number}/`);
        rows.push({ number, title, url: `https://${canonical}/comics/${number}/` });
      }
    }
    return rows;
  }

  function domainFromSource(source) {
    const match = String(source || "").match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']https:\/\/([^\/"']+)/i);
    return match ? match[1] : "";
  }

  // Chaptered layout A: <div class="chapter"> blocks with title + "Comics in
  // this chapter" link to /archive/<id>. Custom archives use the identical
  // markup under the <div class="nl-chapter"> class.
  function parseChapterBlocks(source) {
    const chapters = [];
    const blocks = String(source || "").split('<div class="chapter">').slice(1);
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      const end = block.indexOf('<div class="chapter">');
      const body = end === -1 ? block : block.slice(0, end);
      const titleLink = body.match(/<h3>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const moreLink = body.match(/<a\b[^>]*href=["'](\/archive\/([0-9]+))["'][^>]*>/i);
      if (!titleLink) continue;
      const title = stripHTML(titleLink[2]) || "Untitled Chapter";
      const start = pageNumberFromURL(titleLink[1]);
      chapters.push({
        kind: "chapter",
        title,
        startPage: Number.isFinite(start) ? start : NaN,
        archivePath: moreLink ? moreLink[1] : null,
        archiveID: moreLink ? Number(moreLink[2]) : NaN,
      });
    }
    const nlBlocks = String(source || "").split('<div class="nl-chapter">').slice(1);
    for (let i = 0; i < nlBlocks.length; i += 1) {
      const block = nlBlocks[i];
      const end = block.indexOf('<div class="nl-chapter">');
      const body = end === -1 ? block : block.slice(0, end);
      const titleLink = body.match(/<h3>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const moreLink = body.match(/<a\b[^>]*href=["'](\/archive\/([0-9]+))["'][^>]*>/i);
      if (!titleLink) continue;
      const title = stripHTML(titleLink[2]) || "Untitled Chapter";
      const start = pageNumberFromURL(titleLink[1]);
      chapters.push({
        kind: "chapter",
        title,
        startPage: Number.isFinite(start) ? start : NaN,
        archivePath: moreLink ? moreLink[1] : null,
        archiveID: moreLink ? Number(moreLink[2]) : NaN,
      });
    }
    return chapters;
  }

  // Chaptered layout B: <article class="archive_chapter_detail"> blocks with a
  // single start page per chapter (game/branching comics). Pages are walked via
  // the "next" link of each page at read time.
  function parseChapterDetailBlocks(source, base) {
    const chapters = [];
    const blocks = String(source || "").split('<article class="archive_chapter_detail">').slice(1);
    for (const block of blocks) {
      const end = block.indexOf('<article class="archive_chapter_detail">');
      const body = end === -1 ? block : block.slice(0, end);
      const titleLink = body.match(/<h3[^>]*class=["']archive_chapter_title["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
        || body.match(/<a\b[^>]*href=["']([^"']+[^"']*comics[^"']*|[^"']*\/comics\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!titleLink) continue;
      const title = stripHTML(titleLink[2]) || "Untitled Chapter";
      const start = pageNumberFromURL(titleLink[1]);
      if (!Number.isFinite(start)) continue;
      chapters.push({
        kind: "walk",
        title,
        startPage: start,
        startURL: absoluteURL(titleLink[1], base),
      });
    }
    return chapters;
  }

  // Legacy table layout: chapters grouped by <tr class="chaptertitle"> rows
  // (some sites omit the class on the <h3> heading and/or on the page rows).
  // Page rows link to /comics/<N>/; the row's own number is repeated in a
  // "comments" link, so numbers are deduplicated.
  function parseLegacyTableChapters(source, base) {
    const chapters = [];
    const chapterPattern = /<tr\b[^>]*class="chaptertitle\s*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/tr>([\s\S]*?)(?=<tr\b[^>]*class="chaptertitle\s*"|$)/gi;
    let chapterMatch;
    while ((chapterMatch = chapterPattern.exec(source)) !== null) {
      const title = stripHTML(chapterMatch[1]);
      const pages = [];
      const seen = new Set();
      const comicPattern = /<tr\b[^>]*>[\s\S]*?<a\b[^>]*href="\/comics\/([0-9]+)\/"[\s\S]*?<\/tr>/gi;
      let comic;
      while ((comic = comicPattern.exec(chapterMatch[2])) !== null) {
        const number = Number(comic[1]);
        if (!Number.isFinite(number) || seen.has(number)) continue;
        seen.add(number);
        pages.push({ number, title: `Page ${number}`, url: `${base}/comics/${number}/` });
      }
      if (!pages.length) continue;
      chapters.push({
        kind: "flat",
        title,
        startPage: pages[0].number,
        endPage: pages[pages.length - 1].number,
        pages,
      });
    }
    return chapters;
  }

  // Determine how a comic structures its archive:
  //  - explicit chapters (layout A / B / legacy tables) -> chapters as the site
  //    groups them, pages resolved lazily per chapter,
  //  - no chapters (flat page list) -> every page collected into one chapter so
  //    the whole comic reads together.
  function parseArchiveHTML(html, domain) {
    const source = String(html || "");
    const base = `https://${domain}`;
    const chapters = [];

    const chaptered = parseChapterBlocks(source);
    for (let index = 0; index < chaptered.length; index += 1) {
      const chapter = chaptered[index];
      chapters.push({
        index: index + 1,
        title: chapter.title,
        startPage: chapter.startPage,
        endPage: NaN,
        base,
        kind: "chapter",
        archivePath: chapter.archivePath || `/archive/${chapter.archiveID}`,
      });
    }

    if (!chapters.length) {
      const detailChapters = parseChapterDetailBlocks(source, base);
      for (let index = 0; index < detailChapters.length; index += 1) {
        const chapter = detailChapters[index];
        chapters.push({
          index: index + 1,
          title: chapter.title,
          startPage: chapter.startPage,
          endPage: NaN,
          base,
          kind: "walk",
          startURL: chapter.startURL,
        });
      }
    }

    if (!chapters.length) {
      const legacy = parseLegacyTableChapters(source, base);
      for (let index = 0; index < legacy.length; index += 1) {
        chapters.push({ ...legacy[index], index: index + 1, base });
      }
    }

    // Flat archive: no chapter groupings at all. Collect every listed comic
    // into a single chapter so the whole series reads top to bottom.
    if (!chapters.length) {
      const rows = parseComicRows(source, base);
      if (rows.length) {
        const pages = rows.map((row) => ({
          number: row.number,
          title: row.title,
          url: row.url,
        }));
        chapters.push({
          index: 1,
          title: "All Pages",
          startPage: pages[0].number,
          endPage: pages[pages.length - 1].number,
          base,
          kind: "flat",
          pages,
        });
      }
    }

    // Walk kind: chapters are consecutive page ranges; fill endPage lazily.
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      if (chapter.kind === "walk") {
        const next = chapters[index + 1];
        chapter.endPage = next ? next.startPage - 1 : chapter.startPage;
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

  // Resolve the concrete page URLs of one chapter according to its kind.
  async function chapterPages(chapter, domain) {
    if (chapter.kind === "flat") return chapter.pages || [];

    if (chapter.kind === "chapter") {
      const url = `${chapter.base}${chapter.archivePath}`;
      const body = await fetchDirect(url, { maxBytesHint: 4 * 1024 * 1024 });
      return parseComicRows(body, chapter.base).map((row) => ({
        number: row.number,
        title: row.title,
        url: row.url,
      }));
    }

    if (chapter.kind === "walk") {
      const pages = [];
      const seen = new Set();
      let nextURL = chapter.startURL;
      let guard = 0;
      while (nextURL && guard < MAX_PAGES_PER_CHAPTER) {
        const number = pageNumberFromURL(nextURL);
        if (seen.has(nextURL)) break;
        seen.add(nextURL);
        if (Number.isFinite(chapter.endPage) && number > chapter.endPage) break;
        pages.push({ number, title: pages.length ? `Page ${number}` : chapter.title, url: nextURL });
        const body = await fetchDirect(nextURL, { maxBytesHint: 2 * 1024 * 1024 });
        const nextMatch = String(body).match(/<link\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*>/i)
          || String(body).match(/<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["'][^>]*>/i);
        nextURL = nextMatch ? absoluteURL(nextMatch[1], `https://${domain}`) : "";
        guard += 1;
      }
      return pages;
    }

    return [];
  }

  function parseComicPageImages(html, domain) {
    const source = String(html || "");
    const urls = [];
    const seen = new Set();
    const push = (match) => {
      const url = match ? absoluteURL(attribute(match[0], "src"), `https://${domain}`) : "";
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    };
    const single = source.match(/<img\b[^>]*id=["']comicimage["'][^>]*>/i);
    if (single) {
      push(single);
      return urls;
    }
    // Game-style comics render several panels per page as comic_data_N images.
    for (const match of source.matchAll(/<img\b[^>]*id=["']comic_data_[0-9]+["'][^>]*>/gi)) {
      push(match);
    }
    return urls;
  }

  async function extractComicImage(page) {
    const url = String(page.url || "");
    if (!url) return [];
    const domain = new URL(url).hostname;
    const body = await fetchDirect(url, { maxBytesHint: 2 * 1024 * 1024 });
    return parseComicPageImages(body, domain);
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
    const profileHTML = await fetchDirect(profileUrl, { maxBytesHint: 2 * 1024 * 1024 });
    const domain = await resolveDomain(slug, profileHTML).catch(() => null);
    if (!domain) {
      throw new Error("Comic Fury could not resolve an external comic site for this profile.");
    }
    return parseDetailsHTML(profileHTML, slug, domain);
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
    for (const page of await chapterPages(chapter, domain)) {
      for (const url of await extractComicImage(page)) {
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
