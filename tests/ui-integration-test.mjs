import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isolatedServer } from './helpers/isolated-server.mjs';
const root = path.resolve(import.meta.dirname, '..');
const themesContext = { window: {} }; vm.createContext(themesContext);
vm.runInContext(fs.readFileSync(path.join(root, 'editor/js/studio-themes.js'), 'utf8'), themesContext);
const themes = themesContext.window.SF_THEMES;
const stateSource = fs.readFileSync(path.join(root, 'editor/js/studio-state.js'), 'utf8');
const { normalizeStudio, projectPhase, matchesProject, imageData } = await import('data:text/javascript;base64,' + Buffer.from(stateSource).toString('base64'));
assert.equal(normalizeStudio(null, themes).themePack, 'studio');
assert.equal(normalizeStudio({ themePack: 'bad', accent: 'url(evil)', mode: 'bad', image: '<svg>', motion: 'bad', custom: [{}] }, themes).accent, '#5c7560');
assert.equal(imageData('data:image/svg+xml;base64,AAAA'), false);
assert.deepEqual(normalizeStudio({},themes).auroraColors,[],'old preferences inherit theme colors');
assert.equal(normalizeStudio({},themes).auroraMotion,'dynamic');
assert.equal(normalizeStudio({},themes).glassDim,80);
assert.equal(normalizeStudio({},themes).glassBlur,18);
assert.equal(normalizeStudio({},themes).glassOpacity,100);
for (const invalid of [NaN,Infinity,null,'18',{}]) {
  assert.equal(normalizeStudio({glassDim:invalid,glassBlur:invalid},themes).glassDim,80);
  assert.equal(normalizeStudio({glassDim:invalid,glassBlur:invalid},themes).glassBlur,18);
  assert.equal(normalizeStudio({glassOpacity:invalid},themes).glassOpacity,100);
}
assert.equal(normalizeStudio({glassDim:0,glassBlur:99},themes).glassDim,72);
assert.equal(normalizeStudio({glassDim:0,glassBlur:99},themes).glassBlur,32);
assert.equal(normalizeStudio({glassOpacity:0},themes).glassOpacity,20);
assert.equal(normalizeStudio({glassOpacity:101},themes).glassOpacity,100);
const colors=['#123456','#abcdef','#789abc'];
const normalized=normalizeStudio({auroraColors:colors,auroraMotion:'static'},themes);
assert.deepEqual(normalized.auroraColors,colors); colors[0]='#000000'; assert.equal(normalized.auroraColors[0],'#123456','colors copied');
for(const invalid of [['url(evil)','#123456','#123456'],['#123456'],[1,2,3],null,'#123456'])assert.deepEqual(normalizeStudio({auroraColors:invalid},themes).auroraColors,[]);
assert.equal(normalizeStudio({auroraMotion:'bad'},themes).auroraMotion,'dynamic');
const prefs = normalizeStudio({ folders: [{ id: 'f-one', name: 'Folder' }, { id: 'f-one', name: 'duplicate' }, { id: '../x', name: 'bad' }], assignments: { 'p-one': 'f-one', 'p-bad': 'f-no' } }, themes);
assert.equal(prefs.folders.length, 1); assert.deepEqual(prefs.assignments, { 'p-one': 'f-one' });
const active = { id: 'p-one', name: 'Movie', draft: { status: 'running', progress: 30 } };
const ready = { id: 'p-ready', name: 'Ready', format: 'ass', videoExists: true };
const error = { id: 'p-error', name: 'Error', format: 'ass', draft: { status: 'paused' } };
assert.equal(projectPhase(active), 'active'); assert.equal(projectPhase(ready), 'ready'); assert.equal(projectPhase(error), 'attention');
assert.ok(matchesProject(active, { route: '#/tasks', filter: 'active', folder: 'f-one', search: 'MOV' }, prefs.assignments));
assert.equal(matchesProject(ready, { route: '#/tasks' }), false);
assert.equal(matchesProject(error, { filter: 'ready' }), false);
assert.ok(matchesProject({ id: 'p-window', name: 'Creating', prepare: {} }, { route: '#/tasks' }), 'new prepare window remains in task center');
const old = fs.readFileSync(path.join(root, 'editor/index.html'), 'utf8'), fresh = fs.readFileSync(path.join(root, 'editor/studio.html'), 'utf8');
// 不仅 ASS：所有旧 id 和选项都保留；两个历史重复外观 id 在新入口规范化。
const ids = text => [...text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
for (const id of new Set(ids(old))) assert.ok(ids(fresh).includes(id), 'missing real control ' + id);
const duplicates = ids(fresh).filter((id, i, all) => all.indexOf(id) !== i);
assert.deepEqual(duplicates, [], 'new UI IDs must be unique');
for (const option of [...old.matchAll(/<option\b[^>]*>[^<]*<\/option>/g)].map(m => m[0])) assert.ok(fresh.includes(option), 'missing option ' + option);
assert.ok(!fresh.includes('data-stp="ass"')); assert.ok(!fresh.includes('data-setting="ass"')); assert.ok(fresh.includes('id="ass-style-preset-import"'));
// Regeneration must preserve the redesigned settings, without writing any output or assets.
const generated = new Map();
const generatorContext = {
  fs: { readFileSync: fs.readFileSync, writeFileSync: (file, contents) => generated.set(file, contents), copyFileSync() {} },
  path, fileURLToPath: () => path.join(root, 'tools/generate-studio.mjs'), console: { log() {} }
};
vm.createContext(generatorContext);
const generator = fs.readFileSync(path.join(root, 'tools/generate-studio.mjs'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', "'generator'");
vm.runInContext(generator, generatorContext);
const regenerated = generated.get(path.join(root, 'editor/studio.html'));
for (const id of new Set(ids(fresh))) assert.ok(ids(regenerated).includes(id), 'regenerator missing control ' + id);
assert.deepEqual(ids(regenerated).filter((id, i, all) => all.indexOf(id) !== i), [], 'regenerated IDs remain unique');
assert.ok(regenerated.includes('id="sf-settings-tab-translate"'));
assert.ok(!regenerated.includes('id="sf-settings-tab-general"'));
assert.ok(regenerated.includes('id="sf-asr-families"'));
assert.ok(regenerated.includes('id="st-scheme-name"'));
for (const [id, icon] of [...fresh.matchAll(/id="sf-settings-tab-([^\"]+)"[^>]*data-ico="([^\"]+)"/g)].map(m => [m[1], m[2]])) {
  const { ico } = await import('../editor/js/icons.js');
  assert.ok(ico(icon), 'registered settings icon ' + id);
}
assert.equal(/SF_DEMO|data\.js|prototypes\/|localStorage/.test(fresh), false);
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/ui-integration-baseline.json')));
const crypto = await import('node:crypto');
for (const file of ['editor/index.html', 'editor/css/style.css', 'editor/css/ui.css', 'editor/js/main.js']) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), baseline.files[file], 'legacy preserved ' + file);
const server = await isolatedServer({ source: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
try {
  async function entry(value) {
    const config = path.join(server.root, 'ui-config.json');
    if (value === null) { if (fs.existsSync(config)) fs.unlinkSync(config); } else fs.writeFileSync(config, value);
    const response = await server.call('/', { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.headers.get('location');
  }
  assert.equal(await entry(null), '/editor/studio.html');
  for (const value of ['{"ui":"new"}', '{}', 'bad-json', '{"ui":"../private"}', 'x'.repeat(17000)]) assert.equal(await entry(value), '/editor/studio.html');
  assert.equal(await entry('{"ui":"legacy"}'), '/editor/index.html');
  assert.equal(await entry('\uFEFF{"ui":"legacy"}'), '/editor/index.html');
  assert.equal((await server.call('/index.html', { redirect: 'manual' })).headers.get('location'), '/editor/index.html');
  for (const name of ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'fonts/NotoSansCJKsc-Regular.otf']) { const f = path.join(server.root, 'editor/vendor', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'test resource'); }
  const seen = new Set(), queue = ['/editor/studio.html', '/editor/index.html'];
  while (queue.length) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    const r = await server.call(url); assert.equal(r.status, 200, url);
    const text = await r.text();
    const refs = url.endsWith('.html') ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]) : [...text.matchAll(/(?:from\s*|import\s*\()?['"]((?:\.{1,2}\/|\/)[^'"\n]+\.js(?:\?[^'"\n]*)?)['"]/g)].map(m => m[1]);
    for (const ref of refs) if (!ref.startsWith('#') && !/^[a-z]+:/i.test(ref)) queue.push(new URL(ref, server.origin + url).pathname);
  }
  for (const ref of ['/editor/js/studio.js', '/editor/js/studio-state.js', '/editor/js/studio-themes.js', '/editor/js/studio-progress.js', '/editor/css/studio.css']) assert.ok(seen.has(ref), ref);
  assert.equal((await server.call('/ui-config.json')).status, 403);
  console.log(`Studio parity: ${new Set(ids(old)).size} real control IDs, ${seen.size} resources, default/legacy/invalid/BOM/config privacy and real-state filters passed`);
} finally { await server.close(); }
