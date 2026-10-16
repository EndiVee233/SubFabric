// 仅本轮 UI 增量；安装版保留其他源码差异，不调用整体 build/install。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.resolve(source, '..');
const backups = path.resolve(installed, '..', 'update-backups');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const added = ['editor/studio.html', 'editor/css/studio.css', 'editor/themes/windows-uwp.theme.json', ...['studio', 'studio-state', 'studio-themes', 'studio-progress'].map(n => `editor/js/${n}.js`), 'ui-config.example.json'];
const changed = ['editor/server.js', 'editor/js/project.js', 'editor/js/timeline.js', 'editor/lang/zh-CN.json'];
function replace(text, before, after, count = 1) {
  if (text.split(before).length - 1 !== count) throw Error('Installation baseline mismatch: ' + before.slice(0, 80));
  return text.split(before).join(after);
}
function block(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error('Missing source boundary');
  return text.slice(a, b);
}
export function patchedProject(original) {
  const current = read(source, 'editor/js/project.js');
  let text = replace(original, '  const $ = (s) => document.querySelector(s);', '  const $ = (s) => document.querySelector(s);\n  const studioUI = document.body?.classList?.contains(\'sf-studio\') === true;');
  text = replace(text, '    if (settingsOpenedFromApp) history.back();', '    if (studioUI) replaceRoute(settingsReturnRoute);\n    else if (settingsOpenedFromApp) history.back();');
  text = replace(text, '    // 有任务在跑就自动刷新, 让列表上的进度自己往前走', '    if (studioUI) window.__sfStudio?.projects(ps);\n\n    // 有任务在跑就自动刷新, 让列表上的进度自己往前走');
  const oldSave = "      if (location.hash === '#/settings' && settingsVisit === visit) setTimeout(() => {\n        if (location.hash === '#/settings' && settingsVisit === visit) returnFromSettings();\n      }, 600);";
  text = replace(text, oldSave, block(current, '      const settingsRoute = location.hash;', '    } catch (e) {').trimEnd());
  text = replace(text, "else if (location.hash === '#/settings' && !$('#st-save').disabled)", "else if ((location.hash === '#/settings' || studioUI && location.hash === '#/resources') && !$('#st-save').disabled)");
  return replace(text, block(text, '  function applyHash() {', "  window.addEventListener('hashchange', applyHash);"), block(current, '  function applyHash() {', "  window.addEventListener('hashchange', applyHash);"));
}
export function patchedTimeline(original) {
  const current = read(source, 'editor/js/timeline.js');
  const anchor = '    /* 主题色上该用的前景色';
  let text = replace(original, "    this.accent = cssVar('--accent', C.accent);\n" + anchor, block(current, "    this.accent = cssVar('--accent', C.accent);", anchor) + anchor);
  for (const name of ['bg', 'ruler', 'filmBg', 'filmBorder', 'laneBorder', 'rulerTick', 'waveBg', 'laneBg']) {
    text = text.replace(new RegExp('(ctx\\.(?:fillStyle|strokeStyle) = )C\\.' + name + '\\b', 'g'), '$1this.colors.' + name);
  }
  text = replace(text, "g.addColorStop(0, '#16161c');", 'g.addColorStop(0, this.colors.rulerBg0);');
  text = replace(text, "g.addColorStop(1, '#101015');", 'g.addColorStop(1, this.colors.rulerBg1);');
  const before = "    const canBlur = typeof ctx.filter === 'string';\n    if (canBlur) ctx.filter = 'blur(3px)';";
  return replace(text, before, block(current, "    const studio = document.body?.classList?.contains('sf-studio');", '    this._drawWaveLayer(ctx, W, top, h);').trimEnd());
}
export function patchedServer(original) {
  const current = read(source, 'editor/server.js');
  const select = block(current, '// 界面选择独立于识别/密钥配置。', '/* ── 控制台输出同时落一份到文件');
  let text = replace(original, "const ROOT = path.resolve(__dirname, '..'); // D:\\subtitle\n", "const ROOT = path.resolve(__dirname, '..'); // D:\\subtitle\n\n" + select);
  text = replace(text, "{ Location: '/editor/index.html' }", "{ Location: uiEntry(), 'Cache-Control': 'no-store' }", 2);
  return replace(text, "  if (!filePath) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');", "  if (!filePath || path.resolve(filePath).toLowerCase() === path.join(ROOT, 'ui-config.json').toLowerCase()) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');");
}
function fileHashes(root) {
  const result = {};
  function walk(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw Error('Links not allowed in UI deployment');
      const next = path.posix.join(rel, e.name), full = path.join(dir, e.name);
      if (e.name === 'vendor') continue;
      if (e.isDirectory()) walk(full, next); else result[next] = hash(fs.readFileSync(full));
    }
  }
  walk(path.join(root, 'editor'), 'editor');
  for (const rel of ['SubFabric.exe', 'ui-config.json', 'ui-config.example.json', 'asr/settings.json']) if (fs.existsSync(path.join(root, rel))) result[rel] = hash(fs.readFileSync(path.join(root, rel)));
  const projects = path.join(root, 'projects');
  if (fs.existsSync(projects)) for (const id of fs.readdirSync(projects)) for (const name of ['project.json', 'subtitle.ass', 'subtitle.srt']) {
    const rel = `projects/${id}/${name}`, full = path.join(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) result[rel] = hash(fs.readFileSync(full));
  }
  return result;
}
export function prepare() {
  fs.mkdirSync(backups, { recursive: true });
  const keep = fs.mkdtempSync(path.join(backups, 'ui-wiring-20261013-'));
  const candidate = path.join(keep, 'candidate');
  fs.mkdirSync(candidate);
  fs.cpSync(path.join(installed, 'editor'), path.join(candidate, 'editor'), { recursive: true, filter: p => !/[\\/]vendor([\\/]|$)/.test(p) });
  const outputs = {
    'editor/server.js': patchedServer(read(installed, 'editor/server.js')),
    'editor/js/project.js': patchedProject(read(installed, 'editor/js/project.js')),
    'editor/js/timeline.js': patchedTimeline(read(installed, 'editor/js/timeline.js')),
    'editor/lang/zh-CN.json': JSON.stringify({ ...JSON.parse(read(source, 'editor/lang/zh-CN.json')), ...JSON.parse(read(installed, 'editor/lang/zh-CN.json')) }, null, 2) + '\n'
  };
  if (!fs.existsSync(path.join(installed, 'ui-config.json'))) outputs['ui-config.json'] = '{"ui":"new"}\n';
  const files = [...Object.keys(outputs), ...added];
  for (const [rel, text] of Object.entries(outputs)) fs.writeFileSync(path.join(candidate, rel), text);
  for (const rel of added) { fs.mkdirSync(path.dirname(path.join(candidate, rel)), { recursive: true }); fs.copyFileSync(path.join(source, rel), path.join(candidate, rel)); }
  for (const rel of [...changed, ...added].filter(n => n.endsWith('.js'))) {
    const check = spawnSync(process.execPath, ['--check', path.join(candidate, rel)], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0) throw Error(check.stderr);
  }
  const before = fileHashes(installed), expected = Object.fromEntries(files.map(rel => [rel, hash(fs.readFileSync(path.join(candidate, rel)))]));
  fs.writeFileSync(path.join(keep, 'manifest.json'), JSON.stringify({ installed, candidate, before, expected, status: 'prepared' }, null, 2));
  return { keep, candidate, files };
}
export function apply(keep) {
  keep = path.resolve(keep);
  if (!keep.startsWith(backups + path.sep)) throw Error('Invalid backup path');
  const manifestPath = path.join(keep, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath));
  if (m.installed !== installed || m.candidate !== path.join(keep, 'candidate') || m.status !== 'prepared') throw Error('Invalid deployment manifest');
  const latest = fileHashes(installed);
  for (const rel of Object.keys(m.expected)) if (![...changed, ...added, 'ui-config.json'].includes(rel)) throw Error('Unexpected deployment file');
  for (const [rel, expected] of Object.entries(m.before)) if (latest[rel] !== expected) throw Error('Concurrent installation/data change: ' + rel);
  const lockPath = path.join(installed, '.subfabric-ui-update.lock'), lock = fs.openSync(lockPath, 'wx');
  const applied = [];
  try {
    for (const [rel, expected] of Object.entries(m.expected)) {
      const src = path.join(m.candidate, rel), dest = path.join(installed, rel), backup = path.join(keep, 'original', rel);
      if (hash(fs.readFileSync(src)) !== expected || fs.existsSync(dest) && !m.before[rel]) throw Error('Candidate or destination changed: ' + rel);
      if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(dest, backup); }
      fs.copyFileSync(src, dest + '.ui-next');
      fs.renameSync(dest + '.ui-next', dest);
      applied.push(rel);
    }
    const after = fileHashes(installed);
    for (const [rel, expected] of Object.entries({ ...m.before, ...m.expected })) if (after[rel] !== expected) throw Error('Installed verification mismatch: ' + rel);
    m.status = 'installed'; fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  } catch (e) {
    for (const rel of applied.reverse()) {
      const dest = path.join(installed, rel);
      if (m.before[rel]) fs.copyFileSync(path.join(keep, 'original', rel), dest); else fs.unlinkSync(dest);
    }
    throw e;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  return { installed, keep, count: applied.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--prepare') console.log(JSON.stringify(prepare()));
  else if (process.argv[2] === '--apply' && process.argv[3]) console.log(JSON.stringify(apply(process.argv[3])));
  else throw Error('Use --prepare, then validate the candidate before --apply <backup-directory>.');
}
