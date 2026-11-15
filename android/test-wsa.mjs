import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect, shell } from './cdp.mjs';

const out = new URL('./out/', import.meta.url);
const client = await connect();
const results = [];
try {
  await client.send('Runtime.enable');
  await client.evaluate(`(() => {
    const receive = window.nativeEvent;
    const requests = new Map(); let sequence = 0;
    window.nativeEvent = (type, data) => {
      receive(type, data);
      if (type === 'response' && requests.has(data.id)) {
        const { resolve, reject } = requests.get(data.id); requests.delete(data.id);
        data.ok ? resolve(data.data) : reject(new Error(data.data));
      }
    };
    window.testRpc = (action, payload = {}) => new Promise((resolve, reject) => {
      const id = 'test-' + ++sequence; requests.set(id, { resolve, reject });
      window.SubFabric.call(id, action, JSON.stringify(payload));
    });
    return true;
  })()`);
  const status = await client.evaluate(`testRpc('status')`);
  assert.equal(status.modelReady, true);
  results.push({ check: 'native model ready', abi: status.abi });
  const list = await client.evaluate(`testRpc('list')`);
  const sample = list.find(project => project.title === 'SubFabric-sample.wav');
  assert.ok(sample, 'Import official test WAV through the Android system picker before running this check');
  const before = await client.evaluate(`testRpc('load', {id:${JSON.stringify(sample.id)}})`);
  assert.equal(before.engine, 'parakeet-tdt-v2-int8');
  assert.match(before.cues.map(cue => cue.lines.join(' ')).join(' '), /don't wish to see it any more/i);
  for (const cue of before.cues) assert.ok(cue.start >= 0 && cue.end > cue.start);
  results.push({ check: 'real Android WAV inference', cues: before.cues.length, duration: Math.max(...before.cues.map(cue => cue.end)) });

  const multi = list.find(project => project.title === 'SubFabric-sample-multichunk.mp4');
  assert.ok(multi, 'Import and recognize the stereo 44.1 kHz MP4 fixture before this check');
  const multiProject = await client.evaluate(`testRpc('load',{id:${JSON.stringify(multi.id)}})`);
  assert.equal(multiProject.cues.length, 6);
  assert.ok(Math.max(...multiProject.cues.map(cue => cue.end)) > 20);
  results.push({ check: 'native MediaCodec + stereo downmix + 44.1 kHz resample + multiple chunks', cues: multiProject.cues.length });
  const cancellation = await client.evaluate(`(async()=>{
    const outcome = testRpc('recognize',{id:${JSON.stringify(sample.id)}}).then(()=>({cancelled:false}),error=>({cancelled:/停止/.test(error.message)}));
    await new Promise(resolve=>setTimeout(resolve,40)); await testRpc('cancel');
    return outcome;
  })()`);
  assert.equal(cancellation.cancelled, true);
  assert.deepEqual((await client.evaluate(`testRpc('load',{id:${JSON.stringify(sample.id)}})`)).cues, before.cues);
  results.push({ check: 'cancel preserves original subtitles', passed: true });

  for (const [name, width, height] of [['tablet', 1024, 705], ['phone', 390, 650], ['small-phone', 320, 650]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const view of ['home', 'editor', 'settings']) {
      await client.evaluate(`document.querySelector('[data-view="${view}"]').click()`);
      await client.evaluate('new Promise(resolve=>setTimeout(resolve,150))');
      const metrics = await client.evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,workspaceColumns:getComputedStyle(document.getElementById('workspace')).gridTemplateColumns,visible:[...document.querySelectorAll('main button,main input,main textarea')].filter(e=>e.getBoundingClientRect().width>0).filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>e.id||e.getAttribute('aria-label'))})`);
      assert.ok(metrics.scrollWidth <= width, `${name}/${view}: page overflow ${JSON.stringify(metrics)}`);
      assert.deepEqual(metrics.visible, [], `${name}/${view}: controls overflow`);
      results.push({ check: `layout ${name}/${view}`, width, columns: metrics.workspaceColumns });
      if (name !== 'small-phone') {
        const capture = await client.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(new URL(`${name}-${view}.png`, out), Buffer.from(capture.data, 'base64'));
      }
    }
  }
  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.evaluate(`document.querySelector('[data-view="editor"]').click()`);
  const editedText = before.cues[0].lines.join('\n') + '\n[WSA save check]';
  await client.evaluate(`(() => { const textarea=document.querySelector('.cue textarea'); textarea.value=${JSON.stringify(editedText)}; textarea.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-view="home"]').click(); return true; })()`);
  await client.evaluate('new Promise(resolve=>setTimeout(resolve,700))');
  const after = await client.evaluate(`testRpc('load', {id:${JSON.stringify(sample.id)}})`);
  assert.equal(after.cues[0].lines.join('\n'), editedText);
  results.push({ check: 'edit + navigation flush + native disk reload', passed: true });
  // Restore only the temporary test sample to its actual ASR output.
  await client.evaluate(`testRpc('save', ${JSON.stringify({ id: sample.id, title: before.title, cues: before.cues })})`);
  await client.evaluate(`new Promise(resolve=>{const card=[...document.querySelectorAll('.project-card')].find(e=>e.textContent.includes('SubFabric-sample.wav')); card.click(); setTimeout(resolve,300)})`);
  const serialized = await client.evaluate(`import('./shared/srt.js').then(m=>m.serializeSRT(${JSON.stringify(before.cues)}))`);
  assert.match(serialized, /-->/);
  await fs.writeFile(new URL('recognized.srt', out), serialized);
  results.push({ check: 'SRT serializer on actual recognized cues', passed: true });
  await fs.writeFile(new URL('wsa-results.json', out), JSON.stringify({ results, limitations: ['Phone dimensions are applied to the actual Android WebView through CDP, not physical phone hardware.', 'Real file picker import was exercised separately.', 'Native export picker is checked separately.'] }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  client.close();
}
