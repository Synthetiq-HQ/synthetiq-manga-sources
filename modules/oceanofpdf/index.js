"use strict";

(() => {
  const BASE = "https://oceanofpdf.com";
  const FILE_HOSTS = new Set(["fs3.oceanofpdf.com", "fs4.oceanofpdf.com"]);
  const MAX_HTML = 2 * 1024 * 1024;
  const cache = new Map();
  const pending = new Map();

  function webURL(value) {
    const url = new URL(String(value), BASE);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      throw new Error("OceanofPDF returned an unsafe URL.");
    }
    return url;
  }

  function bookURL(value) {
    const url = webURL(value);
    if (url.origin !== BASE || !/^\/authors\/[^/]+\/[^/]+\/$/.test(url.pathname)) {
      throw new Error("Invalid OceanofPDF book identity.");
    }
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function pageNumber(value) {
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      throw new Error("Invalid OceanofPDF page number.");
    }
    return page;
  }

  function coverURL(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = webURL(value);
      return ["oceanofpdf.com", "media.oceanofpdf.com"].includes(url.hostname) ? url.href : null;
    } catch (_) { return null; }
  }

  // Runs in the app-owned pagev2 document. It reads DOM metadata only.
  function capturePage(kind) {
    const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
    const cleanTitle = (value) => value.replace(/^(?:\[(?:PDF|EPUB)\]\s*)+/i, "").replace(/\s+Download$/i, "").trim();
    const image = (node) => {
      const img = node?.querySelector("img");
      return img?.getAttribute("data-src") || img?.getAttribute("src") || null;
    };
    const main = document.querySelector("main");
    if (!main || /just a moment|attention required|access denied/i.test(document.title)) {
      throw new Error("OceanofPDF browser verification is required or the site is unavailable.");
    }
    if (kind === "list") {
      const articles = [...main.querySelectorAll("article")];
      const items = articles.filter(a => /\[(?:PDF|EPUB)\]/i.test(a.getAttribute("aria-label") || text(a.querySelector(".entry-title"))))
        .slice(0, 60).map(a => ({
          id: a.querySelector(".entry-title a")?.href,
          title: cleanTitle(text(a.querySelector(".entry-title"))),
          coverURL: image(a.querySelector(".entry-image-link") || a),
        }));
      const empty = /sorry.*no (?:posts|results)|no results|nothing found|no posts found/i.test(text(main));
      if (!items.length && !empty) throw new Error("OceanofPDF catalogue layout is not recognized.");
      return { url: location.href, items, next: main.querySelector(".pagination-next a")?.href || null };
    }
    const article = main.querySelector("article");
    const content = article?.querySelector(".entry-content");
    if (!content) throw new Error("OceanofPDF book details are unavailable.");
    const fields = {};
    for (const li of content.querySelectorAll("li")) {
      const label = li.querySelector("strong");
      if (!label) continue;
      const key = text(label).replace(/\s*:\s*$/, "").toLowerCase();
      fields[key] = text(li).slice(text(label).length).replace(/^\s*:\s*/, "").trim();
    }
    const paragraphs = [...content.querySelectorAll("p")];
    const coverParagraph = paragraphs.findIndex(p => p.querySelector("img"));
    const summary = coverParagraph >= 0 ? text(paragraphs[coverParagraph + 1]).slice(0, 4000) : "";
    return {
      url: location.href,
      title: fields["full book name"] || cleanTitle(text(article.querySelector("h1"))),
      author: fields["author name"] || "",
      genres: (fields["book genre"] || "").split(",").map(x => x.trim()).filter(Boolean),
      description: summary,
      coverURL: image(content),
      forms: [...content.querySelectorAll("form")].slice(0, 8).map(f => ({
        action: f.action, method: f.method,
        server: f.querySelector('input[name="id"]')?.value,
        fileName: f.querySelector('input[name="filename"]')?.value,
      })),
    };
  }

  async function readPage(url, kind) {
    const key = `${kind}:${url}`;
    const saved = cache.get(key);
    if (saved && Date.now() - saved.time < 120000) return saved.value;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 2) throw new Error("OceanofPDF is busy. Retry when the current request finishes.");
    const work = (async () => {
      if (typeof globalThis.pagev2 !== "function") {
        throw new Error("OceanofPDF needs Books browser verification support (pagev2).");
      }
      const snapshot = await globalThis.pagev2({
        url, timeoutMilliseconds: 18000, settleMilliseconds: 300,
        includeHTML: false, captureResponseBodies: false, maxEntries: 1,
        maxResponseCharacters: MAX_HTML, waitForSelector: "main",
        returnScript: `(${capturePage.toString()})(${JSON.stringify(kind)})`,
      });
      let data = snapshot?.evaluatedData;
      if (typeof data === "string") data = JSON.parse(data);
      if (!data || webURL(data.url).href !== url) {
        throw new Error("OceanofPDF returned an unexpected page. Verification may be required.");
      }
      if (cache.size >= 20) cache.delete(cache.keys().next().value);
      cache.set(key, { time: Date.now(), value: data });
      return data;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }

  async function listing(url) {
    const data = await readPage(url, "list");
    if (!Array.isArray(data.items)) throw new Error("OceanofPDF returned invalid catalogue data.");
    const seen = new Set();
    const items = [];
    for (const raw of data.items.slice(0, 60)) {
      let id;
      try { id = bookURL(raw.id); } catch (_) { continue; }
      const title = String(raw.title || "").trim();
      if (!title || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, title, coverURL: coverURL(raw.coverURL) });
    }
    let hasMore = false;
    if (data.next) {
      const next = webURL(data.next);
      const current = new URL(url);
      const currentPage = Number(current.pathname.match(/\/page\/(\d+)\/$/)?.[1] || 1);
      const nextPage = Number(next.pathname.match(/\/page\/(\d+)\/$/)?.[1]);
      hasMore = next.origin === BASE && nextPage === currentPage + 1
        && next.pathname.replace(/page\/\d+\/$/, "") === current.pathname.replace(/page\/\d+\/$/, "")
        && next.searchParams.get("s") === current.searchParams.get("s");
    }
    return { items, hasMore };
  }

  async function searchResults(query, page = 1) {
    const q = String(query || "").trim();
    const number = pageNumber(page);
    if (!q) return { items: [], hasMore: false };
    if (q.length > 200) throw new Error("OceanofPDF search is too long.");
    const url = new URL(number === 1 ? "/" : `/page/${number}/`, BASE);
    url.searchParams.set("s", q);
    return listing(url.href);
  }

  async function discoveryFeed(feedID, page = 1) {
    if (feedID !== "recently-added") throw new Error("Unknown OceanofPDF discovery feed.");
    const number = pageNumber(page);
    return listing(`${BASE}/recently-added/${number === 1 ? "" : `page/${number}/`}`);
  }

  async function discoveryHome() {
    const feed = await discoveryFeed("recently-added");
    return { sections: [{ id: "recently-added", title: "Recently Added", ...feed }] };
  }

  async function extractDetails(id) {
    const url = bookURL(id);
    const data = await readPage(url, "detail");
    if (!data.title) throw new Error("OceanofPDF returned a book without a title.");
    return {
      id: url, title: String(data.title), coverURL: coverURL(data.coverURL),
      author: String(data.author || ""), description: String(data.description || "").slice(0, 4000),
      genres: Array.isArray(data.genres) ? data.genres.slice(0, 40).map(String) : [],
    };
  }

  function resourceFromHTML(html, fileName) {
    // Read literal URLs, never evaluate a script supplied by the website.
    const candidates = html.match(/https:\/\/fs\d+\.oceanofpdf\.com\/[^\s'"<>\\]+/g) || [];
    for (const candidate of candidates) {
      const url = webURL(candidate.replace(/&amp;/g, "&"));
      if (!FILE_HOSTS.has(url.hostname)) continue;
      let actualName;
      try { actualName = decodeURIComponent(url.pathname.split("/").pop()); } catch (_) { continue; }
      if (actualName !== fileName || !url.pathname.startsWith("/OceanofPDF.com/")) continue;
      const expires = Number(url.searchParams.get("expires"));
      if (!url.searchParams.get("md5") || !Number.isFinite(expires) || expires < Date.now() / 1000 + 60) continue;
      return { format: fileName.toLowerCase().endsWith(".epub") ? "epub" : "pdf", url: url.href, fileName };
    }
    throw new Error("OceanofPDF did not provide a valid file for this book. The link may have expired or its file host changed.");
  }

  async function extractResources(id) {
    const url = bookURL(id);
    const data = await readPage(url, "detail");
    if (!Array.isArray(data.forms)) throw new Error("OceanofPDF download options are unavailable.");
    const forms = [];
    const seen = new Set();
    for (const form of data.forms) {
      if (!/\.(pdf|epub)$/i.test(form.fileName || "")) continue;
      if (webURL(form.action).href !== `${BASE}/Fetching_Resource.php`
          || String(form.method).toLowerCase() !== "post"
          || !/^srv\d{1,2}$/.test(form.server || "")
          || /[/\\\x00-\x1f]/.test(form.fileName) || form.fileName.length > 500) {
        throw new Error("OceanofPDF returned an unsafe download form.");
      }
      if (!seen.has(form.fileName)) { seen.add(form.fileName); forms.push(form); }
    }
    if (!forms.length) throw new Error("No PDF or EPUB is available for this OceanofPDF title.");
    if (forms.length > 2) throw new Error("OceanofPDF returned ambiguous publication editions.");
    if (typeof globalThis.fetchv2 !== "function") throw new Error("OceanofPDF requires the fetchv2 bridge.");
    const resources = [];
    for (const form of forms) {
      const response = await globalThis.fetchv2(form.action,
        { "Content-Type": "application/x-www-form-urlencoded", Referer: url, Accept: "text/html" },
        "POST", `id=${encodeURIComponent(form.server)}&filename=${encodeURIComponent(form.fileName)}`,
        { followRedirects: false, maxBytesHint: MAX_HTML, responseClass: "html" });
      const status = Number(response?.status);
      if (status !== 200 || response?.ok === false || response?.bodyDropped) {
        throw new Error(`OceanofPDF download resolution failed (HTTP ${status || "unavailable"}). Verify the source and retry.`);
      }
      if (response.finalUrl && webURL(response.finalUrl).href !== form.action) {
        throw new Error("OceanofPDF redirected its download form unexpectedly.");
      }
      const html = typeof response.text === "function" ? await response.text() : response.body;
      if (typeof html !== "string" || html.length > MAX_HTML) throw new Error("OceanofPDF download response exceeded its limit.");
      resources.push(resourceFromHTML(html, form.fileName));
    }
    return resources;
  }

  const handlers = { searchResults, extractDetails, extractResources, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
