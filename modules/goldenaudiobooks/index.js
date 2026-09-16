"use strict";

(() => {
  const BASE_URL = "https://goldenaudiobooks.com";
  const API_URL = `${BASE_URL}/wp-json/wp/v2`;
  const PAGE_SIZE = 20;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const SOURCE_HOSTS = new Set(["goldenaudiobooks.com"]);
  const MEDIA_HOSTS = new Set(["goldenaudiobooks.com", "ipaudio.club"]);
  const EXCLUDED_CONTENT = /18\+|\b(?:adult(?:s)?|mature|explicit|erotic(?:a)?|smut|nsfw|harem|yaoi|yuri|ecchi)\b/i;

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function decodeHTML(value) {
    return text(value)
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
  }

  function stripHTML(value) {
    return decodeHTML(value)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function safeURL(value, hosts) {
    if (!text(value)) return null;
    try {
      const url = new URL(decodeHTML(value), BASE_URL);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if (![...hosts].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
      url.hash = "";
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  function mediaURL(value) {
    if (!text(value)) return null;
    const url = safeURL(value, MEDIA_HOSTS);
    if (!url) return null;
    const normalized = new URL(url);
    if (normalized.hostname === "ipaudio.club" || normalized.hostname.endsWith(".ipaudio.club")) {
      normalized.searchParams.delete("_");
    }
    return normalized.toString();
  }

  function attribute(tag, name) {
    const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
    return pattern.exec(tag)?.[1] || "";
  }

  function responseBody(response) {
    if (response?.bodyDropped) throw new Error("Goldenaudiobooks response exceeded the module limit.");
    return typeof response?.body === "string" ? response.body : "";
  }

  async function request(url, responseClass) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Goldenaudiobooks requires fetchv2.");
    const response = await globalThis.fetchv2(
      url,
      { Accept: responseClass === "json" ? "application/json" : "text/html", "Accept-Language": "en-US,en;q=0.9" },
      "GET",
      null,
      { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass },
    );
    const status = Number(response?.status || 0);
    if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`Goldenaudiobooks request failed with HTTP ${status || "error"}.`);
    }
    return responseBody(response);
  }

  async function requestJSON(url) {
    const body = await request(url, "json");
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error("Goldenaudiobooks returned invalid JSON.");
    }
  }

  function idForPost(id) {
    const value = Number(id);
    if (!Number.isInteger(value) || value < 1 || value > 999999999) throw new Error("Invalid Goldenaudiobooks post ID.");
    return `goldenaudiobooks:post:${value}`;
  }

  function postNumber(value) {
    const raw = text(value);
    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 999999999) return numeric;
    }
    const match = raw.match(/^goldenaudiobooks:post:(\d+)$/i) || raw.match(/\/wp-json\/wp\/v2\/posts\/(\d+)/i);
    if (!match || Number(match[1]) < 1) throw new Error("Invalid Goldenaudiobooks title ID.");
    return Number(match[1]);
  }

  function trackID(postID, number) {
    return `goldenaudiobooks:track:${postNumber(postID)}:${number}`;
  }

  function trackReference(value) {
    const match = text(value).match(/^goldenaudiobooks:track:(\d+):(\d+)$/i);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error("Invalid Goldenaudiobooks chapter ID.");
    return { postID: Number(match[1]), number: Number(match[2]) };
  }

  function termsFor(post) {
    const terms = post?._embedded?.["wp:term"] || [];
    return [...new Set(terms.flat().map((term) => stripHTML(term?.name)).filter(Boolean))];
  }

  function isAllowedPost(post) {
    const labels = [stripHTML(post?.title?.rendered), ...termsFor(post)].filter(Boolean).join(" ");
    return !EXCLUDED_CONTENT.test(labels);
  }

  function imageFor(post) {
    return safeURL(post?._embedded?.["wp:featuredmedia"]?.[0]?.source_url, SOURCE_HOSTS);
  }

  function itemFor(post) {
    const postID = post?.id;
    if (!Number.isInteger(Number(postID)) || Number(postID) < 1) return null;
    if (!isAllowedPost(post)) return null;
    const title = stripHTML(post?.title?.rendered) || `Goldenaudiobooks ${postID}`;
    const url = safeURL(post?.link, SOURCE_HOSTS);
    if (!url) return null;
    return {
      id: idForPost(postID),
      href: url,
      url,
      title,
      image: imageFor(post),
      description: stripHTML(post?.excerpt?.rendered || ""),
      author: "",
      genres: termsFor(post),
    };
  }

  function header(response, name) {
    if (typeof response?.headers?.get === "function") return response.headers.get(name);
    const key = Object.keys(response?.headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? response.headers[key] : "";
  }

  async function searchResults(query, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    const value = typeof query === "string" ? query.trim() : "";
    const url = new URL(`${API_URL}/posts`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(requestedPage));
    url.searchParams.set("_embed", "1");
    url.searchParams.set("orderby", "date");
    url.searchParams.set("order", "desc");
    if (value && !value.startsWith("__feed:")) url.searchParams.set("search", value.slice(0, 120));
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Goldenaudiobooks requires fetchv2.");
    const response = await globalThis.fetchv2(
      url.toString(),
      { Accept: "application/json", "Accept-Language": "en-US,en;q=0.9" },
      "GET",
      null,
      { followRedirects: true, maxBytesHint: MAX_RESPONSE_BYTES, responseClass: "json" },
    );
    const status = Number(response?.status || 0);
    if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
      throw new Error(`Goldenaudiobooks search failed with HTTP ${status || "error"}.`);
    }
    let payload;
    try { payload = JSON.parse(responseBody(response)); } catch (_) { throw new Error("Goldenaudiobooks search returned invalid JSON."); }
    const items = (Array.isArray(payload) ? payload : []).map(itemFor).filter(Boolean);
    const totalPages = Number(header(response, "x-wp-totalpages"));
    return { items, hasMore: Number.isFinite(totalPages) ? requestedPage < totalPages : items.length === PAGE_SIZE };
  }

  async function fetchPost(postID) {
    const post = await requestJSON(`${API_URL}/posts/${postNumber(postID)}?_embed=1`);
    if (!post || !post.id) throw new Error("Goldenaudiobooks title was not found.");
    if (!isAllowedPost(post)) throw new Error("Goldenaudiobooks title is excluded by the content-safety filter.");
    return post;
  }

  function tracksFromHTML(html, postID) {
    const output = [];
    const seen = new Set();
    const audioBlocks = [...String(html || "").matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi)];
    for (let index = 0; index < audioBlocks.length; index += 1) {
      const open = audioBlocks[index][1] || "";
      const inner = audioBlocks[index][2] || "";
      const mediaTags = [...inner.matchAll(/<(?:source|a)\b([^>]*)>/gi)].map((match) => match[1] || "");
      const source = mediaTags
        .map((tag) => mediaURL(attribute(tag, "href")))
        .find(Boolean)
        || mediaTags.map((tag) => mediaURL(attribute(tag, "src"))).find(Boolean);
      if (!source || seen.has(source)) continue;
      const audioID = attribute(open, "id");
      const numberMatch = audioID.match(/-(\d+)$/);
      const number = numberMatch ? Number(numberMatch[1]) : index + 1;
      if (!Number.isInteger(number) || number < 1) continue;
      seen.add(source);
      output.push({ number, url: source, title: `Track ${number}`, id: trackID(postID, number) });
    }
    return output.sort((left, right) => left.number - right.number);
  }

  function detailsFor(post, tracks) {
    const item = itemFor(post);
    const author = post?._embedded?.author?.[0]?.name ? stripHTML(post._embedded.author[0].name) : "";
    return {
      ...item,
      authors: author ? [author] : [],
      author,
      status: "Unknown",
      chapterCount: tracks.length,
      genres: termsFor(post),
    };
  }

  async function extractDetails(id) {
    const post = await fetchPost(id);
    const tracks = tracksFromHTML(post.content?.rendered, post.id);
    return detailsFor(post, tracks);
  }

  async function extractChapters(id) {
    const post = await fetchPost(id);
    const tracks = tracksFromHTML(post.content?.rendered, post.id);
    if (!tracks.length) throw new Error("Goldenaudiobooks returned no playable public audio tracks.");
    return tracks.map((track) => ({
      id: track.id,
      href: safeURL(post.link, SOURCE_HOSTS),
      url: track.id,
      title: track.title,
      number: track.number,
    }));
  }

  async function extractAudio(id) {
    const reference = trackReference(id);
    const post = await fetchPost(reference.postID);
    const tracks = tracksFromHTML(post.content?.rendered, post.id);
    const track = tracks.find((candidate) => candidate.number === reference.number);
    if (!track) throw new Error("Goldenaudiobooks chapter was not found.");
    return {
      tracks: [{
        id: track.id,
        title: track.title,
        url: track.url,
        format: "mp3",
        fileName: `goldenaudiobooks-${reference.postID}-${reference.number}.mp3`,
        part: reference.number,
        track: reference.number,
        language: "en",
      }],
    };
  }

  async function discoveryHome() {
    const feed = await searchResults("__feed:latest", 1);
    return { sections: [{ id: "latest", title: "Latest audiobooks", items: feed.items }] };
  }

  async function discoveryFeed(feedID, page = 1) {
    if (!["latest", "popular", "catalogue"].includes(String(feedID || "latest").toLowerCase())) {
      throw new Error("Goldenaudiobooks feed is not supported.");
    }
    return searchResults("__feed:latest", page);
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractAudio, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
