"use strict";

(() => {
  const BASE_URL = "https://audioaz.com";
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_HTML_ATTEMPTS = 2;
  const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
  const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_CACHED_PAGES = 8;
  const SOURCE_HOSTS = new Set(["audioaz.com"]);
  const MEDIA_HOSTS = new Set(["archive.org", "api.spreaker.com", "darkerprojects.dreamhosters.com"]);
  const IMAGE_HOSTS = new Set(["audioaz.com", "f.audioaz.com"]);
  const pageCache = new Map();
  const pageLoads = new Map();
  const EXCLUDED_CONTENT = /18\+|\b(?:adult(?:s)?|mature|explicit|erotic(?:a)?|smut|nsfw|harem|yaoi|yuri|ecchi|sex(?:ual)?|porn(?:ography)?|xxx)\b/i;

  function text(value) { return String(value == null ? "" : value).trim(); }
  function decodeHTML(value) {
    return text(value).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
  }
  function stripHTML(value) { return decodeHTML(value).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(); }
  function safeURL(value, hosts) {
    if (!text(value)) return null;
    try {
      const url = new URL(decodeHTML(value), BASE_URL);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (![...hosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
      url.hash = "";
      return url.toString();
    } catch (_) { return null; }
  }
  function attribute(tag, name) { return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] || ""; }
  function responseBody(response) { if (response?.bodyDropped) throw new Error("AudioAZ response exceeded the module limit."); return typeof response?.body === "string" ? response.body : ""; }
  function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
  function shouldRetry(error) {
    const status = Number(error?.status || 0);
    if (RETRYABLE_HTTP.has(status)) return true;
    return !status && /(?:timeout|timed? out|network|connection|temporar)/i.test(String(error?.message || error));
  }
  async function requestHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("AudioAZ requires fetchv2.");
    let lastError;
    for (let attempt = 1; attempt <= MAX_HTML_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await globalThis.fetchv2(url, { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" }, "GET", null, { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass: "html" });
      } catch (error) {
        lastError = error;
        if (attempt < MAX_HTML_ATTEMPTS && shouldRetry(error)) { await wait(250 * attempt); continue; }
        throw error;
      }
      const status = Number(response?.status || 0);
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        const error = new Error(`AudioAZ request failed with HTTP ${status || "error"}.`);
        error.status = status;
        lastError = error;
        if (attempt < MAX_HTML_ATTEMPTS && shouldRetry(error)) { await wait(250 * attempt); continue; }
        throw error;
      }
      return responseBody(response);
    }
    throw lastError || new Error("AudioAZ request failed.");
  }
  function canonicalPage(value) {
    const url = safeURL(value, SOURCE_HOSTS);
    if (!url || !/^\/en\/(?:audiobook|archive)\/[^/]+\/?$/i.test(new URL(url).pathname)) throw new Error("Invalid AudioAZ audiobook page.");
    return url;
  }
  function trackID(pageURL, trackKey) { return `audioaz:track:${encodeURIComponent(canonicalPage(pageURL))}:${encodeURIComponent(String(trackKey))}`; }
  function trackReference(value) {
    const input = text(value);
    const current = input.match(/^audioaz:track:([^:]+):([^:]+)$/i);
    if (current) return { page: canonicalPage(decodeURIComponent(current[1])), key: decodeURIComponent(current[2]) };
    const legacy = input.match(/^audioaz:chapter:(.+)$/i);
    if (legacy) return { page: canonicalPage(decodeURIComponent(legacy[1])), key: "1" };
    throw new Error("Invalid AudioAZ chapter ID.");
  }
  function meta(html, key, attributeName = "content") {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(html || "").match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+${attributeName}=["']([^"']*)["']`, "i"))
      || String(html || "").match(new RegExp(`<meta[^>]+${attributeName}=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
    return match ? stripHTML(match[1]) : "";
  }
  function parseJSONLD(html) {
    const scripts = [...String(html || "").matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const script of scripts) {
      try {
        const parsed = JSON.parse(decodeHTML(script[1]));
        const values = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [])];
        const audiobook = values.find((value) => String(value?.["@type"] || "").toLowerCase().includes("audiobook"));
        if (audiobook) return audiobook;
      } catch (_) { /* Ignore unrelated JSON-LD blocks. */ }
    }
    return {};
  }
  function mediaSources(html) {
    const values = [];
    for (const block of [...String(html || "").matchAll(/<audio\b[^>]*>([\s\S]*?)<\/audio>/gi)]) {
      for (const source of [...block[1].matchAll(/<(?:source|a)\b([^>]*)>/gi)]) {
        const value = attribute(source[1] || "", "src") || attribute(source[1] || "", "href");
        const url = safeURL(value, MEDIA_HOSTS);
        if (url) values.push({ url, type: attribute(source[1] || "", "type") });
      }
    }
    const unique = [...new Map(values.map((value) => [value.url, value])).values()];
    return unique.sort((left, right) => {
      const rank = (value) => /\.mp3(?:\?|$)/i.test(value.url) ? 0 : /\.(?:m4a|m4b|mp4)(?:\?|$)/i.test(value.url) ? 1 : 2;
      return rank(left) - rank(right);
    });
  }
  function archiveMediaSources(html) {
    const values = mediaSources(html);
    const normalized = decodeHTML(String(html || "")).replace(/\\"/g, '"');
    const add = (value) => {
      const url = safeURL(value, MEDIA_HOSTS);
      if (url && !values.some((entry) => entry.url === url)) values.push({ url, type: "audio" });
    };
    for (const match of normalized.matchAll(/https?:\/\/archive\.org\/download\/([^"'\s<>()]+)\/([^"'\s<>()]+\.(?:mp3|m4a|m4b|mp4|opus))(?:[?#][^"'\s<>()]*)?/gi)) add(match[0]);
    for (const match of normalized.matchAll(/https?:\/\/archive\.org\/download\/([^"'\s<>()]+)\/([^"'\s<>()]+?)\.\]\(https?:\/\/archive\.org\/download\/\1\/\2\.\)(mp3|m4a|m4b|mp4|opus)/gi)) add(`https://archive.org/download/${match[1]}/${match[2]}.${match[3]}`);
    return values.sort((left, right) => {
      const rank = (value) => /\.mp3(?:\?|$)/i.test(value.url) ? 0 : /\.(?:m4a|m4b|mp4)(?:\?|$)/i.test(value.url) ? 1 : 2;
      return rank(left) - rank(right);
    });
  }
  function pageTitle(html, json) { return stripHTML(json?.name) || meta(html, "og:title") || stripHTML((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]) || "AudioAZ audiobook"; }
  function imageURL(html, json) { return safeURL(json?.image || meta(html, "og:image"), IMAGE_HOSTS); }
  function authors(json) {
    const author = json?.author;
    const values = Array.isArray(author) ? author : author ? [author] : [];
    return [...new Set(values.map((value) => stripHTML(value?.name || value)).filter(Boolean))];
  }
  function isAllowedLabels(title, genres = []) {
    return !EXCLUDED_CONTENT.test([title, ...genres].map(stripHTML).filter(Boolean).join(" "));
  }
  function embeddedTracks(html) {
    const normalized = String(html || "").replace(/\\"/g, '"');
    const output = [];
    const seen = new Set();
    const pattern = /"id":(\d+),"title":"([^"]*)","order":(\d+),"audio_url":"([^"]+)"/g;
    for (const match of normalized.matchAll(pattern)) {
      const url = safeURL(match[4], MEDIA_HOSTS);
      if (!url) continue;
      const key = `${match[1]}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ key: match[1], title: stripHTML(match[2]) || `Track ${match[3]}`, order: Number(match[3]), url });
    }
    return output.sort((left, right) => left.order - right.order);
  }
  function trackItems(html) {
    const embedded = embeddedTracks(html);
    if (embedded.length) return embedded;
    return archiveMediaSources(html).map((source, index) => ({ key: String(index + 1), title: `Track ${index + 1}`, order: index + 1, url: source.url }));
  }
  async function loadPage(value) {
    const page = canonicalPage(value);
    const now = Date.now();
    const cached = pageCache.get(page);
    if (cached && cached.expiresAt > now) {
      pageCache.delete(page);
      pageCache.set(page, cached);
      return cached.value;
    }
    if (cached) pageCache.delete(page);
    const pending = pageLoads.get(page);
    if (pending) return pending;
    const load = (async () => {
      const html = await requestHTML(page);
      const json = parseJSONLD(html);
      const title = pageTitle(html, json);
      const genres = Array.isArray(json?.genre) ? json.genre.map(stripHTML).filter(Boolean) : [];
      if (!isAllowedLabels(title, genres)) throw new Error("AudioAZ title is excluded by the content-safety filter.");
      const value = { page, html, json, title, genres, tracks: trackItems(html) };
      pageCache.set(page, { value, expiresAt: Date.now() + PAGE_CACHE_TTL_MS });
      while (pageCache.size > MAX_CACHED_PAGES) pageCache.delete(pageCache.keys().next().value);
      return value;
    })();
    pageLoads.set(page, load);
    try { return await load; }
    finally { pageLoads.delete(page); }
  }
  function archiveItems(html) {
    const output = []; const seen = new Set();
    for (const match of [...String(html || "").matchAll(/<a\b([^>]*href=["'][^"']*\/en\/(?:audiobook|archive)\/[^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi)]) {
      const open = match[1] || "";
      const url = safeURL(attribute(open, "href"), SOURCE_HOSTS);
      if (!url || seen.has(url)) continue;
      const inner = match[2] || "";
      const image = safeURL(attribute((/<img\b([^>]*)>/i.exec(inner) || [])[1] || "", "src") || attribute((/<img\b([^>]*)>/i.exec(inner) || [])[1] || "", "data-src"), IMAGE_HOSTS);
      const imageTag = (/<img\b([^>]*)>/i.exec(inner) || [])[1] || "";
      const title = stripHTML(attribute(open, "title") || attribute(open, "aria-label") || inner) || attribute(imageTag, "alt") || new URL(url).pathname.split("/").pop();
      if (!isAllowedLabels(title)) continue;
      seen.add(url); output.push({ id: url, href: url, url, title, image, description: "", author: "", genres: [] });
    }
    return output;
  }
  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const value = typeof query === "string" ? query.trim() : "";
    const isFeed = !value || value.startsWith("__feed:");
    const url = new URL(isFeed ? `${BASE_URL}/en/browse` : `${BASE_URL}/en/search`);
    if (!isFeed) url.searchParams.set("q", value.slice(0, 120));
    url.searchParams.set("page", String(requestedPage));
    if (isFeed) url.searchParams.set("sort", value.toLowerCase() === "__feed:latest" ? "recent" : "popular");
    const html = await requestHTML(url.toString());
    const items = archiveItems(html);
    const paginationHTML = decodeHTML(html);
    const paginationHasNext = new RegExp(`(?:[?&]page=|/page/)${requestedPage + 1}(?:[&#/"']|\\b)`, "i").test(paginationHTML);
    const hasNext = /(?:[?&]page=|\/page\/)["'][^>]*>\s*(?:Next|›|»)/i.test(html) || new RegExp(`[?&]page=${requestedPage + 1}(?:&|["'])`, "i").test(html);
    return { items, hasMore: hasNext || paginationHasNext };
  }
  async function extractDetails(id) {
    const loaded = await loadPage(id); const authorsList = authors(loaded.json);
    return { id: loaded.page, href: loaded.page, url: loaded.page, title: loaded.title, image: imageURL(loaded.html, loaded.json), description: stripHTML(loaded.json?.description) || meta(loaded.html, "description"), author: authorsList.join(", "), authors: authorsList, genres: loaded.genres, chapterCount: loaded.tracks.length, status: "Completed" };
  }
  async function extractChapters(id) {
    const loaded = await loadPage(id);
    if (!loaded.tracks.length) throw new Error("AudioAZ audiobook has no direct public audio source.");
    return loaded.tracks.map((track) => ({ id: trackID(loaded.page, track.key), href: loaded.page, url: trackID(loaded.page, track.key), title: track.title, number: track.order, language: text(loaded.json?.inLanguage) || "en" }));
  }
  async function extractAudio(id) {
    const reference = trackReference(id); const loaded = await loadPage(reference.page);
    const track = loaded.tracks.find((candidate) => candidate.key === reference.key) || loaded.tracks.find((candidate) => String(candidate.order) === reference.key);
    if (!track) throw new Error("AudioAZ audiobook track was not found.");
    const extension = /\.(m4a|m4b|mp4|opus)(?:\?|$)/i.exec(track.url)?.[1]?.toLowerCase() || "mp3";
    return { tracks: [{ id, title: track.title || loaded.title, url: track.url, format: extension === "mp4" ? "m4a" : extension, fileName: `audioaz-${encodeURIComponent(new URL(loaded.page).pathname.split("/").pop())}-${track.order}.${extension}`, part: track.order, track: track.order, language: text(loaded.json?.inLanguage) || "en" }] };
  }
  async function discoveryHome() { const feed = await searchResults("__feed:popular", 1); return { sections: [{ id: "popular", title: "Popular audiobooks", items: feed.items }] }; }
  async function discoveryFeed(feedID, page = 1) { const feed = String(feedID || "popular").toLowerCase(); if (!["popular", "latest", "catalogue"].includes(feed)) throw new Error("AudioAZ feed is not supported."); return searchResults(`__feed:${feed}`, page); }
  const handlers = { searchResults, extractDetails, extractChapters, extractAudio, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers; Object.assign(globalThis, handlers);
})();
