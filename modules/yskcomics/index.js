"use strict";

(() => {
  const SITE_URL = "https://www.ysk-comics.com";
  const API_URL = "https://api.ysk-comics.com/api/v1";
  const DEFAULT_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "X-Localization": "en",
    Referer: `${SITE_URL}/en`,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    Referer: `${SITE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const CHAPTERS_PER_PAGE = 12;

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

  function stripHTML(value) {
    return String(value || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.body === "string" && response.body) return response.body;
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return "";
  }

  async function requestJSON(url) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("YSK Comics requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1000 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(url, DEFAULT_HEADERS, "GET", null, {
          followRedirects: true,
          maxBytesHint: 4 * 1024 * 1024,
          responseClass: "json",
        });
        const status = Number(response?.status || 0);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          const error = new Error(`YSK Comics request failed with HTTP ${status || "error"}.`);
          if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const body = await responseText(response);
        if (!body) throw new Error("YSK Comics returned an empty response.");
        try {
          return JSON.parse(body);
        } catch {
          throw new Error("YSK Comics returned invalid JSON.");
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_ATTEMPTS || !/network|timed?\s*out|connection|HTTP (?:429|5\d\d)/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("YSK Comics request failed.");
  }

  // Series identifiers are the API slugs (e.g. "moon-knight-2016").
  function seriesSlug(value) {
    const raw = nonEmpty(value);
    const match = raw.match(/ysk-comics\.com\/(?:en\/)?comic\/([^/?#]+)/i)
      || raw.match(/^\/?comic\/([^/?#]+)/i)
      || raw.match(/^([a-z0-9][a-z0-9-]*)$/i);
    if (!match) throw new Error("Invalid YSK Comics series identifier.");
    return match[1].toLowerCase();
  }

  function parseSearch(payload) {
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const items = [];
    const seen = new Set();
    for (const entry of entries) {
      const slug = nonEmpty(entry?.slug).toLowerCase();
      const title = nonEmpty(entry?.full_name);
      if (!slug || !title || seen.has(slug)) continue;
      seen.add(slug);
      items.push({
        id: slug,
        href: `${SITE_URL}/en/comic/${slug}`,
        title,
        image: nonEmpty(entry?.image),
      });
    }
    return items;
  }

  async function searchResults(query, page = 1) {
    const text = nonEmpty(typeof query === "string" ? query : query?.text || query?.query);
    if (text.startsWith("__feed:")) {
      // The catalogue API has no rails endpoint; series discovery comes from
      // search and the home page. An empty query feeds the whole catalogue.
      const payload = await requestJSON(`${API_URL}/search-comics-home?name=${encodeURIComponent(text === "__feed:popular" ? "*" : "a")}`);
      return { items: parseSearch(payload), hasMore: false };
    }
    const offset = (Math.max(1, Number(page) || 1) - 1) * 10;
    const payload = await requestJSON(`${API_URL}/search-comics-home?name=${encodeURIComponent(text)}&offset=${offset}`);
    return { items: parseSearch(payload), hasMore: false };
  }

  function comicSlugFromHTML(html) {
    const match = String(html || "").match(/"slug"\s*:\s*"([^"]+)"[^}]*?"chapters"/i);
    return match ? match[1] : "";
  }

  async function extractDetails(id) {
    const slug = seriesSlug(id);
    const payload = await requestJSON(`${API_URL}/comics/${encodeURIComponent(slug)}`);
    const data = payload?.data;
    if (!data || !nonEmpty(data.full_name)) throw new Error("YSK Comics details did not contain a title.");

    const authors = [];
    if (data.writer?.name) authors.push(nonEmpty(data.writer.name));
    for (const artist of Array.isArray(data.artists) ? data.artists : []) {
      const name = nonEmpty(artist?.name);
      if (name && !authors.includes(name)) authors.push(name);
    }
    const genres = (Array.isArray(data.genres) ? data.genres : [])
      .map((genre) => nonEmpty(typeof genre === "object" ? genre?.name : genre))
      .filter(Boolean);
    const parts = [];
    if (data.publisher?.name) parts.push(`Publisher: ${nonEmpty(data.publisher.name)}`);
    if (genres.length) parts.push(`Genres: ${genres.join(", ")}`);
    if (data.published_at) parts.push(`Published: ${nonEmpty(data.published_at)}`);
    const description = nonEmpty(stripHTML(data.description)) || parts.join("\n");

    return {
      id: slug,
      href: `${SITE_URL}/en/comic/${slug}`,
      url: `${SITE_URL}/en/comic/${slug}`,
      title: nonEmpty(data.full_name),
      description: [description, ...parts].filter(Boolean).join("\n\n"),
      image: nonEmpty(data.image),
      authors,
      author: authors.join(", "),
      genres,
      status: nonEmpty(data.status) || "Ongoing",
    };
  }

  async function fetchAllChapters(slug) {
    const chapters = [];
    const seen = new Set();
    let url = `${API_URL}/comics/${encodeURIComponent(slug)}/chapters`;
    let guard = 0;
    while (url && guard < 20) {
      guard += 1;
      const payload = await requestJSON(url);
      const data = payload?.data;
      const rows = Array.isArray(data?.data_messages) ? data.data_messages : [];
      let added = 0;
      for (const row of rows) {
        const chapterSlug = nonEmpty(row?.slug);
        if (!chapterSlug || seen.has(chapterSlug)) continue;
        seen.add(chapterSlug);
        const rank = Number(row?.rank);
        chapters.push({
          id: chapterSlug,
          href: chapterSlug,
          url: chapterSlug,
          title: nonEmpty(row?.name) || `Issue ${rank || ""}`.trim(),
          number: Number.isFinite(rank) ? rank : Number(chapterSlug.match(/(\d+)\s*$/)?.[1]),
          language: "en",
        });
        added += 1;
      }
      // A repeated or self-referencing link_next must not loop forever.
      const next = nonEmpty(data?.meta?.link_next) || "";
      url = added > 0 ? next : "";
    }
    return chapters;
  }

  async function extractChapters(id) {
    const slug = seriesSlug(id);
    const chapters = await fetchAllChapters(slug);
    return chapters;
  }

  async function extractImages(chapterId) {
    const slug = nonEmpty(chapterId).replace(/^.*\//, "");
    if (!/^[a-z0-9-]+$/i.test(slug)) {
      throw new Error("YSK Comics chapter identifier must be an issue slug.");
    }
    const payload = await requestJSON(`${API_URL}/chapters/${encodeURIComponent(slug)}/images`);
    const urls = Array.isArray(payload?.data) ? payload.data : [];
    const pages = urls
      .filter((url) => /^https:\/\/cdn\.ysk-comics\.com\//.test(nonEmpty(url)))
      .map((url) => ({ url: nonEmpty(url), headers: IMAGE_HEADERS }));
    if (!pages.length) throw new Error("YSK Comics chapter returned no readable page images.");
    return pages;
  }

  // The home page embeds discovery rails as schema.org JSON-LD:
  // @graph -> CollectionPage {name: "The Most Reading"|"Latest Comics",
  // hasPart: [ComicSeries...]}. Both feed rails are read from there.
  async function homeRails() {
    if (!homeRails.cache) {
      const html = await fetchDirectHTML(`${SITE_URL}/en`);
      const popular = [];
      const latest = [];
      const seen = new Set();
      const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = pattern.exec(html)) !== null) {
        let data = null;
        try {
          data = JSON.parse(match[1].trim());
        } catch {
          continue;
        }
        const nodes = Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
        for (const node of nodes) {
          if (node?.["@type"] !== "CollectionPage") continue;
          const railName = nonEmpty(node?.name);
          const rail = /latest/i.test(railName) ? latest : popular;
          const entries = Array.isArray(node?.hasPart) ? node.hasPart : [];
          for (const entry of entries) {
            const itemName = nonEmpty(entry?.name);
            const itemURL = nonEmpty(entry?.url || entry?.["@id"]);
            if (!itemName || !itemURL || !/\/comic\//.test(itemURL) || seen.has(itemURL)) continue;
            seen.add(itemURL);
            rail.push({ id: itemURL, href: itemURL, title: itemName, image: "" });
          }
        }
      }
      homeRails.cache = { popular: popular.slice(0, 20), latest: latest.slice(0, 20) };
    }
    return homeRails.cache;
  }

  async function discoveryHome() {
    const rails = await homeRails();
    const sections = [];
    if (rails.popular.length >= 3) {
      sections.push({ id: "most-reading", title: "The Most Reading", items: rails.popular });
    }
    if (rails.latest.length >= 3) {
      sections.push({ id: "latest-comics", title: "Latest Comics", items: rails.latest });
    }
    if (!sections.length) throw new Error("YSK Comics home page returned no discovery rails.");
    return { sections };
  }

  async function discoveryFeed(feedID, page = 1) {
    const rails = await homeRails();
    const items = String(feedID || "").toLowerCase() === "popular" ? rails.popular : rails.latest;
    return { items, hasMore: false };
  }

  async function fetchDirectHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("YSK Comics requires the fetchv2 bridge.");
    }
    const response = await globalThis.fetchv2(url, {
      Accept: "text/html,application/xhtml+xml",
      Referer: `${SITE_URL}/`,
    }, "GET", null, { followRedirects: true, maxBytesHint: 3 * 1024 * 1024 });
    const body = await responseText(response);
    if (!body) throw new Error("YSK Comics returned an empty page.");
    return body;
  }

  async function discoveryFeed(feedID, page = 1) {
    const offset = (Math.max(1, Number(page) || 1) - 1) * 10;
    const payload = await requestJSON(`${API_URL}/search-comics-home?name=${encodeURIComponent(String(feedID || ""))}&offset=${offset}`);
    return { items: parseSearch(payload), hasMore: false };
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
