/* 回归测试：导入项目包不得造成「任意文件写入」。
 *
 * 背景（2026-10-11 第三轮审查 新-1，已实测复现）：
 *   旧 remapMeta 是 `Object.assign({}, meta)` 整体拷贝，只覆写 id/时间戳/video/prepare，
 *   于是包里 project.json 的 `subtitle.file` 被**原样保留**；随后
 *   `POST /api/projects/:id/subtitle` 执行 `path.join(projDir(id), meta.subtitle.file)`
 *   就把请求体写到了项目目录之外 —— 实测把内容写进了 K:\SubFabric\poc-proof.txt。
 *
 * 本测试钉死两件事：
 *   ① remapMeta 的输出**只包含白名单字段**，且任何路径类字段都不得越界；
 *   ② 输出里**不存在**任何指向项目目录之外的字符串（对全对象做深度扫描）。
 *
 * 运行：node tests/project-pack-safety-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pack = require('../editor/project-pack.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ★ ' + name); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ★ ' + name + '\n      得到 ' + g + '\n      期望 ' + w); }
}

const NOW = '2026-10-11T00:00:00.000Z';
const NEW_ID = 'p-test-0001';
const remap = (m) => pack.remapMeta(m, NEW_ID, NOW);

/** 深度扫描：对象里是否出现"逃出项目目录"的路径特征。 */
function hasEscape(obj) {
  const bad = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const s = v.replace(/\\/g, '/');
      if (s.includes('..') || /^[A-Za-z]:\//.test(s) || s.startsWith('/')) bad.push(path + ' = ' + v);
      return;
    }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
  };
  walk(obj, '$');
  return bad;
}

console.log('\n【1】正常包：合法字段照常带过来');
{
  const m = remap({
    id: 'attacker-chosen-id', name: '我的稿子', nameCustomized: true,
    createdAt: '2000-01-01', modifiedAt: '2000-01-01',
    video: { path: 'C:\\Users\\x\\secret.mp4', name: 'movie.mp4' },
    subtitle: { format: 'ass', file: 'subtitle.ass', name: 'subtitle.ass' },
    kar: { wordStyle: 'Karaoke' },
    audio: { mode: 'denoise', file: 'audio.wav' },
    region: { start: 3, end: 10 },
    autoPost: true,
  });
  eq('id 被换成新 id', m.id, NEW_ID);
  eq('时间戳被换成 now', m.createdAt, NOW);
  eq('字幕文件保留', m.subtitle, { format: 'ass', file: 'subtitle.ass', name: 'subtitle.ass' });
  eq('video.path 被清空', m.video.path, '');
  eq('video.name 保留', m.video.name, 'movie.mp4');
  eq('kar.wordStyle 保留（项目级选择）', m.kar, { wordStyle: 'Karaoke' });
  eq('audio.mode 保留、audio.file 不带', m.audio, { mode: 'denoise' });
  eq('region 保留', m.region, { start: 3, end: 10, importedAt: NOW });
  eq('autoPost 保留', m.autoPost, true);
  eq('prepare 重置', m.prepare, { status: 'none' });
}

console.log('\n【2】★ 原漏洞 payload：subtitle.file 指向项目目录之外 → 必须被丢弃');
{
  for (const evil of ['../../poc-proof.txt', '..\\..\\poc-proof.txt',
    '../../../asr/settings.json', 'C:\\Windows\\Temp\\x.ass', '/etc/passwd',
    'sub/../x.ass', 'evil.ass', '..']) {
    const m = remap({ subtitle: { format: 'ass', file: evil } });
    ok('拒绝 subtitle.file = ' + JSON.stringify(evil) + '（整个 subtitle 字段被丢弃）', m.subtitle === undefined);
  }
}

console.log('\n【3】srt / ass 两种合法字幕文件名都接受，format 由文件名推导');
{
  eq('subtitle.srt', remap({ subtitle: { file: 'subtitle.srt' } }).subtitle,
    { format: 'srt', file: 'subtitle.srt', name: 'subtitle.srt' });
  eq('subtitle.ass（format 谎报 srt 也以文件名为准）',
    remap({ subtitle: { format: 'srt', file: 'subtitle.ass' } }).subtitle,
    { format: 'ass', file: 'subtitle.ass', name: 'subtitle.ass' });
}

console.log('\n【4】其它路径字段同样被挡：peaks.file / audio.file 一律不带过来');
{
  const m = remap({
    peaks: { file: '../../x.bin', ver: 3, rate: 100 },
    audio: { mode: 'raw', file: '../../x.wav' },
  });
  ok('peaks 整个不带过来（派生数据 + 路径字段）', m.peaks === undefined);
  eq('audio 只带 mode，不带 file', m.audio, { mode: 'raw' });
  const m2 = remap({ audio: { mode: '../../evil' } });
  ok('非法的 audio.mode 被丢弃', m2.audio === undefined);
}

console.log('\n【5】流水线中间态与来源信息不带过来');
{
  const m = remap({ draft: { status: 'running' }, source: { url: 'http://x' }, duration: 999 });
  ok('draft 不带过来', m.draft === undefined);
  ok('source 不带过来', m.source === undefined);
  ok('未知字段（duration）不带过来', m.duration === undefined);
}

console.log('\n【6】结构不变量：输出只含白名单字段，且不存在任何越界字符串');
{
  const ALLOWED = new Set(['id', 'name', 'nameCustomized', 'createdAt', 'modifiedAt',
    'video', 'prepare', 'imported', 'subtitle', 'kar', 'audio', 'region', 'autoPost']);
  const nasty = {
    id: 'x', name: 'n', subtitle: { file: '../../evil.ass' },
    video: { path: '../../evil.mp4', name: 'n' }, peaks: { file: '../../evil.bin' },
    audio: { mode: 'raw', file: '../../evil.wav' }, draft: { status: 'running' },
    source: { url: 'x' }, evil: '../../evil', nested: { deep: '../../../evil' },
  };
  const m = remap(nasty);
  const extra = Object.keys(m).filter(k => !ALLOWED.has(k));
  ok('没有白名单之外的顶层字段' + (extra.length ? '（多出 ' + extra.join(',') + '）' : ''), extra.length === 0);
  const esc = hasEscape(m);
  ok('深度扫描：对象里没有任何越界路径' + (esc.length ? '（' + esc.join('; ') + '）' : ''), esc.length === 0);
}

console.log('\n【7】safeInnerFile 单测');
{
  eq('白名单内返回原值', pack.safeInnerFile('subtitle.ass', pack.SUBTITLE_FILES), 'subtitle.ass');
  eq('带目录分隔符 → null', pack.safeInnerFile('a/subtitle.ass', pack.SUBTITLE_FILES), null);
  eq('反斜杠分隔符 → null', pack.safeInnerFile('a\\subtitle.ass', pack.SUBTITLE_FILES), null);
  eq('.. → null', pack.safeInnerFile('..', pack.SUBTITLE_FILES), null);
  eq('不在白名单 → null', pack.safeInnerFile('x.ass', pack.SUBTITLE_FILES), null);
  eq('空 → null', pack.safeInnerFile('', pack.SUBTITLE_FILES), null);
  eq('undefined → null', pack.safeInnerFile(undefined, pack.SUBTITLE_FILES), null);
}

console.log('\n' + (fail ? '★ ' : '') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
