// Exercise production event handlers with deterministic media events and clocks.
// No GPU, user video, service or model is needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../editor/js/' + name, import.meta.url), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'production handler boundaries exist');
  return source.slice(a, b);
}
function clock() {
  let now = 0, id = 0;
  const timers = new Map(), frames = new Map();
  return {
    performance: { now: () => now },
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    frame() { const jobs = [...frames.values()]; frames.clear(); jobs.forEach(fn => fn(now)); },
    advance(ms) {
      now += ms;
      for (const [key, job] of [...timers]) if (job.at <= now) { timers.delete(key); job.fn(); }
    },
  };
}
class Media extends EventTarget {
  constructor() {
    super(); Object.assign(this, { paused: true, ended: false, seeking: false,
      duration: 300, currentSrc: 'fixture.webm', currentTime: 0, readyState: 4, buffered: { length: 1 } });
  }
  fire(type) { this.dispatchEvent(new Event(type)); }
}
const studio = read('studio.js');
{
  const video = new Media(), time = clock(), document = { body: { dataset: {} } };
  vm.runInNewContext(between(studio, 'let mediaBusyTimer = 0;', "$('sf-play').addEventListener('click'"), { video, document, ...time });
  video.paused = false; video.fire('play');
  assert.equal(document.body.dataset.mediaActive, 'true', 'freeze background at play intent, before playing');
  video.seeking = true; video.fire('seeking');
  video.seeking = false; video.fire('seeked'); time.advance(300);
  assert.equal(document.body.dataset.mediaActive, 'true', 'seeked during playback must not restart fastest aurora');
  video.paused = true; video.fire('pause'); time.advance(200);
  assert.equal(document.body.dataset.mediaActive, 'true', 'settle before restarting aurora');
  video.fire('play'); video.paused = false; time.advance(300);
  assert.equal(document.body.dataset.mediaActive, 'true', 'rapid pause/play cannot release background');
  video.paused = true; video.seeking = true; video.fire('pause'); time.advance(300);
  assert.equal(document.body.dataset.mediaActive, 'true', 'paused seek still keeps background frozen');
  video.seeking = false; video.fire('seeked'); time.advance(300);
  assert.equal(document.body.dataset.mediaActive, 'false', 'paused seek restores chosen aurora after settling');
}
{
  const video = new Media(), time = clock(), window = {}, writes = [];
  const source = between(read('main.js'), 'let previewSeekT = null;', 'window.__sfSeek = requestSeek;')
    + '\nwindow.seek = requestSeek;';
  const descriptor = { get: () => video._t || 0, set: t => { video._t = t; writes.push(t); video.seeking = true; } };
  Object.defineProperty(video, 'currentTime', descriptor);
  vm.runInNewContext(source, { video, window, assPlayer: { seek() {} }, ...time });
  window.seek(10); window.seek(20); time.frame();
  assert.deepEqual(writes, [20], 'coalesce a burst into one media seek');
  window.seek(30); window.seek(40); time.frame();
  assert.equal(writes.length, 1, 'inflight seek is not repeatedly canceled');
  video.seeking = false; video.fire('seeked'); time.frame();
  assert.deepEqual(writes, [20, 40], 'seeked issues only the latest queued target');
  video.fire('emptied'); video.seeking = false; video._t = 0;
  video.readyState = 0; video.buffered.length = 0;
  window.seek(60); time.frame();
  assert.equal(writes.length, 2, 'cold video warms up first');
  time.advance(1200); time.frame();
  assert.deepEqual(writes, [20, 40, 60], 'warmup timeout really issues seek instead of warming up forever');
  video.fire('emptied'); video.seeking = false; video._t = 0;
  window.seek(80); time.frame(); video.fire('emptied');
  time.advance(5000); time.frame();
  assert.equal(writes.length, 3, 'changing source cancels queued warmup');
}
{
  let now = 0, draws = 0;
  const method = between(read('timeline.js'), '  drawIfNeeded(t, playing) {', '\n  draw(t, playing) {');
  const draw = vm.runInNewContext('({' + method + '}).drawIfNeeded', {
    performance: { now: () => now }, BLOCK_ENTER_WINDOW: 2000,
  });
  const state = { _lastT: 0, _lastDrawAt: 0, _dirty: false,
    draw(t) { draws++; this._lastT = t; this._lastDrawAt = now; this._dirty = false; } };
  for (let i = 1; i <= 120; i++) { now = i * 1000 / 120; draw.call(state, now / 1000, true); }
  assert.ok(draws >= 24 && draws <= 30, `120Hz playback uses at most 30 timeline redraws: ${draws}`);
  const count = draws;
  for (let i = 0; i < 120; i++) { now += 8; draw.call(state, state._lastT, true); }
  assert.equal(draws, count, 'stalled media does not continuously redraw timeline');
  state._dirty = true; draw.call(state, state._lastT, true);
  assert.equal(draws, count + 1, 'editing bypasses playback throttle');
  draw.call(state, 200, true);
  assert.equal(draws, count + 2, 'seek target is drawn immediately');
  draw.call(state, 201, false);
  assert.equal(draws, count + 3, 'paused seek is drawn immediately');
  state._blockEnterArmed = true; state._blockEnterAt = now;
  draw.call(state, 201, true);
  assert.equal(draws, count + 4, 'entrance animation keeps its original cadence');
}
{
  const video = new Media(), nodes = new Map();
  let icons = 0, texts = 0;
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, setAttribute() {},
      get textContent() { return this.text || ''; }, set textContent(v) { texts++; this.text = v; },
      set innerHTML(v) { icons++; this.html = v; } });
    return nodes.get(id);
  };
  const ctx = { video, $, scrubbing: false, requestedTime: null, seekRange: {}, seekBar: {},
    window: { SF_PROGRESS: { set() {} } }, t: x => x, ico: () => '<svg/>',
    fmtTime: n => new Date(n * 1000).toISOString().slice(11, 19) };
  vm.runInNewContext(between(studio, 'let playerActive = null;', "for (const event of ['timeupdate'" ) + '\nthis.sync = syncPlayer;', ctx);
  ctx.sync(); const firstTexts = texts;
  for (let i = 0; i < 100; i++) ctx.sync();
  assert.equal(icons, 1, 'unchanged playback state keeps the same SVG nodes');
  assert.equal(texts, firstTexts, 'unchanged times do not trigger text mutations');
  video.paused = false; ctx.sync();
  assert.equal(icons, 2, 'playing transition updates button once');
  video.currentTime = 2; ctx.sync();
  assert.equal(icons, 2, 'timeupdate does not replace playing icon');
  assert.equal($('sf-play-time').textContent, '00:00:02', 'visible clock still advances');
}
console.log('editor-playback-load: aurora lifecycle, bounded cold seek, coalescing, timeline redraw budget and stable player DOM passed');
