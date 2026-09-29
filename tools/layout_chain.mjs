/* 量 #video-stage 的祖先链: 谁没把高度撑开 */
import { launch, sleep } from './lib/cdp.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:8321';
const proj = (await (await fetch(BASE + '/api/projects')).json()).projects.find(p => !p.draft) || (await (await fetch(BASE + '/api/projects')).json()).projects[0];

const b = await launch({ port: 9411, width: 1440, height: 900 });
await b.goto(BASE + '/#/project/' + proj.id);
await sleep(4500);
const out = await b.eval(`(() => {
  const st = document.getElementById('video-stage');
  const v = document.querySelector('video');
  const chain = [];
  for (let el = st; el && el.id !== 'app'; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    chain.push({
      el: (el.id ? '#' + el.id : '.' + (el.className || '').toString().split(' ')[0]),
      h: Math.round(r.height), w: Math.round(r.width),
      display: cs.display, position: cs.position, height: cs.height, minHeight: cs.minHeight,
      flex: cs.flex, align: cs.alignItems, overflow: cs.overflow,
    });
  }
  const csV = v ? getComputedStyle(v) : null;
  const rV = v ? v.getBoundingClientRect() : null;
  return JSON.stringify({
    chain,
    video: v ? { w: Math.round(rV.width), h: Math.round(rV.height), videoW: v.videoWidth, videoH: v.videoHeight, readyState: v.readyState, cssH: csV.height, cssMaxH: csV.maxHeight, cssMaxW: csV.maxWidth, objectFit: csV.objectFit } : null,
    panelRows: getComputedStyle(document.getElementById('app')).gridTemplateRows,
    tlVar: getComputedStyle(document.getElementById('app')).getPropertyValue('--tl-h').trim(),
  }, null, 1);
})()`);
console.log(out);
b.close();
