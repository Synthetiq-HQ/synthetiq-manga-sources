import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const series = { slug: 'fixture-comic', title: 'Fixture Comic', type: 'manga', is_nsfw: false,
  cover_url: 'https://cdn.chikari.moe/series/1/cover.webp', status: 'releasing' };
const base = 'https://chikari.moe/series/fixture-comic';
function load(responder) {
  const context = vm.createContext({ URL, fetchv2: async (url, headers, method, body, options) => {
    assert.equal(method, 'GET'); assert.equal(body, null); assert.equal(options.responseClass, 'json');
    const value = await responder(new URL(url));
    return { status: 200, body: JSON.stringify(value), ...value?.response };
  } });
  new vm.Script(script).runInContext(context);
  return context.SynthetiqModule;
}
test('search encodes reserved characters and excludes adult and novel records', async () => {
  const api = load(url => {
    assert.equal(url.searchParams.get('q'), 'A & B/#?');
    assert.equal(url.searchParams.get('adult'), 'false');
    assert.equal(url.searchParams.get('offset'), '36');
    return { items: [series, {...series, is_nsfw:true}, {...series, type:'novel'}], total: 40 };
  });
  const result = await api.searchResults('A & B/#?', 2);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].id, base); assert.equal(result.hasMore, true);
});
test('chapter pagination returns full ascending list with decimal numbers', async () => {
  const api = load(url => {
    if (!url.pathname.endsWith('/chapters')) return series;
    const offset = Number(url.searchParams.get('offset'));
    return { total: 102, items: Array.from({length: Math.min(100,102-offset)}, (_,i) => ({number: 101.5-offset-i, lang:'en'})) };
  });
  const chapters = await api.extractChapters(base);
  assert.equal(chapters.length, 102); assert.equal(chapters[0].number, 0.5); assert.equal(chapters[101].number, 101.5);
  assert.equal(chapters[0].id, base + '/0.5');
});
test('stalled chapter pagination throws instead of returning partial data', async () => {
  const api = load(url => url.pathname.endsWith('/chapters') ? { items:[{number:1}],total:10 } : series);
  await assert.rejects(api.extractChapters(base), /stopped advancing/);
});
test('page order and required image headers are retained', async () => {
  const pages = ['https://cdn.chikari.moe/series/1/ch/1/002.webp','https://cdn.chikari.moe/series/1/ch/1/001.webp'];
  const api = load(url => url.pathname.endsWith('/chapters/1')
    ? { series_slug: series.slug, number:1, medium:'manga',pages } : series);
  const result = await api.extractImages(base + '/1');
  assert.equal(result[0].url, pages[0]); assert.equal(result[1].url, pages[1]);
  assert.equal(result[0].headers.Referer, 'https://chikari.moe/');
});
test('foreign identities and media hosts fail closed', async () => {
  const api = load(url => url.pathname.endsWith('/chapters/1')
    ? {series_slug:series.slug,number:1,medium:'manga',pages:['https://evil.invalid/page.webp']} : series);
  await assert.rejects(api.extractDetails('https://evil.invalid/series/fixture-comic'), /Invalid/);
  await assert.rejects(api.extractImages(base + '/1'), /unsupported image host/);
});
test('wrong chapter ownership and adult direct links fail closed', async () => {
  const api = load(url => url.pathname.endsWith('/chapters/1')
    ? {series_slug:'another-book',number:1,medium:'manga',pages:['https://cdn.chikari.moe/1.webp']} : series);
  await assert.rejects(api.extractImages(base + '/1'), /no valid pages/);
  await assert.rejects(load(() => ({...series,is_nsfw:true})).extractDetails(base), /unavailable/);
});
test('HTTP failures, challenge HTML, oversized responses and missing schema are errors', async () => {
  for (const status of [403,404,429,503]) {
    await assert.rejects(load(() => ({response:{status}})).searchResults('test'), /HTTP/);
  }
  await assert.rejects(load(() => ({response:{body:'<html>verify</html>'}})).searchResults('test'), /verification/);
  await assert.rejects(load(() => ({response:{bodyDropped:true}})).searchResults('test'), /size/);
  await assert.rejects(load(() => ({})).searchResults('test'), /invalid listing/);
});
