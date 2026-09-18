import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let requests = 0;
async function fetchv2(url, headers, method) {
  assert.equal(method, 'GET');
  assert.equal(new URL(url).hostname, 'chikari.moe');
  requests++;
  const {stdout} = await exec('curl', ['-sS','--max-time','25','-H','Accept: application/json',
    '-H','Referer: https://chikari.moe/', '-w','\n%{http_code}',url], {maxBuffer:4194304});
  const at = stdout.lastIndexOf('\n');
  return {status:Number(stdout.slice(at+1)),body:stdout.slice(0,at)};
}
const context = vm.createContext({URL,fetchv2});
new vm.Script(await readFile(new URL('./index.js',import.meta.url),'utf8')).runInContext(context);
const api = context.SynthetiqModule;
const first = await api.discoveryFeed('popular',1), second = await api.discoveryFeed('popular',2);
assert.ok(first.items.length && second.items.length);
assert.notEqual(first.items[0].id,second.items[0].id);
const home = await api.discoveryHome();
assert.ok(home.sections.every(x=>x.items.length));
const search = await api.searchResults('Reincarnator');
assert.ok(search.items.some(x=>x.title.toLowerCase()==='reincarnator'));
const details = await api.extractDetails(first.items[0].id);
assert.equal(details.id,first.items[0].id);
const chapters = await api.extractChapters(details.id);
assert.ok(chapters.length > 100);
const pageCounts = [];
for (const chapter of [chapters[0],chapters[chapters.length-1]]) {
  const pages = await api.extractImages(chapter.id);
  assert.ok(pages.length);
  const {stdout} = await exec('curl',['-fLsS','--max-time','25','-H','Referer: https://chikari.moe/',
    '-o','/dev/null','-w','%{http_code} %{size_download}', pages[0].url]);
  assert.match(stdout,/^200 [1-9]\d*/);
  pageCounts.push({chapter:chapter.number,pages:pages.length,firstImage:stdout});
}
console.log(JSON.stringify({search:search.items.length,popular:first.items.length,page2:second.items.length,
  home:home.sections.map(x=>({title:x.title,count:x.items.length})),chapters:chapters.length,pageCounts,apiRequests:requests},null,2));
