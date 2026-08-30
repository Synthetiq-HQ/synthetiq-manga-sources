"use strict";

(() => {
  const BASE_URL = "https://mangaball.net";
  const HOME_URL = `${BASE_URL}/`;
  const SOURCE_HOST = "mangaball.net";
  const IMAGE_HOST_SUFFIXES = [
    ".poke-black-and-white.net",
    ".red-and-blue.net",
  ];
  const FIXED_IMAGE_HOSTS = new Set(["dmd-image-content-sng-1.imggo.net"]);
  const SEARCH_ENDPOINT = `${BASE_URL}/api/v1/smart-search/search/`;
  const TITLE_SEARCH_ENDPOINT = `${BASE_URL}/api/v1/title/search/`;
  const CHAPTER_ENDPOINT = `${BASE_URL}/api/v1/chapter/chapter-listing-by-title-id/`;
  const DISCOVERY_LIMIT = 24;
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: HOME_URL,
    "User-Agent": USER_AGENT,
  };
  const API_HEADERS = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: BASE_URL,
    "X-Requested-With": "XMLHttpRequest",
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: HOME_URL,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  const MAX_API_BYTES = 16 * 1024 * 1024;
  let homePagePromise = null;
  const discoveryCache = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function nonEmpty(value) {
    const text = String(value ?? "").trim();
    return text || "";
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
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const quoted = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
    );
    if (quoted) return decodeEntities(quoted[2].trim());
    const unquoted = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
    return unquoted ? decodeEntities(unquoted[1].trim()) : "";
  }

  function metaContent(html, key) {
    const pattern = /<meta\b[^>]*>/gi;
    for (const match of String(html || "").matchAll(pattern)) {
      const tag = match[0];
      if (attribute(tag, "name").toLowerCase() !== key.toLowerCase()
        && attribute(tag, "property").toLowerCase() !== key.toLowerCase()) continue;
      return attribute(tag, "content");
    }
    return "";
  }

  function absoluteURL(value, base = BASE_URL) {
    const input = nonEmpty(value);
    if (!input) return "";
    try {
      const url = new URL(input, base);
      if (url.protocol === "http:") url.protocol = "https:";
      return url.toString().split("#")[0];
    } catch (_) {
      return "";
    }
  }

  function siteURL(value, kind) {
    const candidate = absoluteURL(value, BASE_URL);
    if (!candidate) return "";
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      return "";
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== SOURCE_HOST) return "";
    const path = parsed.pathname.replace(/\/{2,}/g, "/");
    const pattern = kind === "title"
      ? /^\/title-detail\/.+-[a-z0-9]{16,64}\/?$/i
      : /^\/chapter-detail\/[a-z0-9]{16,64}\/?$/i;
    if (!pattern.test(path)) return "";
    return `${BASE_URL}${path.endsWith("/") ? path : `${path}/`}`;
  }

  function titleParts(value) {
    const url = siteURL(value, "title");
    if (!url) throw new Error("Invalid MangaBall title identifier.");
    const path = new URL(url).pathname;
    const match = path.match(/^\/title-detail\/.+-([a-z0-9]{16,64})\/?$/i);
    if (!match) throw new Error("Invalid MangaBall title identifier.");
    return { id: match[1], url };
  }

  function chapterParts(value) {
    const url = siteURL(value, "chapter");
    if (!url) throw new Error("Invalid MangaBall chapter identifier.");
    const match = new URL(url).pathname.match(/^\/chapter-detail\/([a-z0-9]{16,64})\/?$/i);
    if (!match) throw new Error("Invalid MangaBall chapter identifier.");
    return { id: match[1], url };
  }

  function imageURL(value, allowCover = false) {
    const candidate = absoluteURL(value, BASE_URL);
    if (!candidate) return "";
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      return "";
    }
    const host = parsed.hostname.toLowerCase();
    if (!FIXED_IMAGE_HOSTS.has(host) && !IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "";
    const path = parsed.pathname;
    const allowedPath = allowCover
      ? path.startsWith("/covers/")
      : path.startsWith("/storage/") || (FIXED_IMAGE_HOSTS.has(host) && path.startsWith("/books/"));
    if (!allowedPath || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(path)) return "";
    return parsed.toString().split("#")[0];
  }

  function isChallengePage(body) {
    return /cf-chl-|just a moment|verify you are human|access denied/i.test(String(body || ""));
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  const sessionCookies = new Map();

  function headerValue(headers, name) {
    if (!headers || typeof headers !== "object") return "";
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : "";
    return Array.isArray(value) ? value.join(", ") : String(value || "");
  }

  function captureSessionCookies(response, requestURL) {
    let host = "";
    try {
      host = new URL(requestURL).hostname.toLowerCase();
    } catch (_) {
      return;
    }
    if (host !== SOURCE_HOST) return;
    const setCookie = headerValue(response && response.headers, "set-cookie");
    const match = setCookie.match(/(?:^|,\s*)PHPSESSID=([^;,\s]+)/i);
    if (!match) return;
    if (/max-age\s*=\s*0/i.test(setCookie)) sessionCookies.delete("PHPSESSID");
    else sessionCookies.set("PHPSESSID", match[1]);
  }

  function sessionCookieHeader(requestURL) {
    if (!sessionCookies.size) return "";
    try {
      if (new URL(requestURL).hostname.toLowerCase() !== SOURCE_HOST) return "";
    } catch (_) {
      return "";
    }
    return [...sessionCookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function request(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("MangaBall requires the fetchv2 bridge.");
    }
    const method = options.method || "GET";
    const maxBytesHint = options.maxBytesHint || MAX_HTML_BYTES;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1000 * (attempt - 1));
      try {
        const requestHeaders = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
        if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === "cookie")) {
          const cookie = sessionCookieHeader(url);
          if (cookie) requestHeaders.Cookie = cookie;
        }
        const response = await globalThis.fetchv2(
          url,
          requestHeaders,
          method,
          options.body || null,
          {
            followRedirects: true,
            maxBytesHint,
            responseClass: options.responseClass || "html",
          },
        );
        captureSessionCookies(response, url);
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          lastError = new Error(`MangaBall request failed with HTTP ${status || "error"}.`);
          if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) continue;
          throw lastError;
        }
        if (response.bodyDropped) {
          throw new Error(`MangaBall response exceeded the ${Math.round(maxBytesHint / 1024 / 1024)} MB safety limit.`);
        }
        const body = await responseText(response);
        if (!body.trim()) throw new Error("MangaBall returned an empty response.");
        return { body, finalUrl: response.finalUrl || url };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_ATTEMPTS || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("MangaBall request failed.");
  }

  async function fetchHTML(url, options = {}) {
    const result = await request(url, {
      ...options,
      responseClass: "html",
      maxBytesHint: options.maxBytesHint || MAX_HTML_BYTES,
    });
    if (isChallengePage(result.body)) {
      throw new Error("MangaBall returned a challenge or access-denied page.");
    }
    return result;
  }

  async function postJSON(url, body, csrfToken, referer) {
    const result = await request(url, {
      method: "POST",
      headers: {
        ...API_HEADERS,
        Referer: referer || HOME_URL,
        "X-CSRF-TOKEN": csrfToken,
      },
      body,
      responseClass: "json",
      maxBytesHint: MAX_API_BYTES,
    });
    try {
      return JSON.parse(result.body);
    } catch (_) {
      throw new Error("MangaBall returned invalid JSON.");
    }
  }

  function formEncode(values) {
    return Object.entries(values)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
  }

  function csrfToken(html) {
    const token = metaContent(html, "csrf-token");
    if (!token) throw new Error("MangaBall page did not include a CSRF token.");
    return token;
  }

  async function homePage() {
    if (!homePagePromise) {
      homePagePromise = fetchHTML(HOME_URL).catch((error) => {
        homePagePromise = null;
        throw error;
      });
    }
    return homePagePromise;
  }

  function payloadEntries(payload) {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.manga)) return payload.data.manga;
    if (Array.isArray(payload?.manga)) return payload.manga;
    return [];
  }

  function parseSearchPayload(payload) {
    const items = payloadEntries(payload);
    const output = [];
    const seen = new Set();
    for (const item of items) {
      const href = siteURL(item && (item.url || item.href), "title");
      const title = stripHTML(item && (item.title || item.name));
      if (!href || !title || seen.has(href)) continue;
      seen.add(href);
      const image = imageURL(item && (item.img || item.image || item.cover), true);
      const status = stripHTML(item && item.status);
      output.push({
        id: href,
        href,
        url: href,
        title,
        ...(image ? { image } : {}),
        ...(status ? { status } : {}),
      });
    }
    return output;
  }

  function queryText(query) {
    if (query && typeof query === "object" && !Array.isArray(query)) {
      return nonEmpty(query.text || query.query || query.search || "");
    }
    return nonEmpty(query);
  }

  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (requestedPage !== 1) return { items: [], hasMore: false };
    const text = queryText(query);
    if (!text) return { items: [], hasMore: false };
    if (text === "__feed:popular") return discoveryFeed("popular", requestedPage);
    if (text === "__feed:latest") return discoveryFeed("latest", requestedPage);

    const home = await homePage();
    const payload = await postJSON(
      SEARCH_ENDPOINT,
      formEncode({ search_input: text }),
      csrfToken(home.body),
      home.finalUrl || HOME_URL,
    );
    const items = parseSearchPayload(payload);
    return { items, hasMore: false };
  }

  function discoveryType(feedID) {
    return /latest|recent|new/i.test(String(feedID || "")) ? "latest" : "popular";
  }

  async function discoveryItems(feedID) {
    const type = discoveryType(feedID);
    if (discoveryCache.has(type)) return discoveryCache.get(type);

    const home = await homePage();
    const payload = await postJSON(
      TITLE_SEARCH_ENDPOINT,
      formEncode({
        search_type: type === "latest" ? "getLatestTable" : "getRecommend",
        search_limit: DISCOVERY_LIMIT,
      }),
      csrfToken(home.body),
      home.finalUrl || HOME_URL,
    );
    const items = parseSearchPayload(payload);
    if (!items.length) throw new Error(`MangaBall ${type} discovery feed returned no titles.`);
    discoveryCache.set(type, items);
    return items;
  }

  async function discoveryHome() {
    const sections = [];
    const popular = await discoveryItems("popular");
    if (popular.length) sections.push({ id: "recommended", title: "Titles Recommended", items: popular });
    const latest = await discoveryItems("latest");
    if (latest.length) sections.push({ id: "latest-updates", title: "Latest Updates", items: latest });
    if (!sections.length) throw new Error("MangaBall home page returned no discovery feeds.");
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    if (requestedPage !== 1) return { items: [], hasMore: false };
    return { items: await discoveryItems(feedID), hasMore: false };
  }

  function valuesFromDataAttribute(html, attributeName) {
    const output = [];
    const pattern = new RegExp(
      `<span\\b[^>]*${attributeName}\\s*=\\s*(["'])[^"']+\\1[^>]*>([\\s\\S]*?)<\\/span>`,
      "gi",
    );
    for (const match of String(html || "").matchAll(pattern)) {
      const value = stripHTML(match[2]);
      if (value && !output.includes(value)) output.push(value);
    }
    return output;
  }

  function parseDetailsHTML(html, id, url) {
    const detailStart = String(html || "").indexOf('id="comicDetail"');
    const descriptionStart = String(html || "").indexOf('id="comicDescription"');
    const detailBlock = detailStart >= 0
      ? String(html).slice(detailStart, descriptionStart > detailStart ? descriptionStart : detailStart + 40_000)
      : String(html || "");
    const heading = detailBlock.match(/<h6\b[^>]*class=["'][^"']*text-center[^"']*["'][^>]*>([\s\S]*?)<\/h6>/i);
    const jsonLDName = String(html || "").match(/"name"\s*:\s*"([^"]+?)\s+-\s+Manga Ball"/i);
    const title = stripHTML(heading?.[1] || jsonLDName?.[1] || "");
    if (!title) throw new Error("MangaBall title page did not contain a title.");

    const descriptionContentStart = String(html || "").indexOf('id="descriptionContent"');
    const descriptionBlock = descriptionContentStart >= 0
      ? String(html).slice(descriptionContentStart, descriptionContentStart + 40_000)
      : "";
    const description = stripHTML((descriptionBlock.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "");
    const cover = imageURL(metaContent(html, "og:image"), true)
      || imageURL((detailBlock.match(/<img\b[^>]*class=["'][^"']*featured-cover[^"']*["'][^>]*>/i) || [])[0] && attribute(
        (detailBlock.match(/<img\b[^>]*class=["'][^"']*featured-cover[^"']*["'][^>]*>/i) || [])[0],
        "src",
      ), true);
    const statusMatch = detailBlock.match(/<span\b[^>]*class=["'][^"']*status-([a-z-]+)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const statusFromClass = statusMatch?.[1]
      ? statusMatch[1].replace(/-title$/i, "").replace(/-/g, " ")
      : "";
    const status = stripHTML(statusMatch?.[2] || "")
      || (statusFromClass ? statusFromClass.charAt(0).toUpperCase() + statusFromClass.slice(1) : "Unknown");
    const published = (detailBlock.match(/Published:\s*<b[^>]*>([^<]+)<\/b>/i) || [])[1];
    const authors = valuesFromDataAttribute(detailBlock, "data-person-id");
    const genres = valuesFromDataAttribute(detailBlock, "data-tag-id");
    return {
      id,
      href: url,
      url,
      title,
      description,
      image: cover,
      authors,
      author: authors.join(", "),
      genres,
      status,
      ...(nonEmpty(published) ? { published: nonEmpty(published) } : {}),
    };
  }

  async function extractDetails(value) {
    const title = titleParts(value);
    const page = await fetchHTML(title.url);
    return parseDetailsHTML(page.body, title.url, title.url);
  }

  function chapterLabel(group, translation, number) {
    const base = stripHTML(translation && (translation.name || translation.title))
      || stripHTML(group && (group.number || group.title))
      || (number == null ? "Chapter" : `Chapter ${number}`);
    const language = stripHTML(translation && (translation.languageName || translation.language));
    const groupName = stripHTML(translation && translation.group && (translation.group.name || translation.group._id));
    const qualifiers = [language, groupName].filter(Boolean);
    return qualifiers.length ? `${base} — ${qualifiers.join(" · ")}` : base;
  }

  function parseChaptersPayload(payload) {
    const groups = payload && Array.isArray(payload.ALL_CHAPTERS) ? payload.ALL_CHAPTERS : null;
    if (!groups) throw new Error("MangaBall did not return a chapter list.");
    const output = [];
    const seen = new Set();
    for (const group of groups) {
      const rawNumber = nonEmpty(group && group.number_float);
      const parsedNumber = rawNumber ? Number(rawNumber) : NaN;
      const number = Number.isFinite(parsedNumber) ? parsedNumber : null;
      const translations = Array.isArray(group && group.translations) ? group.translations : [];
      for (const translation of translations) {
        const chapterID = nonEmpty(translation && translation.id);
        if (!chapterID) continue;
        const chapterURL = siteURL(
          translation && (translation.url || translation.href),
          "chapter",
        ) || siteURL(`/chapter-detail/${chapterID}/`, "chapter");
        if (!chapterURL || seen.has(chapterURL)) continue;
        seen.add(chapterURL);
        const language = nonEmpty(translation && translation.language).toLowerCase();
        const releaseDate = nonEmpty(translation && (translation.date || translation.createdAt));
        output.push({
          id: chapterURL,
          href: chapterURL,
          url: chapterURL,
          title: chapterLabel(group, translation, number),
          number,
          ...(releaseDate ? { releaseDate } : {}),
          ...(language ? { language } : {}),
        });
      }
    }
    return output;
  }

  async function extractChapters(value) {
    const title = titleParts(value);
    const page = await fetchHTML(title.url);
    const payload = await postJSON(
      CHAPTER_ENDPOINT,
      formEncode({ title_id: title.id, userSettingsEnabled: false }),
      csrfToken(page.body),
      page.finalUrl || title.url,
    );
    if (payload && payload.code != null && Number(payload.code) !== 200) {
      throw new Error(`MangaBall chapter API failed: ${nonEmpty(payload.message) || payload.code}.`);
    }
    return parseChaptersPayload(payload);
  }

  function parseChapterImages(html) {
    const source = String(html || "");
    const embedded = source.match(/chapterImages\s*=\s*JSON\.parse\(\s*`([\s\S]*?)`\s*\)/i);
    let candidates = [];
    if (embedded) {
      try {
        candidates = JSON.parse(embedded[1]);
      } catch (_) {
        throw new Error("MangaBall chapter image data could not be decoded.");
      }
    } else {
      const arrayMatch = source.match(/chapterImages\s*=\s*(\[[\s\S]*?\])\s*;/i);
      if (arrayMatch) {
        try {
          candidates = JSON.parse(arrayMatch[1]);
        } catch (_) {
          throw new Error("MangaBall chapter image data could not be decoded.");
        }
      }
    }
    if (!Array.isArray(candidates) || !candidates.length) {
      const pattern = /<img\b[^>]*data-src=["']([^"']+)["'][^>]*>/gi;
      candidates = Array.from(source.matchAll(pattern), (match) => match[1]);
    }
    const output = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const url = imageURL(decodeEntities(candidate), false);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      output.push({ url, headers: IMAGE_HEADERS });
    }
    if (!output.length) throw new Error("MangaBall chapter did not contain readable page images.");
    return output;
  }

  async function extractImages(value) {
    const chapter = chapterParts(value);
    const page = await fetchHTML(chapter.url, { headers: { Referer: chapter.url } });
    return parseChapterImages(page.body);
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    discoveryHome,
    discoveryFeed,
  };
  Object.assign(globalThis, handlers);
  globalThis.SynthetiqModule = handlers;
})();
