"use strict";

(() => {
  const BASE_URL = "https://comix.to";
  const HOME_URL = `${BASE_URL}/`;
  const SOURCE_HOST = "comix.to";
  const IMAGE_HOST_SUFFIXES = [".wowpic1.store", ".wowpic2.store"];
  const MAX_CHAPTER_PAGES = 64;
  const MAX_CHAPTERS = 20_000;
  const CHAPTER_FRAME_CONCURRENCY = 4;
  const MAX_ATTEMPTS = 2;
  const CACHE_TTL_MILLISECONDS = 5 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 32;
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    Referer: HOME_URL,
  };
  const IMAGE_HEADERS = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: HOME_URL,
  };
  const detailsCache = new Map();
  const detailsLoads = new Map();
  const chaptersCache = new Map();
  const chaptersLoads = new Map();
  const discoveryCache = new Map();
  const discoveryLoads = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function cachedValue(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MILLISECONDS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return value;
  }

  function loadCached(cache, loads, key, loader) {
    const cached = cachedValue(cache, key);
    if (cached !== null) return Promise.resolve(cached);
    const pending = loads.get(key);
    if (pending) return pending;
    const request = Promise.resolve()
      .then(loader)
      .then((value) => remember(cache, key, value))
      .finally(() => loads.delete(key));
    loads.set(key, request);
    return request;
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
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function parseJSON(value) {
    if (value && typeof value === "object") return value;
    const text = String(value || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function responseText(response) {
    if (!response) return Promise.resolve("");
    if (typeof response.text === "function") {
      return Promise.resolve(response.text()).then((value) => typeof value === "string" ? value : "");
    }
    return Promise.resolve(typeof response.body === "string" ? response.body : "");
  }

  function sourceURL(value, allowImage = false) {
    const raw = nonEmpty(value);
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw, BASE_URL);
    } catch (_) {
      return "";
    }
    if (parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase();
    if (allowImage) {
      const isReaderImageHost = IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
      if (!(host === SOURCE_HOST || host.endsWith(".comix.to") || isReaderImageHost)) return "";
    } else if (host !== SOURCE_HOST && !host.endsWith(".comix.to")) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  }

  function titlePath(value) {
    const raw = nonEmpty(value);
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== SOURCE_HOST) {
          throw new Error("Invalid Comix title identifier.");
        }
        path = parsed.pathname;
      } catch (_) {
        throw new Error("Invalid Comix title identifier.");
      }
    }
    path = path.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
    const match = path.match(/^title\/([^/]+)$/i) || path.match(/^([a-z0-9][a-z0-9-]*)$/i);
    if (!match) throw new Error("Invalid Comix title identifier.");
    const slug = decodeURIComponent(match[1]).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9][a-z0-9-]*)*$/.test(slug)) {
      throw new Error("Invalid Comix title identifier.");
    }
    return `/title/${slug}`;
  }

  function titleHID(value) {
    const slug = titlePath(value).slice("/title/".length);
    const hid = slug.split("-", 1)[0];
    if (!/^[a-z0-9]+$/i.test(hid)) throw new Error("Invalid Comix title identifier.");
    return hid;
  }

  function chapterParts(value) {
    const raw = nonEmpty(value);
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== SOURCE_HOST) {
          throw new Error("Invalid Comix chapter identifier.");
        }
        path = parsed.pathname;
      } catch (_) {
        throw new Error("Invalid Comix chapter identifier.");
      }
    }
    path = path.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
    const match = path.match(/^title\/([^/]+)\/(\d+)(?:-[^/]+)?$/i);
    if (!match) throw new Error("Invalid Comix chapter identifier.");
    const title = titlePath(`/title/${match[1]}`);
    const chapter = path.slice(`title/${match[1]}/`.length);
    return {
      id: match[2],
      path: `${title}/${chapter}`,
    };
  }

  function mapStatus(value) {
    switch (String(value || "").toLowerCase()) {
      case "releasing":
      case "ongoing":
        return "Ongoing";
      case "finished":
      case "completed":
        return "Completed";
      case "hiatus":
      case "on_hiatus":
        return "Hiatus";
      case "cancelled":
      case "canceled":
      case "discontinued":
        return "Cancelled";
      default:
        return "Unknown";
    }
  }

  function imageURL(value) {
    return sourceURL(value, true);
  }

  function initialData(html) {
    const match = String(html || "").match(
      /<script\b[^>]*\bid=["']initial-data["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (!match) throw new Error("Comix page did not contain its initial data.");
    const parsed = parseJSON(match[1]);
    if (!parsed || typeof parsed !== "object") throw new Error("Comix initial data was malformed.");
    return parsed;
  }

  function queryData(data, parts) {
    const queries = data && data.queries && typeof data.queries === "object" ? data.queries : {};
    const value = queries[JSON.stringify(parts)];
    if (value !== undefined) return value;
    for (const [key, candidate] of Object.entries(queries)) {
      const parsed = parseJSON(key);
      if (Array.isArray(parsed) && JSON.stringify(parsed) === JSON.stringify(parts)) return candidate;
    }
    return null;
  }

  function itemArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && value.data && Array.isArray(value.data.items)) return value.data.items;
    return [];
  }

  function mangaItem(item, fallbackPath = "") {
    if (!item || typeof item !== "object") return null;
    const title = nonEmpty(item.title || item.name);
    const href = sourceURL(item.url || fallbackPath);
    if (!title || !href || !new URL(href).pathname.startsWith("/title/")) return null;
    const poster = item.poster && typeof item.poster === "object" ? item.poster : {};
    const image = imageURL(poster.large || poster.medium || poster.small || item.image);
    return {
      id: href,
      href,
      url: href,
      title: decodeEntities(title),
      image,
      status: mapStatus(item.status),
    };
  }

  function detailsObject(item, fallbackPath) {
    if (!item || typeof item !== "object") throw new Error("Comix details did not contain a title.");
    const base = mangaItem(item, fallbackPath);
    if (!base) throw new Error("Comix details did not contain a valid title.");
    const authors = [];
    for (const source of [item.authors, item.artists]) {
      for (const author of Array.isArray(source) ? source : []) {
        const name = nonEmpty(typeof author === "object" ? (author.title || author.name) : author);
        if (name && !authors.includes(name)) authors.push(name);
      }
    }
    const genres = [];
    for (const source of [item.genres, item.demographics, item.formats]) {
      for (const genre of Array.isArray(source) ? source : []) {
        const name = nonEmpty(typeof genre === "object" ? (genre.title || genre.name) : genre);
        if (name && !genres.includes(name)) genres.push(name);
      }
    }
    return {
      ...base,
      description: stripHTML(item.synopsis || item.description || ""),
      author: authors.join(", "),
      authors,
      genres,
    };
  }

  async function fetchHTML(url) {
    if (typeof globalThis.fetchv2 !== "function") throw new Error("Comix requires the fetchv2 bridge.");
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(900 * (attempt - 1));
      try {
        const response = await globalThis.fetchv2(
          url,
          DEFAULT_HEADERS,
          "GET",
          null,
          { followRedirects: true, maxBytesHint: 2 * 1024 * 1024, responseClass: "html" },
        );
        const status = Number(response && response.status);
        if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
          throw new Error(`Comix request failed with HTTP ${status || "error"}.`);
        }
        if (response.bodyDropped) throw new Error("Comix response exceeded the module safety limit.");
        const body = await responseText(response);
        if (!body.trim()) throw new Error("Comix returned an empty response.");
        if (/just a moment|cf-chl-|verify you are human|access denied|captcha/i.test(body)) {
          throw new Error("Comix returned a challenge page.");
        }
        return body;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= MAX_ATTEMPTS || !/network|timed?\s*out|connection|HTTP (?:408|425|429|5\d\d)/i.test(lastError.message)) {
          throw lastError;
        }
      }
    }
    throw lastError || new Error("Comix request failed.");
  }

  function parsePagev2Result(snapshot, label) {
    const result = parseJSON(snapshot && snapshot.evaluatedData);
    if (!result) throw new Error(`Comix ${label} returned no browser data.`);
    if (result.ok === false) throw new Error(String(result.error || `Comix ${label} failed.`));
    return result;
  }

  async function pageJSON(url, options = {}) {
    if (typeof globalThis.pagev2 !== "function") {
      throw new Error("Comix requires the app's pagev2 browser bridge for this operation.");
    }
    const snapshot = await globalThis.pagev2({
      url,
      headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
      userAgent: null,
      timeoutMilliseconds: options.timeoutMilliseconds || 30_000,
      settleMilliseconds: options.settleMilliseconds ?? 250,
      includeHTML: false,
      captureResponseBodies: false,
      maxEntries: 32,
      maxResponseCharacters: 1_000_000,
      actionScript: options.actionScript || null,
      returnScript: options.returnScript || "JSON.stringify({})",
      waitForSelector: options.waitForSelector || "body",
      waitForURLIncludes: null,
      waitForRequestURLIncludes: null,
      waitForResponseURLIncludes: null,
      waitForResponseBodyIncludes: null,
    });
    return parsePagev2Result(snapshot, options.label || "page");
  }

  function listingReturnScript() {
    return `(() => {
      const items = [];
      const seen = new Set();
      for (const link of Array.from(document.querySelectorAll("a.lrow__title-link"))) {
        const raw = link.getAttribute("href") || "";
        const path = raw.split(/[?#]/, 1)[0];
        if (!/^\\/title\\/[a-z0-9][a-z0-9-]*$/i.test(path) || seen.has(path)) continue;
        const title = (link.querySelector("h3")?.textContent || link.textContent || "").trim();
        if (!title) continue;
        const row = link.closest(".lrow") || link.parentElement;
        const image = row?.querySelector("img")?.currentSrc || row?.querySelector("img")?.src || "";
        const rowText = row?.innerText || "";
        let status = "Unknown";
        if (/\\bFINISHED\\b/i.test(rowText)) status = "Completed";
        else if (/\\bONGOING\\b|\\bRELEASING\\b/i.test(rowText)) status = "Ongoing";
        else if (/\\bHIATUS\\b/i.test(rowText)) status = "Hiatus";
        items.push({
          id: new URL(path, location.origin).href,
          href: new URL(path, location.origin).href,
          url: new URL(path, location.origin).href,
          title,
          image,
          status,
        });
        seen.add(path);
      }
      const nav = Array.from(document.querySelectorAll("nav"))
        .find((candidate) => candidate.getAttribute("aria-label") === "Pagination");
      const currentPage = Number(nav?.querySelector("[aria-current=\\"page\\"]")?.textContent?.trim() || 1);
      const nextButton = nav?.querySelector("button[aria-label=\\"Next page\\"]");
      const laterNumber = nav && Array.from(nav.querySelectorAll("button.npager__num"))
        .some((button) => Number(button.textContent) > currentPage);
      const hasMore = Boolean((nextButton && !nextButton.disabled) || laterNumber);
      return JSON.stringify({ items, hasMore });
    })()`;
  }

  function searchReturnScript() {
    return listingReturnScript();
  }

  function chapterActionScript(titlePrefix) {
    const prefix = JSON.stringify(titlePrefix);
    return `(() => {
      const resultKey = "__synthetiqComixChapters";
      const markerID = "synthetiq-comix-chapters-complete";
      globalThis[resultKey] = null;
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const finish = () => {
        let marker = document.getElementById(markerID);
        if (!marker) {
          marker = document.createElement("div");
        }
        marker.id = markerID;
        marker.hidden = false;
        marker.textContent = "ready";
        marker.setAttribute("aria-hidden", "true");
        marker.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
        if (!marker.parentNode && document.body) document.body.appendChild(marker);
      };
      const currentPage = (root = document) => root.querySelector("nav[aria-label=\\"Pagination\\"] [aria-current=\\"page\\"]")?.textContent?.trim() || "";
      const readPage = (root = document) => {
        const entries = [];
        for (const link of Array.from(root.querySelectorAll("a[href]"))) {
          const raw = link.getAttribute("href") || "";
          let url;
          try { url = new URL(raw, location.origin); } catch (_) { continue; }
          if (url.origin !== location.origin || !url.pathname.startsWith(${prefix} + "/")) continue;
          const tail = url.pathname.slice(${prefix}.length + 1);
          const idMatch = tail.match(/^(\\d+)(?:-[^/]+)?$/);
          if (!idMatch) continue;
          const row = link.closest(".mchap-item") || link.parentElement;
          const rawNumber = link.querySelector(".mchap-row__ch")?.textContent || "";
          const numberMatch = rawNumber.match(/(?:ch(?:apter)?\\.?\\s*)(\\d+(?:\\.\\d+)?)/i)
            || tail.match(/chapter-(\\d+(?:\\.\\d+)?)/i);
          const number = numberMatch ? Number(numberMatch[1]) : null;
          const chapterName = link.querySelector(".mchap-row__title")?.textContent?.trim() || "";
          const group = row?.querySelector(".mchap-row__group")?.textContent?.trim() || "";
          const label = Number.isFinite(number) ? "Chapter " + number : "Chapter";
          const title = chapterName ? label + ": " + chapterName + (group ? " (" + group + ")" : "") : label + (group ? " (" + group + ")" : "");
          entries.push({
            id: url.href,
            href: url.href,
            url: url.href,
            title,
            number: Number.isFinite(number) ? number : null,
            releaseDate: null,
            language: "en",
          });
        }
        return entries;
      };
      const waitForRows = async (root, label) => {
        for (let attempt = 0; attempt < 240; attempt += 1) {
          let documentRoot = root;
          try {
            if (root && root.contentDocument) documentRoot = root.contentDocument;
          } catch (_) {}
          const entries = documentRoot ? readPage(documentRoot) : [];
          if (entries.length) return entries;
          await delay(25);
        }
        throw new Error("Comix " + label + " chapter page did not load.");
      };
      const waitForPageChange = async (beforePage, beforeFirst, label) => {
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const entries = readPage();
          const pageChanged = currentPage() !== beforePage;
          const firstChanged = entries[0]?.id !== beforeFirst;
          if (entries.length > 0 && pageChanged && firstChanged) return entries;
          await delay(25);
        }
        throw new Error("Comix " + label + " pagination did not advance.");
      };
      const nextButton = () => {
        const nav = document.querySelector("nav[aria-label=\\"Pagination\\"]");
        let next = nav?.querySelector("button[aria-label=\\"Next page\\"]");
        if (!next && nav) {
          const page = Number(currentPage());
          next = Array.from(nav.querySelectorAll("button.npager__num"))
            .filter((button) => Number(button.textContent) > page)
            .sort((left, right) => Number(left.textContent) - Number(right.textContent))[0] || null;
        }
        return next;
      };
      const collectSequential = async (initialEntries) => {
        const pageEntries = new Map([[1, initialEntries]]);
        let pagesVisited = 1;
        for (let guard = 1; guard < ${MAX_CHAPTER_PAGES}; guard += 1) {
          const next = nextButton();
          if (!next || next.disabled) break;
          const beforePage = currentPage();
          const beforeFirst = readPage()[0]?.id || "";
          next.click();
          const entries = await waitForPageChange(beforePage, beforeFirst, "chapter");
          const page = Number(currentPage()) || pagesVisited + 1;
          pageEntries.set(page, entries);
          pagesVisited += 1;
        }
        const finalNav = document.querySelector("nav[aria-label=\\"Pagination\\"]");
        const finalPage = Number(currentPage()) || pagesVisited;
        const finalArrow = finalNav?.querySelector("button[aria-label=\\"Next page\\"]");
        const finalNumber = finalNav && Array.from(finalNav.querySelectorAll("button.npager__num"))
          .some((button) => Number(button.textContent) > finalPage);
        if ((finalArrow && !finalArrow.disabled) || finalNumber) {
          throw new Error("Comix chapter list exceeded its page safety limit.");
        }
        return { pageEntries, pagesVisited };
      };
      const collectParallel = async (initialEntries) => {
        const last = document.querySelector("nav[aria-label=\\"Pagination\\"] button[aria-label=\\"Last page\\"]");
        if (!last || last.disabled) return collectSequential(initialEntries);
        const beforePage = currentPage();
        const beforeFirst = initialEntries[0]?.id || "";
        last.click();
        let lastEntries;
        try {
          lastEntries = await waitForPageChange(beforePage, beforeFirst, "last-page");
        } catch (error) {
          const first = document.querySelector("nav[aria-label=\\"Pagination\\"] button[aria-label=\\"First page\\"]");
          if (!first || first.disabled) throw error;
          const resetBeforePage = currentPage();
          const resetBeforeFirst = readPage()[0]?.id || "";
          first.click();
          const resetEntries = await waitForPageChange(resetBeforePage, resetBeforeFirst, "first-page");
          return collectSequential(resetEntries);
        }
        const lastPage = Number(currentPage());
        if (!Number.isInteger(lastPage) || lastPage < 1 || lastPage > ${MAX_CHAPTER_PAGES}) {
          throw new Error("Comix chapter list exceeded its page safety limit.");
        }
        const pageEntries = new Map([[1, initialEntries], [lastPage, lastEntries]]);
        const pageNumbers = [];
        for (let page = 2; page < lastPage; page += 1) pageNumbers.push(page);
        const collectFrame = async (page) => {
          const frame = document.createElement("iframe");
          const frameURL = new URL(location.href);
          frameURL.searchParams.set("page", String(page));
          frameURL.hash = "";
          frame.src = frameURL.href;
          frame.loading = "eager";
          frame.tabIndex = -1;
          frame.setAttribute("aria-hidden", "true");
          frame.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
          document.body.appendChild(frame);
          try {
            return { page, entries: await waitForRows(frame, "iframe page " + page) };
          } catch (error) {
            return { page, error };
          } finally {
            frame.remove();
          }
        };
        for (let offset = 0; offset < pageNumbers.length; offset += ${CHAPTER_FRAME_CONCURRENCY}) {
          const batch = await Promise.all(pageNumbers.slice(offset, offset + ${CHAPTER_FRAME_CONCURRENCY}).map(collectFrame));
          const failed = batch.find((result) => result.error);
          if (failed) {
            const first = document.querySelector("nav[aria-label=\\"Pagination\\"] button[aria-label=\\"First page\\"]");
            if (!first || first.disabled) throw failed.error;
            const resetBeforePage = currentPage();
            const resetBeforeFirst = readPage()[0]?.id || "";
            first.click();
            const resetEntries = await waitForPageChange(resetBeforePage, resetBeforeFirst, "first-page");
            return collectSequential(resetEntries);
          }
          for (const result of batch) pageEntries.set(result.page, result.entries);
        }
        for (let page = 1; page <= lastPage; page += 1) {
          if (!pageEntries.has(page)) throw new Error("Comix chapter pagination returned an incomplete page set.");
        }
        return { pageEntries, pagesVisited: lastPage };
      };
      void (async () => {
        try {
          const initialEntries = await waitForRows(document, "title");
          const collected = await collectParallel(initialEntries);
          const chapters = [];
          const seen = new Set();
          for (let page = 1; page <= collected.pagesVisited; page += 1) {
            for (const entry of collected.pageEntries.get(page) || []) {
              if (seen.has(entry.id)) continue;
              seen.add(entry.id);
              chapters.push(entry);
              if (chapters.length > ${MAX_CHAPTERS}) throw new Error("Comix chapter list exceeds its safety limit.");
            }
          }
          if (!chapters.length) throw new Error("Comix title returned no chapters.");
          globalThis[resultKey] = JSON.stringify({ ok: true, chapters, pagesVisited: collected.pagesVisited });
        } catch (error) {
          globalThis[resultKey] = JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
        } finally {
          finish();
        }
      })();
    })()`;
  }

  function imageActionScript() {
    return `(() => {
      const resultKey = "__synthetiqComixImages";
      const markerID = "synthetiq-comix-images-complete";
      globalThis[resultKey] = null;
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const finish = () => {
        let marker = document.getElementById(markerID);
        if (!marker) {
          marker = document.createElement("div");
          marker.id = markerID;
          marker.hidden = true;
          document.body.appendChild(marker);
        }
      };
      const readerURLs = () => {
        const output = [];
        const seen = new Set();
        const imageHostSuffixes = ${JSON.stringify(IMAGE_HOST_SUFFIXES)};
        for (const entry of performance.getEntriesByType("resource")) {
          let url;
          try { url = new URL(entry.name); } catch (_) { continue; }
          const host = url.hostname.toLowerCase();
          if (!imageHostSuffixes.some((suffix) => host.endsWith(suffix)) || !url.pathname.startsWith("/i5/")) continue;
          url.hash = "";
          if (seen.has(url.href)) continue;
          seen.add(url.href);
          output.push(url.href);
        }
        return output;
      };
      void (async () => {
        try {
          let main = null;
          let pages = Array.from(document.querySelectorAll(".rpage-page[data-page]"));
          for (let attempt = 0; attempt < 160 && (!main || !pages.length); attempt += 1) {
            await delay(75);
            main = document.querySelector("main.rpage-main");
            pages = Array.from(document.querySelectorAll(".rpage-page[data-page]"));
          }
          if (!main || !pages.length) throw new Error("Comix reader did not expose page containers.");
          const walk = async () => {
            for (const page of pages) {
              main.scrollTop = Math.max(0, page.offsetTop - Math.round(main.clientHeight * 0.15));
              await delay(60);
            }
          };
          await walk();
          await delay(700);
          let urls = readerURLs();
          if (urls.length < pages.length) {
            await walk();
            await delay(900);
            urls = readerURLs();
          }
          if (urls.length < pages.length) {
            throw new Error("Comix reader loaded " + urls.length + " of " + pages.length + " page images.");
          }
          globalThis[resultKey] = JSON.stringify({ ok: true, pages: urls.slice(0, pages.length), pageCount: pages.length });
        } catch (error) {
          globalThis[resultKey] = JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) });
        } finally {
          finish();
        }
      })();
    })()`;
  }

  function normalizeSearchItems(items) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const mapped = mangaItem(item, item && (item.href || item.url || item.id));
      if (!mapped || seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      result.push(mapped);
    }
    return result;
  }

  function normalizeChapters(value) {
    const input = Array.isArray(value) ? value : value && (value.chapters || value.items);
    const chapters = [];
    const seen = new Set();
    for (const item of Array.isArray(input) ? input : []) {
      if (!item || typeof item !== "object") continue;
      const href = sourceURL(item.href || item.url || item.id);
      if (!href || !/\/title\/[^/]+\/\d+(?:-[^/?#]+)?$/i.test(new URL(href).pathname) || seen.has(href)) continue;
      const number = Number(item.number);
      chapters.push({
        id: href,
        href,
        url: href,
        title: nonEmpty(item.title) || (Number.isFinite(number) ? `Chapter ${number}` : "Chapter"),
        number: Number.isFinite(number) ? number : null,
        releaseDate: item.releaseDate ? String(item.releaseDate) : null,
        language: nonEmpty(item.language) || "en",
      });
      seen.add(href);
    }
    chapters.sort((left, right) => {
      if (left.number == null && right.number != null) return 1;
      if (left.number != null && right.number == null) return -1;
      if (left.number == null && right.number == null) return 0;
      return right.number - left.number;
    });
    return chapters;
  }

  function normalizeImages(value) {
    const input = Array.isArray(value) ? value : value && (value.pages || value.images);
    const pages = [];
    for (const item of Array.isArray(input) ? input : []) {
      const raw = typeof item === "string" ? item : item && (item.url || item.src);
      const url = imageURL(raw);
      if (!url) continue;
      pages.push({
        url,
        headers: { ...IMAGE_HEADERS },
      });
    }
    if (!pages.length) throw new Error("Comix chapter returned no readable page images.");
    return pages;
  }

  let homeCache = { at: 0, body: "" };
  async function loadHome() {
    if (homeCache.body && Date.now() - homeCache.at < 300_000) return homeCache.body;
    homeCache = { at: Date.now(), body: await fetchHTML(HOME_URL) };
    return homeCache.body;
  }

  function homeFeedResult(body, feed) {
    const data = initialData(body);
    const candidates = [];
    for (const [key, value] of Object.entries(data.queries || {})) {
      const parts = parseJSON(key);
      if (!Array.isArray(parts) || parts[0] !== "manga") continue;
      const options = parts[2] && typeof parts[2] === "object" ? parts[2] : {};
      const matches = feed === "popular"
        ? (options.type === "trending" || options.type === "follows")
        : (options.scope === "hot" || options.scope === "new" || options.order?.chapter_updated_at);
      if (!matches) continue;
      const items = normalizeSearchItems(itemArray(value));
      if (items.length) {
        const meta = value && typeof value === "object" && !Array.isArray(value) ? value.meta : null;
        const hasMore = Boolean(
          meta && (meta.hasNext === true || meta.has_next === true)
            || (feed === "popular" && items.length >= 50)
            || (feed === "latest" && items.length >= 31),
        );
        candidates.push({
          score: options.type === "trending" || options.scope === "hot" ? 0 : 1,
          items,
          hasMore,
        });
      }
    }
    candidates.sort((left, right) => left.score - right.score);
    return candidates[0] || { items: [], hasMore: false };
  }

  function browseFeedURL(feed, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    if (feed === "popular") return `${BASE_URL}/browse?sort=views_7d%3Adesc&page=${currentPage}`;
    return `${BASE_URL}/browse?page=${currentPage}`;
  }

  async function browseFeedPage(feed, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const key = `${feed}:${currentPage}`;
    return loadCached(discoveryCache, discoveryLoads, key, async () => {
      const payload = await pageJSON(browseFeedURL(feed, currentPage), {
        label: `${feed} discovery page`,
        settleMilliseconds: 150,
        returnScript: listingReturnScript(),
      });
      const items = normalizeSearchItems(payload.items);
      return { items, hasMore: Boolean(payload.hasMore && items.length) };
    });
  }

  async function searchResults(query, page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    const text = typeof query === "object" && query !== null
      ? nonEmpty(query.text || query.query)
      : nonEmpty(query);
    if (/^__feed:/i.test(text)) {
      return discoveryFeed(text.slice("__feed:".length), currentPage);
    }
    if (currentPage > 1) return { items: [], hasMore: false };
    const url = `${BASE_URL}/browse?q=${encodeURIComponent(text)}`;
    const payload = await pageJSON(url, {
      label: "search",
      settleMilliseconds: 700,
      returnScript: searchReturnScript(),
    });
    return { items: normalizeSearchItems(payload.items), hasMore: false };
  }

  async function extractDetails(id) {
    const path = titlePath(id);
    return loadCached(detailsCache, detailsLoads, path, async () => {
      const body = await fetchHTML(`${BASE_URL}${path}`);
      const data = initialData(body);
      const item = queryData(data, ["manga", "detail", titleHID(id)]);
      return detailsObject(item, path);
    });
  }

  async function extractChapters(id) {
    const path = titlePath(id);
    return loadCached(chaptersCache, chaptersLoads, path, async () => {
      const payload = await pageJSON(`${BASE_URL}${path}`, {
        label: "chapters",
        actionScript: chapterActionScript(path),
        returnScript: "globalThis.__synthetiqComixChapters || JSON.stringify({ ok: false, error: 'Comix chapter pagination did not finish.' })",
        waitForSelector: "#synthetiq-comix-chapters-complete",
        settleMilliseconds: 50,
      });
      const chapters = normalizeChapters(payload.chapters || payload.items);
      if (!chapters.length) throw new Error("Comix title returned no readable chapters.");
      if (typeof globalThis.reportProgress === "function" && payload.pagesVisited) {
        await globalThis.reportProgress({ stage: "chapters", completed: payload.pagesVisited, total: payload.pagesVisited });
      }
      return chapters;
    });
  }

  async function extractImages(id) {
    const chapter = chapterParts(id);
    const payload = await pageJSON(`${BASE_URL}${chapter.path}`, {
      label: "reader images",
      actionScript: imageActionScript(),
      returnScript: "globalThis.__synthetiqComixImages || JSON.stringify({ ok: false, error: 'Comix reader image collection did not finish.' })",
      waitForSelector: "#synthetiq-comix-images-complete",
      settleMilliseconds: 500,
      timeoutMilliseconds: 30_000,
    });
    return normalizeImages(payload.pages || payload.images);
  }

  async function discoveryHome() {
    const body = await loadHome();
    const popular = homeFeedResult(body, "popular");
    const latest = homeFeedResult(body, "latest");
    return {
      sections: [
        { id: "popular", title: "Popular", items: popular.items },
        { id: "latest", title: "Latest", items: latest.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const currentPage = Math.max(1, Number(page) || 1);
    const feed = /latest|new/i.test(String(feedID || "")) ? "latest" : "popular";
    if (currentPage > 1) return browseFeedPage(feed, currentPage);
    const body = await loadHome();
    const firstPage = homeFeedResult(body, feed);
    return { items: firstPage.items, hasMore: firstPage.hasMore };
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
