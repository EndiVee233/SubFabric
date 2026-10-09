/* 最贴合的复现：**重载管线** = 读 ASS → analyzeKaraoke → pairRows。
 *
 * 做法：用**真实项目的基线字幕**，把"当前代码导入一条后会写成什么样"的那几行插进去，
 * 再走一遍重载管线，看会不会出现「中文行装英文 / 词行变空」。
 * 这比在浏览器里点来点去更接近本质，也更容易定位。
 */
'use strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'editor');
const JSMOD = path.join(HERE, 'jsmod');
function ensureJsmod() {
  const marker = path.join(JSMOD, 'package.json');
  let stale = !fs.existsSync(marker);
  if (!stale) for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const a = path.join(JSMOD, f), b = path.join(SRC, f);
    if (!fs.existsSync(a) || fs.statSync(a).mtimeMs < fs.statSync(b).mtimeMs) { stale = true; break; }
  }
  if (stale) {
    fs.rmSync(JSMOD, { recursive: true, force: true }); fs.mkdirSync(JSMOD, { recursive: true });
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(JSMOD, f));
    fs.writeFileSync(marker, '{"type":"module"}\n');
  }
}
ensureJsmod();

const K = await import('./jsmod/karaoke.js');
const { AssDoc } = await import('./jsmod/ass.js');
const { analyzeKaraoke, pairRows, recalcWords, buildWordSpecs, setWordHighlightColor } = K;

let pass = 0, fail = 0;
const ok = (c, n, extra) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra != null ? ' :: ' + JSON.stringify(extra) : '')); }
};

const BASELINE = 'C:/Users/Terry/Documents/deepseek-harness/default-workspace/.staging/recover-tmp/subtitle.ass';

/** 统计一组 row（pairRows 的产物）里的坏法 */
function audit(rows, label) {
  const blank = rows.filter(r => r.en && !r.en.text && !r.en.words.length);
  const enInZh = rows.filter(r => r.zh && !r.zh.words.length
    && /^[A-Za-z]/.test((r.zh.text || '').trim()) && !/[\u3400-\u9fff]/.test(r.zh.text || ''));
  const zhBlank = rows.filter(r => r.zh && !(r.zh.text || '').trim() && !r.zh.words.length);
  console.log('  [%s] 行 %d  空词行 %d  中文行装英文 %d  空中文行 %d',
    label, rows.length, blank.length, enInZh.length, zhBlank.length);
  return { blank, enInZh, zhBlank };
}

console.log('== 重载基线字幕（对照组，应无任何坏行）==');
{
  const text = fs.readFileSync(BASELINE, 'utf8');
  const doc = new AssDoc(text);
  setWordHighlightColor('#00ff00');
  const kar = analyzeKaraoke(doc);
  const rows = pairRows(kar.sentences, kar.wordStyle);
  const a = audit(rows, '基线');
  ok(a.blank.length === 0, '没有空词行', a.blank.length);
  ok(a.enInZh.length === 0, '没有"中文行装英文"', a.enInZh.length);
}

console.log('\n== 把"导入一行"写进 ASS 后再走重载管线 ==');
{
  const text = fs.readFileSync(BASELINE, 'utf8');
  const doc = new AssDoc(text);
  setWordHighlightColor('#00ff00');

  // 模拟 addRecognizedRow 的产物：中文样式 + 英文逐词样式，两条同起止
  const zhStyle = '中文字幕', enStyle = 'Default';
  const S = 1042.5, E = 1045.0;
  const zhAnchor = doc.sorted.filter(e => e.style === zhStyle).pop();
  const enAnchor = doc.sorted.filter(e => e.style === enStyle).pop();
  const zhEv = doc.insertAfterEvent(zhAnchor);
  doc.setEventTime(zhEv, S, E);
  doc.setEventText(zhEv, '导入的中文一');
  const enEv = doc.insertAfterEvent(enAnchor);
  doc.setEventTime(enEv, S, E);
  doc.setEventText(enEv, 'first imported words');

  // 再按 addRecognizedRow 的做法给英文铺逐词
  const kar1 = analyzeKaraoke(doc);
  const enSent = kar1.sentences.find(s => s.events[0] === enEv);
  ok(!!enSent, '新加的英文事件能被 analyzeKaraoke 认出');
  if (enSent) {
    enSent.words = recalcWords(enSent, enSent.text, S, E);
    ok(enSent.words.length === 3, 'recalcWords 给出 3 个词片', enSent.words.length);
    doc.replaceEvents(enSent.events, buildWordSpecs(enSent));
  }

  // ★ 重载：用改动后的 ASS 重新走一遍管线（这就是保存后重新打开发生的事）
  const text2 = doc.serialize();
  const doc2 = new AssDoc(text2);
  const kar2 = analyzeKaraoke(doc2);
  const rows2 = pairRows(kar2.sentences, kar2.wordStyle);
  const a = audit(rows2, '导入后重载');
  ok(a.blank.length === 0, '★ 没有空词行', a.blank.length);
  ok(a.enInZh.length === 0, '★ 没有"中文行装英文"', a.enInZh.length);

  // 找导入的那一行，核对内容
  const imported = rows2.filter(r => r.start >= S - 0.01 && r.end <= E + 0.01
    && ((r.zh && /导入的中文一/.test(r.zh.text)) || (r.en && /first imported/.test(r.en.text))));
  console.log('    找到导入的行 %d 条:', imported.length);
  for (const r of imported) {
    console.log('      zh=%s  en=%s  enWords=%d',
      r.zh ? JSON.stringify(r.zh.text.slice(0, 20)) : 'null',
      r.en ? JSON.stringify(r.en.text.slice(0, 30)) : 'null',
      r.en ? r.en.words.length : 0);
  }
  const withBoth = imported.find(r => r.zh && r.en);
  ok(!!withBoth, '★ 导入的那一行中英配在一起', imported.length);
  ok(withBoth && withBoth.zh.text === '导入的中文一', '中文正确', withBoth && withBoth.zh.text);
  ok(withBoth && withBoth.en.text === 'first imported words', '英文正确', withBoth && withBoth.en.text);
  ok(withBoth && withBoth.en.words.length === 3, '英文有 3 个词片（逐词格式在）',
    withBoth && withBoth.en.words.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
