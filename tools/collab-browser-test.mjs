import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isolatedServer } from '../tests/helpers/isolated-server.mjs';
import { launch } from './lib/cdp.mjs';
const id = 'p-collab-browser';
const assId = 'p-collab-browser-ass';
const fixtureAss = fs.readFileSync(new URL('../tests/fixture.ass', import.meta.url), 'utf8');
const studio = await isolatedServer({ prepare(root) {
  const dir = path.join(root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name: '本机协作校对验证', duration: 9,
    subtitle: { format: 'srt', file: 'subtitle.srt', name: 'fixture.srt' } }));
  fs.writeFileSync(path.join(dir, 'subtitle.srt'), '1\r\n00:00:01,000 --> 00:00:02,000\r\n第一句\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n第二句\r\n');
  const assDir = path.join(root, 'projects', assId);
  fs.mkdirSync(assDir, { recursive: true });
  fs.writeFileSync(path.join(assDir, 'subtitle.ass'), fixtureAss);
  fs.writeFileSync(path.join(assDir, 'project.json'), JSON.stringify({ id: assId, name: '逐词协作校对验证', duration: 120,
    subtitle: { format: 'ass', file: 'subtitle.ass', name: 'fixture.ass' } }));

}});
async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
const click = (b, selector) => b.eval('document.querySelector(' + JSON.stringify(selector) + ').click()');
let host, guest;
try {
  host = await launch({ port: await port(), width: 1280, height: 820 });
  await host.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('sf-welcome-v1',JSON.stringify({done:true,vulkan:true}));" });
  await host.goto(studio.origin + '/#/project/' + id);
  await host.waitFor('!document.querySelector("#btn-collab")?.hidden && document.querySelector("#btn-collab")?.checkVisibility()');
  await click(host, '#btn-collab');
  await host.waitFor('document.querySelector("#collab-launch").open');
  const links = await host.eval('[document.querySelector("#collab-host-link").href,document.querySelector("#collab-invite-link").value]');
  assert.ok(links.every(url => url.startsWith('http://127.0.0.1:')));
  await host.goto(links[0]);
  guest = await launch({ port: await port(), width: 1000, height: 800 });
  await guest.goto(links[1]);
  await host.waitFor('document.querySelector("#connection").textContent.includes("主机")');
  await guest.waitFor('document.querySelector("#connection").textContent.includes("成员")');
  assert.equal(await guest.eval('location.hash'), '');
  await click(host, 'button[data-id="1"]');
  await host.waitFor('!document.querySelector("#fields").disabled');
  await click(guest, 'button[data-id="1"]');
  await guest.waitFor('document.querySelector("#message").textContent.includes("另一位成员")');
  await click(guest, 'button[data-id="2"]');
  await guest.waitFor('!document.querySelector("#fields").disabled && document.querySelector("#body").value === "第二句"');
  await host.eval('document.querySelector("#body").value="主机已校对"; document.querySelector("#body").dispatchEvent(new Event("input",{bubbles:true}));');
  await click(host, '#save');
  await guest.waitFor('document.querySelector(\'button[data-id="1"]\').textContent.includes("主机已校对")');
  await guest.eval('document.querySelector("#mode").value="time";document.querySelector("#mode").dispatchEvent(new Event("change")); document.querySelector("#start").value=6;document.querySelector("#end").value=7;document.querySelector("#end").dispatchEvent(new Event("input",{bubbles:true}));');
  await click(guest, '#save');
  await host.waitFor('document.querySelector(\'button[data-id="2"]\').textContent.includes("6.00 – 7.00")');
  await guest.eval('document.querySelector("#mode").value="text";document.querySelector("#mode").dispatchEvent(new Event("change"));document.querySelector("#body").value="待恢复输入";document.querySelector("#body").dispatchEvent(new Event("input",{bubbles:true}));');
  assert.equal(await guest.eval('JSON.parse(sessionStorage.getItem("sf-room-recovery")).draft.text'), '待恢复输入');
  await click(host, '#exit');
  await guest.waitFor('document.querySelector("#connection").textContent.includes("房间已结束")');
  assert.equal(await guest.eval('document.querySelector("#body").value'), '待恢复输入');
  assert.equal(await guest.eval('document.querySelector("#download").hidden'), false);
  const saved=fs.readFileSync(path.join(studio.root, 'projects',id,'subtitle.srt'),'utf8');
  assert.match(saved,/主机已校对/);
  assert.match(saved,/00:00:06,000 --> 00:00:07,000/);
  assert.doesNotMatch(saved,/待恢复输入/);
  await host.goto(studio.origin + '/#/project/' + assId);
  await host.waitFor('!document.querySelector("#btn-collab")?.hidden && document.querySelector("#btn-collab")?.checkVisibility()');
  await click(host, '#btn-collab');
  await host.waitFor('document.querySelector("#collab-launch").open');
  const assLinks = await host.eval('[document.querySelector("#collab-host-link").href,document.querySelector("#collab-invite-link").value]');
  await host.goto(assLinks[0]);
  await guest.goto(assLinks[1]);
  await host.waitFor('document.querySelector("#connection").textContent.includes("主机")');
  await guest.waitFor('document.querySelector("#connection").textContent.includes("成员")');
  const selector = 'button[data-id="' + await guest.eval(
    'Array.from(document.querySelectorAll("#cues button")).find(button=>button.textContent.includes("row1 alpha beta gamma")).dataset.id') + '"]';
  await click(guest, selector);
  await guest.waitFor('!document.querySelector("#fields").disabled && document.querySelector("#word").options.length >= 4');
  await guest.eval('document.querySelector("#mode").value="word";document.querySelector("#mode").dispatchEvent(new Event("change"));document.querySelector("#edge").value="word-end";document.querySelector("#edge").dispatchEvent(new Event("change"));');
  const wordEnd = await guest.eval('Number(document.querySelector("#word-time").value)');
  const revised = Number((wordEnd - 0.1).toFixed(2));
  await guest.eval('document.querySelector("#word-time").value=' + revised +
    ';document.querySelector("#word-time").dispatchEvent(new Event("input",{bubbles:true}));');
  await click(guest, '#save');
  await host.waitFor('document.querySelector("#connection").textContent.includes("版本 1")');
  await click(guest, '#exit');
  await host.waitFor('!document.querySelector("#exit").disabled');
  await click(host, selector);
  await host.waitFor('!document.querySelector("#fields").disabled && document.querySelector("#word").options.length >= 4');
  await host.eval('document.querySelector("#mode").value="word";document.querySelector("#mode").dispatchEvent(new Event("change"));document.querySelector("#edge").value="word-end";document.querySelector("#edge").dispatchEvent(new Event("change"));');
  assert.ok(Math.abs(await host.eval('Number(document.querySelector("#word-time").value)') - revised) <= 0.01);
  await click(host, '#exit');
  assert.notEqual(fs.readFileSync(path.join(studio.root, 'projects', assId, 'subtitle.ass'), 'utf8'), fixtureAss);
  console.log('Chromium: two separate windows verified SRT text, cue timing, ASS word timing, locks, synchronization, and recovery on close.');
} catch (error) {
  console.error('Host:', host?.logs.filter(x=>x.includes('exception')).slice(-5));
  console.error('Guest:', guest?.logs.filter(x=>x.includes('exception')).slice(-5));
  throw error;
} finally {
  await host?.close();
  await guest?.close();
  await studio.close();
}
