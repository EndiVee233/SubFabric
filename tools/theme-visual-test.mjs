/* Real Chromium + production modules, disposable projects/settings, no GPU/model downloads.
 * node tools/theme-visual-test.mjs [--out <directory>] [--diagnostic]
 * SUBFABRIC_BROWSER selects an installed Chromium executable. No npm dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isolatedServer } from '../tests/helpers/isolated-server.mjs';
import { makeSyntheticAss } from '../tests/ass-fixture.mjs';
import { launch } from './lib/cdp.mjs';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex < 0 ? '_test/theme-visual' : process.argv[outIndex + 1]);
fs.mkdirSync(out, { recursive: true });
const diagnostic = process.argv.includes('--diagnostic');
const report = { schema: 1, fixture: 'synthetic ASS; simulated hardware only; production UI and local APIs', samples: [], issues: [], screenshots: [] };
report.limitations = ['Only visible ordinary text on compositable neutral surfaces is measured; gradient/image surfaces, reduced-opacity and disabled controls, video/subtitle/role color visualizations are excluded.', 'Modal viewport bounds are checked; arbitrary sibling occlusion and every scroll position are not proven.', 'Static overlay fixtures exercise existing markup, not completed GPU/ASR/translation jobs. Native OS dialogs, actual encoded video and NPU-specific payloads are outside this run.'];
const server = await isolatedServer({ prepare(dir, editor) {
  const project = path.join(dir, 'projects/p-theme-audit');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'subtitle.ass'), makeSyntheticAss().replace(/第 (\d+) 句/g, '[Speaker] 第 $1 句'));
  fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ id: 'p-theme-audit', name: 'Theme fixture', duration: 240,
    createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', subtitle: { format: 'ass', file: 'subtitle.ass', name: 'fixture.ass' } }));
  fs.writeFileSync(path.join(project, 'draft.log'), 'Storage layout fixture\n');
  const cache = path.join(dir, 'asr', '__pycache__');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'theme-fixture.pyc'), Buffer.alloc(2048));
  // Optional installed libass files are copied explicitly, never runtime/model/user directories.
  for (const name of ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'fonts/NotoSansCJKsc-Regular.otf']) {
    const source = path.join(root, 'editor/vendor', name), dest = path.join(editor, 'vendor', name);
    if (fs.existsSync(source)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest); }
  }
} });
let browser;
try {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  browser = await launch({ port });
  const b = browser;
  await b.send('DOM.enable');
  await b.send('CSS.enable');
  await b.setViewport(1440, 1000);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('sf-welcome-v1',JSON.stringify({done:true,vulkan:true}));
    if(!localStorage.getItem('subfabric-studio-v1')) localStorage.setItem('subfabric-studio-v1',JSON.stringify({motion:'off',background:'solid'}));
    const nativeFetch=window.fetch;
    const json = data => Promise.resolve(new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}}));
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/asr/hardware')) {
        return json({ok:true,cuda:{available:false},vulkan:{available:true,devices:['Fixture GPU']},npu:{available:false},backends:{vulkan:true}});
      }
      if (url === '/api/translate/schemes/models') return json({models:['fixture-standard','fixture-compact']});
      // Native encoder probes synchronously start ffmpeg processes. Render the
      // real controls with a stable capability response so later requests can run.
      if (url === '/api/projects/p-theme-audit/export-video/capabilities') {
        return json({ffmpeg:'fixture',tools:{ok:true},accelerators:{},cpu:{h264:{usable:true}},subtitleFile:'subtitle.ass'});
      }
      return nativeFetch(input, init);
    };
  ` });
  await b.goto(server.origin + '/#/dashboard');
  await b.waitFor('window.__sfStudio && window.__dbg && window.__sfWelcome');
  const settle = () => b.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const go = async hash => { await b.eval(`location.hash=${JSON.stringify(hash)}`); await settle(); };
  const collect = async (state, selector, screenshot = false) => {
    await settle();
    const sample = await b.eval(`(${measure.toString()})(${JSON.stringify(selector)})`);
    const context = await b.eval('({theme:document.body.dataset.themePack,mode:document.body.dataset.theme,width:innerWidth})');
    const row = { ...context, state, selector, ...sample };
    report.samples.push(row);
    if (!sample.count) report.issues.push({ ...context, state, error: 'No visible production component', selector });
    for (const issue of sample.issues) report.issues.push({ ...context, state, ...issue });
    if (screenshot) {
      const file = `${context.theme}-${context.mode}-${context.width}-${state}.png`;
      await b.shot(path.join(out, file)); report.screenshots.push(file);
    }
  };
  const packs = await b.eval('SF_THEMES.builtins');
  report.themes = packs.map(pack => pack.id);
  await go('#/batch');
  const negative = await b.eval(`(() => {const el=document.querySelector('#batch-add'),old=el.getAttribute('style');el.style.setProperty('background','#ffffff','important');el.style.setProperty('background-image','none','important');el.style.setProperty('color','#ffffff','important');const result=(${measure.toString()})('#batch-add');if(old===null)el.removeAttribute('style');else el.setAttribute('style',old);return result;})()`);
  assert.ok(negative.issues.some(issue=>issue.error==='Text contrast'),'browser negative control must detect white text on white button');
  report.negativeControl = 'detected contrast 1:1 in an in-memory fixture; production CSS untouched';
  for (const pack of packs) for (const mode of ['light', 'dark']) {
    // Storage event exercises the production cross-tab switch, with menus already mounted.
    await b.eval('window.__panel.showConfirm("Theme switch", "An existing dialog follows the new theme", "Confirm", "Cancel", ()=>{})');
    await b.eval(`(() => {const key='subfabric-studio-v1';const next=JSON.stringify({...JSON.parse(localStorage.getItem(key)),themePack:${JSON.stringify(pack.id)},accent:${JSON.stringify(pack.seed)},mode:${JSON.stringify(mode)}});localStorage.setItem(key,next);window.dispatchEvent(new StorageEvent('storage',{key,newValue:next}));})()`);
    await settle();
    await collect('switch-open-dialog', '#confirm-overlay .modal-surface');
    await b.eval('document.querySelector("#confirm-no").click()');
    const tokens = await b.eval(`(() => {const style=getComputedStyle(document.body);return Object.fromEntries(['--bg','--surface','--surface-2','--surface-3','--text','--muted','--outline','--success','--warning','--danger','--info'].map(k=>[k,style.getPropertyValue(k).trim()]));})()`);
    for (const [name, value] of Object.entries(tokens)) if (!value) report.issues.push({theme:pack.id,mode,error:'Missing token',name});
    for (const width of [1440, 900]) {
      await b.setViewport(width, 1000);
      for (const [route, selector] of [['dashboard','#dashboard-view'],['home','#home-view'],['new','#np-view'],['batch','#batch-view'],['details/p-theme-audit','#detail-view']]) {
        await go('#/' + route);
        await b.waitFor(`!document.querySelector(${JSON.stringify(selector)}).hidden`);
        await collect(route.split('/')[0], selector, ['dashboard','batch'].includes(route));
      }
      await go('#/settings');
      for (const tab of ['theme','models','translate','enhance','fetch','perf','storage']) {
        await b.eval(`document.querySelector('#sf-settings-tab-${tab}').click()`);
        if (tab === 'storage') await b.waitFor('document.querySelector("#stg-scan-state").textContent.includes("上次扫描")');
        await collect('settings-' + tab, '#st-panel-' + tab, ['models','storage'].includes(tab));
      }
      assert.ok(await b.eval('(() => {const el=document.querySelector("#st-panel-storage");return el.scrollWidth<=el.clientWidth+1;})()'),
        `${pack.id} ${mode} ${width}: storage fits its settings panel`);
      await b.eval('document.querySelector("#sf-settings-tab-translate").click();document.querySelector("#st-scheme-new").click()');
      await b.waitFor('!!document.querySelector(\'#st-provider option[value="custom"]\')');
      await b.eval(`(() => {
        const provider=document.querySelector('#st-provider'), key=document.querySelector('#st-key');
        provider.value='custom'; provider.dispatchEvent(new Event('change',{bubbles:true}));
        key.value='theme-fixture-key'; key.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await b.waitFor('!document.querySelector("#st-model-discover").hidden');
      const keyLayout = await b.eval(`(() => {
        const key=document.querySelector('#st-key').getBoundingClientRect();
        const button=document.querySelector('#st-model-discover').getBoundingClientRect();
        const group=document.querySelector('.st-scheme-key-row').getBoundingClientRect();
        return { width:group.width, fits:button.right<=group.right+1, beside:button.top<key.bottom && button.bottom>key.top };
      })()`);
      assert.ok(keyLayout.fits && (keyLayout.width<245 || keyLayout.beside),
        `${pack.id} ${mode} ${width}: model discovery fits beside the key when there is room (${JSON.stringify(keyLayout)})`);
      await b.eval('document.querySelector("#st-model-discover").click()');
      await b.waitFor('!!document.querySelector(\'#st-model-options option[value="fixture-standard"]\')');
      assert.ok(await b.eval(`(() => {
        const drawer=document.querySelector('#st-scheme-drawer');
        const heading=drawer.querySelector('.st-drawer-head').getBoundingClientRect();
        return heading.top>=drawer.getBoundingClientRect().top-1 && heading.height>0;
      })()`), `${pack.id} ${mode} ${width}: scheme heading remains visible when the name field gains focus`);
      await collect('scheme-form', '#st-scheme-drawer', true);
      await b.eval('document.querySelector("#st-drawer-cancel").click()');
      await b.eval('document.querySelector("#sf-settings-tab-models").click()');
      await b.waitFor('document.querySelectorAll("#st-models > .sf-prerequisite").length === 3');
      await b.eval('document.querySelector(\'[data-asr-family="前置"]\').click()');
      const cards = await b.eval('Array.from(document.querySelectorAll("#st-models > .sf-prerequisite")).map(el=>[el.offsetWidth,el.offsetHeight])');
      for (let i = 0; i < 2; i++) {
        const sizes = cards.map(card => card[i]);
        assert.ok(Math.min(...sizes) > 0 && Math.max(...sizes) - Math.min(...sizes) <= 1,
          `${pack.id} ${mode} ${width}: prerequisites have matching dimensions (${JSON.stringify(cards)})`);
      }
      await collect('prerequisites', '#st-models > .sf-prerequisite', true);
      await b.eval('document.querySelector("#sf-asr-back").click()');
      const parameters = await b.eval('!!document.querySelector(".sm-params")');
      if(parameters) {
        await b.eval('document.querySelector(".sm-params").click()');
        await b.waitFor('document.querySelector("#sf-asr-params") && !document.querySelector("#sf-asr-params").hidden');
        await collect('asr-parameters-loading', '#sf-asr-params .sf-ap-panel');
        try { await b.waitFor('document.querySelectorAll("#sf-ap-fields [data-param]").length > 0'); }
        catch (error) {
          const detail = await b.eval('({id:document.querySelector(".sm-params")?.dataset.id,model:document.querySelector("#sf-ap-model")?.textContent,fields:document.querySelector("#sf-ap-fields")?.textContent})');
          throw new Error('ASR parameter panel did not render: ' + JSON.stringify(detail), { cause: error });
        }
        await collect('asr-parameters', '#sf-asr-params .sf-ap-panel', true);
        await b.eval('document.querySelector("#sf-ap-fields [data-param]").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".sf-ap-body").scrollTop=document.querySelector(".sf-ap-body").scrollHeight');
        await collect('asr-parameters-edited-bottom', '#sf-asr-params .sf-ap-panel');
        await b.eval('document.querySelector("#sf-ap-cancel").click()');
      }
      await go('#/project/p-theme-audit');
      await b.waitFor('window.__dbg.state.project?.id === "p-theme-audit" && window.__dbg.state.format === "ass" && document.querySelectorAll(".cue-card").length > 0');
      await b.eval('if(!document.querySelector("#confirm-overlay").hidden)document.querySelector("#confirm-no").click()');
      for (const tab of ['sub','roles','settings','logs']) {
        await b.eval(`window.__panel.showTab(${JSON.stringify(tab)},{instant:true})`);
        await collect('editor-' + tab, '#editor-panel', tab === 'sub');
      }
      await b.eval('window.__panel.showTab("settings",{instant:true});document.querySelector("#btn-export-advanced").click()');
      await collect('advanced-export', '#adv-export-overlay .modal-surface', true);
      await b.eval('document.querySelector("#adv-export-cancel").click()');
      await b.eval('document.querySelector("#btn-export-video").click()');
      try { await b.waitFor('document.querySelector("#sf-ev-cap")?.textContent.includes("ffmpeg fixture")'); }
      catch (error) {
        const detail = await b.eval('({project:window.__dbg.state.project?.id,capability:document.querySelector("#sf-ev-cap")?.textContent,status:document.querySelector("#sf-ev-status")?.textContent})');
        throw new Error('Export capability fixture did not render: ' + JSON.stringify(detail), {cause:error});
      }
      await collect('video-export', '#sf-export-video .sf-ev-panel', true);
      await b.eval('document.querySelector("#sf-ev-close").click()');
      await b.eval('window.__panel.showAddRoleDialog(()=>{})');
      await collect('role-dialog', '#role-new .modal-surface');
      await b.eval('document.querySelector("#role-new-cancel").click()');
      // Existing production markup; conditional API/model payloads are not fabricated.
      const surfaces = await b.eval(`Array.from(document.querySelectorAll('[id$="overlay"]')).filter(el=>el.querySelector('.modal-surface')).map(el=>el.id)`);
      for(const id of surfaces) {
        await b.eval(`document.getElementById(${JSON.stringify(id)}).hidden=false`);
        await collect('surface-fixture-' + id, '#' + id + ' .modal-surface');
        await b.eval(`document.getElementById(${JSON.stringify(id)}).hidden=true`);
      }
      await b.eval('window.__panel.showConfirm("Theme fixture","Confirm / warning / cancel", "Confirm", "Cancel", ()=>{})');
      await collect('confirm', '#confirm-overlay .modal-surface');
      await b.eval('document.querySelector("#confirm-no").click()');
      await b.eval('window.SSColorPicker.open(document.querySelector("#role-new-color"),{x:300,y:180})');
      await collect('color-picker', '.sscp');
      await b.eval('document.querySelector(".sscp-x").click()');
      await go('#/batch');
      await b.eval('document.querySelector("#sf-folder-add").click()');
      await collect('folder-dialog', '#sf-folder-dialog .sf-folder-box', true);
      await b.eval('document.querySelector("[data-folder-cancel]").click()');
      const choice = await b.eval('document.querySelector("#batch-model-choice").getBoundingClientRect().width > 0');
      if(choice) {
        await b.eval('document.querySelector("#batch-model-choice").click()');
        await collect('choice-menu', '#sf-choice-menu');
        await b.eval('document.querySelector("#batch-model-choice").click()');
      }
      await b.eval(`(() => {const input=document.querySelector('#batch-files'),dt=new DataTransfer();dt.items.add(new File(['fixture'],'theme-fixture.mp4',{type:'video/mp4'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await collect('batch-queue', '.batch-item');
      await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await b.eval('document.querySelector("#batch-add").focus()');
      const focus = await b.eval('({style:getComputedStyle(document.querySelector("#batch-add")).outlineStyle,width:getComputedStyle(document.querySelector("#batch-add")).outlineWidth})');
      assert.ok(focus.style!=='none'&&parseFloat(focus.width)>0, `${pack.id} keyboard focus is visible`);
      await collect('batch-focus', '#batch-add');
      const doc = await b.send('DOM.getDocument');
      const node = await b.send('DOM.querySelector', {nodeId:doc.root.nodeId,selector:'#batch-add'});
      for(const state of ['hover','active']) {
        await b.send('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[state]});
        await collect('batch-' + state, '#batch-add');
      }
      await b.send('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[]});
      await b.eval('document.querySelector("[data-batch-settings]").click()');
      await collect('batch-settings', '#batch-item-overlay .modal-surface');
      await b.eval('document.querySelector("#batch-item-cancel").click();document.querySelector("#batch-clear").click()');
      await b.eval('window.__sfWelcome.open({})');
      await collect('welcome', '#welcome-view', true);
      await b.eval('window.__sfWelcome.close()');
    }
    console.log(`${pack.id} ${mode}: captured`);
  }
  await b.eval(`(() => {
    const key = 'subfabric-studio-v1';
    const next = JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), themePack: 'windows-uwp', mode: 'dark' });
    localStorage.setItem(key, next);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: next }));
  })()`);
  await b.setViewport(2560, 1350);
  await go('#/dashboard');
  const homeWidth = await b.eval('document.querySelector(".dashboard-inner").getBoundingClientRect().width');
  assert.equal(homeWidth, 1108, 'homepage keeps its compact desktop width');
  await go('#/settings');
  await b.eval('document.querySelector("#sf-settings-tab-storage").click()');
  await b.waitFor('document.querySelector("#stg-scan-state").textContent.includes("上次扫描")');
  const settingsWidth = await b.eval('document.querySelector(".settings-inner").getBoundingClientRect().width');
  assert.equal(settingsWidth, 1160, 'settings keeps its compact desktop width');
  const storageWidth = await b.eval('document.querySelector("#st-panel-storage").getBoundingClientRect().width');
  assert.ok(storageWidth > 800 && storageWidth <= 920, `desktop storage width: ${storageWidth}`);
  await collect('wide-storage', '#st-panel-storage', true);
  await b.eval('document.querySelector("#sf-settings-tab-enhance").click()');
  assert.equal(await b.eval('[...document.querySelectorAll("#st-panel-enhance .hw-mine, #st-word-realign-note")].filter(el => el.hidden && el.getClientRects().length === 0).length'), 2);
  await b.eval('document.querySelector("#sf-settings-tab-fetch").click()');
  assert.ok(await b.eval('document.querySelector("#st-fetch-youtube-card").getClientRects().length > 0'));
  assert.equal(await b.eval('document.querySelector("#st-fetch-youtube-open").origin'), 'https://www.youtube.com');
  assert.ok(await b.eval('document.querySelector("#st-fetch-youtube-import").getClientRects().length > 0'));
  await b.eval('document.querySelector("#sf-settings-tab-perf").click()');
  assert.ok(await b.eval('document.querySelector("#sf-accel-card").getClientRects().length > 0'));
  assert.equal(await b.eval('document.querySelector("#perf-models-view").getClientRects().length'), 0);
  assert.equal(await b.eval('document.querySelector("#perf-tab-models").getClientRects().length'), 0);
  await go('#/new');
  const newLayout = await b.eval('getComputedStyle(document.querySelector("#np-view .ws-grid")).display');
  assert.equal(newLayout, 'flex', 'new project keeps its original two-column layout');
  await collect('wide-new', '#np-view', true);
  await go('#/home');
  await b.waitFor('document.querySelector("#home-list .pc-details")?.getBoundingClientRect().width > 0');
  const hover = async selector => {
    const [x, y] = await b.eval(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    await b.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
    await settle();
    return b.eval(`(() => {
      const card = document.querySelector('#home-list .proj-card');
      const button = card.querySelector('.pc-details');
      return [card.style.getPropertyValue('--uwp-face'), button.style.getPropertyValue('--uwp-face')];
    })()`);
  };
  assert.deepEqual(await hover('#home-list .pc-name'), ['1', ''], 'card face lights by itself');
  assert.deepEqual(await hover('#home-list .pc-details'), ['0', '1'], 'button lights without the parent card');
  assert.deepEqual(await hover('#home-list .pc-name'), ['1', '0'], 'leaving the button restores the card light');
  report.wideDesktop = { homeWidth, settingsWidth, storageWidth, newLayout, reveal: 'passed', hiddenSettings: 'passed' };

  await go('#/settings');
  await b.eval('document.querySelector("#sf-settings-tab-effects").click()');
  for (const [width, height] of [[1440, 900], [960, 660]]) {
    await b.setViewport(width, height);
    await b.eval('document.querySelector("#st-effect-new").click()');
    await b.waitFor(`(() => {
      const video = document.querySelector('#st-subtitle-video');
      return video.readyState >= 2 && video.paused && Math.abs(video.currentTime - 0.75) < 0.04;
    })()`, { label: 'subtitle preview opens on a still frame' });
    const layout = await b.eval(`(() => {
      const form = document.querySelector('#st-effect-form').getBoundingClientRect();
      const video = document.querySelector('#st-subtitle-video').getBoundingClientRect();
      const style = document.querySelector('#st-subtitle-style').getBoundingClientRect();
      return { videoWidth: video.width, aboveFields: video.bottom < style.top, cardGutter: form.width - style.width };
    })()`);
    assert.ok(layout.aboveFields && layout.cardGutter < 56 && layout.videoWidth >= (width === 1440 ? 530 : 320),
      `subtitle preview sits above full-width settings at ${width}×${height} (${JSON.stringify(layout)})`);
    await collect('subtitle-preview', '.sf-subtitle-sample', true);
    await b.eval('document.querySelector("#fx-enable").click(); document.querySelector("#st-view").scrollBy(0, 380)');
    await settle();
    const pinned = await b.eval(`(() => {
      const sample = document.querySelector('.sf-subtitle-sample').getBoundingClientRect();
      const settings = document.querySelector('#st-view').getBoundingClientRect();
      return { top: sample.top - settings.top, leavesRoom: settings.bottom - sample.bottom > 180 };
    })()`);
    assert.ok(Math.abs(pinned.top) < 2 && pinned.leavesRoom,
      `subtitle preview stays at the top with room to edit at ${width}×${height} (${JSON.stringify(pinned)})`);
    await b.eval(`(() => {
      const video = document.querySelector('#st-subtitle-video').getBoundingClientRect();
      const effects = document.querySelector('#ass-fx-group').getBoundingClientRect();
      document.querySelector('#st-view').scrollBy(0, effects.top - (video.top + video.height / 2));
    })()`);
    await settle();
    const layers = await b.eval(`(() => {
      const sample = document.querySelector('.sf-subtitle-sample');
      const video = sample.querySelector('video').getBoundingClientRect();
      const heading = document.querySelector('#ass-fx-group .set-group-head').getBoundingClientRect();
      const x = video.left + video.width / 2;
      const y = heading.top + heading.height / 2;
      return {
        overlap: x > heading.left && x < heading.right && y > video.top && y < video.bottom,
        previewOnTop: sample.contains(document.elementFromPoint(x, y)),
      };
    })()`);
    assert.deepEqual(layers, { overlap: true, previewOnTop: true },
      `scrolling the effect heading behind the video leaves the preview on top at ${width}×${height}`);
    await collect('subtitle-preview-overlap', '.sf-subtitle-sample', true);
    await b.eval('document.querySelector("#st-subtitle-play").click()');
    await b.waitFor('document.querySelector("#st-subtitle-video").currentTime > 1.05');
    await b.eval('document.querySelector("#st-effect-cancel").click()');
    assert.ok(await b.eval('document.querySelector("#st-subtitle-video").paused'), 'closing the form pauses the sample');
  }
  report.subtitlePreview = 'top placement, frozen frame, playback, sticky scrolling, and effect heading layering passed at both window sizes';
  const persisted = await b.eval('({pack:document.body.dataset.themePack,mode:document.body.dataset.theme})');
  await b.goto(server.origin + '/?theme-persistence=1#/batch');
  await b.waitFor('document.readyState === "complete" && document.body && window.__sfStudio && window.__dbg');
  assert.deepEqual(await b.eval('({pack:document.body.dataset.themePack,mode:document.body.dataset.theme})'),persisted,'theme persists across reload');
  report.persistence = 'passed';

  // Exercise native-only onboarding with the real Studio, isolated settings, and a stable hardware response.
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.1.0' });
    const desktopFetch = window.fetch;
    window.fetch = (url, init) => String(url).startsWith('/api/asr/hardware')
      ? Promise.resolve(Response.json({ok:true,cuda:{available:true,device:'Fixture GPU'},vulkan:{available:true,devices:['Fixture GPU']},backends:{cuda:true,vulkan:true}}))
      : String(url) === '/api/asr/backends' ? Promise.resolve(Response.json({ok:true})) : desktopFetch(url, init);
  ` });
  for (const [name, activate] of [['常用字幕翻译', true], ['备用翻译方案', false]]) {
    const response = await server.call('/api/translate/schemes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider: 'deepseek', model: 'deepseek-chat', activate }),
    });
    const data = await response.json();
    assert.ok(response.ok, data.error);
  }
  await b.setViewport(1440, 960);
  await b.goto(server.origin + '/?desktop-welcome=1#/settings');
  await b.waitFor('window.__sfWelcome');
  await b.eval('window.__sfWelcome.open({firstRun:true,returnHash:"#/settings"})');
  await b.waitFor('document.querySelector("#welcome-step").textContent === "1 / 5"');
  assert.equal(await b.eval('document.querySelector(".welcome-caption-art") === null'), true);
  await collect('desktop-welcome-intro', '#welcome-view', true);
  const welcomeClick = async id => { await b.eval(`document.getElementById(${JSON.stringify(id)}).click()`); await settle(); };
  await welcomeClick('welcome-next');
  await b.waitFor('window.__sfWelcome.state().selected.cuda && window.__sfWelcome.state().selected.vulkan');
  const cardBackground = 'getComputedStyle(document.querySelector("#welcome-cuda-card")).backgroundColor';
  const color = await b.eval(cardBackground);
  assert.equal(await b.eval('getComputedStyle(document.querySelector("#welcome-cuda")).opacity'), '0');
  assert.equal(await b.eval('document.querySelector("#welcome-cuda-card .welcome-card-check").getClientRects().length'), 0);
  const [cardX, cardY] = await b.eval('(() => {const r=document.querySelector("#welcome-cuda-card").getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()');
  await b.mouse('mouseMoved', cardX, cardY, { button: 'none', buttons: 0 });
  await b.waitFor('document.querySelector("#welcome-cuda-card").matches(":hover")');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(await b.eval(cardBackground), color, 'selected tile retains its color under the mouse');
  await b.click(cardX, cardY);
  assert.equal(await b.eval('window.__sfWelcome.state().selected.cuda'), false);
  await b.eval('document.querySelector("#welcome-cuda").focus()');
  await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert.equal(await b.eval('window.__sfWelcome.state().selected.cuda'), true, 'checkbox is still usable from the keyboard');
  await collect('desktop-welcome-backends', '#welcome-view', true);
  await welcomeClick('welcome-next');
  await b.waitFor('document.querySelector("#welcome-asr-mount #sf-asr-catalog")');
  await b.waitFor('!document.querySelector("#sf-asr-catalog").inert');
  await collect('desktop-welcome-models', '#welcome-view', true);
  await welcomeClick('welcome-next');
  await b.waitFor('document.querySelectorAll("#welcome-scheme-mount .st-scheme").length === 2');
  const schemeAppearance = await b.eval(`(() => {
    const panel = getComputedStyle(document.querySelector('#welcome-scheme-mount > #st-panel-translate'));
    const active = getComputedStyle(document.querySelector('#welcome-scheme-mount .st-scheme.cur'));
    return [panel.backgroundColor, panel.backgroundImage, panel.boxShadow, active.backgroundColor];
  })()`);
  assert.deepEqual(schemeAppearance.slice(0, 3), ['rgba(0, 0, 0, 0)', 'none', 'none']);
  assert.notEqual(schemeAppearance[3], schemeAppearance[0], 'active scheme keeps its card background');
  await welcomeClick('st-scheme-new');
  await b.waitFor('document.querySelector("#st-scheme-drawer").classList.contains("open")');
  await welcomeClick('st-drawer-cancel');
  await b.waitFor('document.querySelector("#st-scheme-drawer").hidden');
  await collect('desktop-welcome-schemes', '#welcome-view', true);
  await welcomeClick('welcome-skip');
  assert.ok(await b.eval('document.querySelector("#welcome-fetch-mount #st-fetch-youtube-open").getClientRects().length > 0'));
  await collect('desktop-welcome-login', '#welcome-view', true);
  await welcomeClick('welcome-back');
  assert.ok(await b.eval('document.querySelector("#st-view #st-panel-fetch") && document.querySelector("#welcome-scheme-mount #st-panel-translate")'));
  await welcomeClick('welcome-next');
  await welcomeClick('welcome-go');
  await b.waitFor('document.querySelector("#welcome-view").hidden');
  assert.ok(await b.eval('document.querySelector("#st-view #st-panel-fetch") && document.querySelector("#st-view #st-panel-translate") && document.querySelector("#st-view #sf-asr-catalog")'));
  assert.ok(await b.eval('JSON.parse(localStorage.getItem("sf-welcome-v1")).done'));
  report.desktopWelcome = 'five steps, mouse and keyboard selection, live settings reuse, and completion passed';

  report.exceptions = b.logs.filter(line => line.startsWith('[exception]'));
  for (const error of report.exceptions) report.issues.push({error});
  console.log(`Theme render: ${report.samples.length} states, ${report.themes.length} themes, ${report.issues.length} findings; ${out}`);
  if (report.issues.length && !diagnostic) process.exitCode = 1;
} catch(error) {
  report.error=String(error.stack || error);
  if (browser) {
    report.runtime = await browser.eval('({route:location.hash,project:window.__dbg?.state.project?.id,format:window.__dbg?.state.format,confirm:document.querySelector("#confirm-overlay")?.textContent,toasts:Array.from(document.querySelectorAll(".sf-toast,.toast")).map(el=>el.textContent)})').catch(()=>null);
    report.exceptions = browser.logs.filter(line=>line.startsWith('[exception]'));
    console.error(JSON.stringify({runtime:report.runtime,exceptions:report.exceptions}));
  }
  throw error;
} finally {
  report.status=report.error||report.issues.length?'failed':report.persistence==='passed'?'passed':'incomplete';
  fs.writeFileSync(path.join(out, 'matrix.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) { await browser.send('Browser.close').catch(() => {}); browser.close(); }
  await server.close();
}

// Alpha-composite ancestor surfaces. Gradients/video/subtitle colors are reported
// separately; this check is for ordinary text on the production neutral surfaces.
function measure(selector) {
  const styles=new WeakMap(), backgrounds=new WeakMap(), parsed=new Map();
  const style=el=>{if(!styles.has(el))styles.set(el,getComputedStyle(el));return styles.get(el);};
  const visible = el => {const r=el.getBoundingClientRect(),s=style(el);return r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight&&s.visibility==='visible'&&s.display!=='none';};
  const roots = [...document.querySelectorAll(selector)].filter(visible);
  const issues = [], colors = [];
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
  const rgb = value => {if(!parsed.has(value)){context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);parsed.set(value,[...context.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v));}return parsed.get(value);};
  const over = (a,b) => a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3])).concat(1);
  const bg = el => {if(!el)return [255,255,255,1];if(!backgrounds.has(el))backgrounds.set(el,over(rgb(style(el).backgroundColor),bg(el.parentElement)));return backgrounds.get(el);};
  const lum = a => a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  for (const root of roots) {
    const r=root.getBoundingClientRect();
    if(root.matches('.modal-surface,.sscp,[role=dialog]')&&(r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)) issues.push({error:'Surface outside viewport',selector:root.id||root.className,rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
    for(const el of [root,...root.querySelectorAll('*')]) {
      if(!visible(el)||el.closest('button:disabled,[inert],.sf-pack-art,#video-stage,.sf-flower,.sf-cover,.rn-colors,.sscp-sv,.sscp-preview,.sscp-swatches,.cc-role'))continue;
      if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
      const s=style(el);
      if(Number(s.opacity)<1||s.backgroundImage!=='none'||rgb(s.color)[3]===0)continue;
      let excluded=false;
      for(let node=el.parentElement;node;node=node.parentElement){const p=style(node);if(Number(p.opacity)<1||p.backgroundImage!=='none'){excluded=true;break;}}
      if(excluded)continue;
      const front=over(rgb(s.color),bg(el)),back=bg(el),a=lum(front),b=lum(back),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const large=parseFloat(s.fontSize)>=24||parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700;
      const entry={selector:el.id?'#'+el.id:el.className||el.tagName,text:el.textContent.trim().slice(0,64),foreground:s.color,background:s.backgroundColor,ratio:Math.round(ratio*100)/100};
      colors.push(entry);
      if(ratio<(large?3:4.5)-.01)issues.push({error:'Text contrast',...entry});
    }
  }
  return {count:roots.length,issues,colors,surfaces:roots.map(el=>({selector:el.id?'#'+el.id:el.className,
    semanticTokens:Object.fromEntries(['--surface','--surface-2','--text','--muted','--accent-text','--success','--warning','--danger'].map(name=>[name,style(el).getPropertyValue(name).trim()]))}))};
}
