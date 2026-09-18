"use strict";

(() => {
  const BASE = "https://chikari.moe";
  const TYPES = ["manga", "manhwa", "manhua"];
  const HEADERS = { Accept: "application/json", Referer: BASE + "/" };

  function identity(value, chapter = false) {
    let path = String(value || "").trim();
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.hostname !== "chikari.moe" || url.username || url.password || url.port) {
        throw new Error("Invalid Chikari source URL.");
      }
      path = url.pathname;
    }
    path = path.replace(/^\/?series\//, "").replace(/\/$/, "");
    const pattern = chapter ? /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+(?:\.\d+)?)$/ : /^([a-z0-9]+(?:-[a-z0-9]+)*)$/;
    const match = path.match(pattern);
    if (!match) throw new Error("Invalid Chikari " + (chapter ? "chapter" : "series") + " identity.");
    return { slug: match[1], number: chapter ? Number(match[2]) : null };
  }

  function mediaURL(value) {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "cdn.chikari.moe" || url.port || url.username || url.password) {
      throw new Error("Chikari returned an unsupported image host.");
    }
    return url.href;
  }

  async function request(path) {
    const response = await fetchv2(BASE + "/api/" + path, HEADERS, "GET", null,
      { followRedirects: true, maxBytesHint: 4194304, responseClass: "json" });
    if (!response || response.status < 200 || response.status >= 300 || response.ok === false) {
      throw new Error("Chikari request failed (HTTP " + (response && response.status || "network") + "). Try again later.");
    }
    if (response.bodyDropped) throw new Error("Chikari response exceeded the supported size.");
    const body = typeof response.body === "string" ? response.body : await response.text();
    let data;
    try { data = JSON.parse(body); } catch (_) { throw new Error("Chikari returned an invalid response or verification page."); }
    if (!data || typeof data !== "object" || data.error) throw new Error("Chikari returned an API error.");
    return data;
  }

  function listing(data) {
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0) {
      throw new Error("Chikari returned an invalid listing.");
    }
    return data.items;
  }

  function supported(item) {
    return item && item.is_nsfw === false && TYPES.includes(item.type);
  }

  function card(item) {
    const slug = identity(item.slug).slug;
    if (typeof item.title !== "string" || !item.title.trim()) throw new Error("Chikari returned a title without a name.");
    const url = BASE + "/series/" + slug;
    return { id: url, href: url, url, title: item.title.trim(), image: mediaURL(item.cover_url),
      status: item.status === "finished" || item.status === "completed" ? "Completed" : item.status === "releasing" ? "Ongoing" : item.status };
  }

  async function feed(query, page, sort) {
    const p = Number(page == null ? 1 : page);
    if (!Number.isSafeInteger(p) || p < 1) throw new Error("Invalid Chikari page number.");
    const offset = (p - 1) * 36;
    const data = await request("series?adult=false&type=manga&type=manhwa&type=manhua&limit=36&offset=" + offset
      + "&sort=" + sort + "&q=" + encodeURIComponent(String(query || "").trim()));
    const rows = listing(data);
    if (!rows.length && offset < data.total) throw new Error("Chikari returned an incomplete listing.");
    return { items: rows.filter(supported).map(card), hasMore: offset + rows.length < data.total };
  }

  async function searchResults(query, page = 1) { return feed(query, page, "popular"); }

  async function detailsData(id) {
    const slug = identity(id).slug;
    const data = await request("series/" + slug);
    if (data.slug !== slug || !supported(data)) throw new Error("This Chikari series is unavailable in the comics source.");
    return data;
  }

  async function extractDetails(id) {
    const data = await detailsData(id);
    return { ...card(data), description: String(data.description || ""),
      genres: (data.genres || []).map(x => x.name).filter(Boolean),
      author: (data.authors || []).filter(x => x.role === "author").map(x => x.name).join(", "),
      alternativeTitles: Array.isArray(data.alt_titles) ? data.alt_titles : [] };
  }

  async function extractChapters(id) {
    const data = await detailsData(id);
    const output = [], seen = new Set();
    let offset = 0;
    // Fail rather than returning a silently truncated book if the API misbehaves.
    for (let page = 0; page < 100; page++) {
      const result = await request("series/" + data.slug + "/chapters?order=desc&limit=100&offset=" + offset);
      const rows = listing(result);
      if (!rows.length && offset < result.total) throw new Error("Chikari returned an incomplete chapter list.");
      let added = 0;
      for (const row of rows) {
        if (row.number === null || row.number === "" || !Number.isFinite(Number(row.number)) || Number(row.number) < 0) {
          throw new Error("Chikari returned an invalid chapter number.");
        }
        const number = Number(row.number), url = BASE + "/series/" + data.slug + "/" + number;
        if (seen.has(url)) continue;
        seen.add(url); added++;
        output.push({ id: url, href: url, url, number, title: "Chapter " + number + (row.title ? " - " + row.title : ""),
          language: row.lang || "en", releaseDate: row.created_at || null });
      }
      offset += rows.length;
      if (offset >= result.total) return output.sort((a, b) => a.number - b.number);
      if (!added) throw new Error("Chikari chapter pagination stopped advancing.");
    }
    throw new Error("Chikari chapter listing exceeded the safety limit.");
  }

  async function extractImages(id) {
    const { slug, number } = identity(id, true);
    await detailsData(BASE + "/series/" + slug);
    const data = await request("series/" + slug + "/chapters/" + number);
    if (data.series_slug !== slug || Number(data.number) !== number || !TYPES.includes(data.medium)
        || !Array.isArray(data.pages) || !data.pages.length) throw new Error("Chikari returned no valid pages for this chapter.");
    return data.pages.map(url => ({ url: mediaURL(url), headers: { Referer: BASE + "/" } }));
  }

  async function discoveryFeed(id, page = 1) {
    return feed("", page, id === "latest" || id === "added" ? "added" : "popular");
  }
  async function discoveryHome() {
    const popular = await discoveryFeed("popular");
    const latest = await discoveryFeed("latest");
    return { sections: [{ id: "popular", title: "Popular", items: popular.items },
      { id: "latest", title: "Recently Added", items: latest.items }] };
  }
  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryFeed, discoveryHome };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
