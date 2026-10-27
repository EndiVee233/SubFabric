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
    window.fetch=(input,init)=>String(input).startsWith('/api/asr/hardware')
      ? Promise.resolve(new Response(JSON.stringify({ok:true,cuda:{available:false},vulkan:{available:true,devices:['Fixture GPU']},npu:{available:false},backends:{vulkan:true}}),{headers:{'Content-Type':'application/json'}}))
      : nativeFetch(input,init);
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
      for (const [route, selector] of [['dashboard','#dashboard-view'],['home','#home-view'],['new','#np-view'],['batch','#batch-view'],['help','#sf-help'],['details/p-theme-audit','#detail-view']]) {
        await go('#/' + route);
        await b.waitFor(`!document.querySelector(${JSON.stringify(selector)}).hidden`);
        await collect(route.split('/')[0], selector, ['dashboard','batch'].includes(route));
      }
      await go('#/settings');
      for (const tab of ['theme','models','translate','enhance','fetch','perf']) {
        await b.eval(`document.querySelector('#sf-settings-tab-${tab}').click()`);
        await collect('settings-' + tab, '#st-panel-' + tab, tab === 'models');
      }
      await b.eval('document.querySelector("#sf-settings-tab-models").click()');
      const parameters = await b.eval('!!document.querySelector(".sm-params")');
      if(parameters) {
        await b.eval('document.querySelector(".sm-params").click()');
        await b.waitFor('document.querySelector("#sf-asr-params") && !document.querySelector("#sf-asr-params").hidden');
        await collect('asr-parameters-loading', '#sf-asr-params .sf-ap-panel');
        await b.waitFor('document.querySelectorAll("#sf-ap-fields [data-param]").length > 0');
        await collect('asr-parameters', '#sf-asr-params .sf-ap-panel', true);
        await b.eval('document.querySelector("#sf-ap-fields [data-param]").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".sf-ap-body").scrollTop=document.querySelector(".sf-ap-body").scrollHeight');
        await collect('asr-parameters-edited-bottom', '#sf-asr-params .sf-ap-panel');
        await b.eval('document.querySelector("#sf-ap-cancel").click()');
      }
      await go('#/project/p-theme-audit');
      await b.waitFor('window.__dbg.state.format === "ass" && document.querySelectorAll(".cue-card").length > 0');
      await b.eval('if(!document.querySelector("#confirm-overlay").hidden)document.querySelector("#confirm-no").click()');
      for (const tab of ['sub','roles','settings','logs']) {
        await b.eval(`window.__panel.showTab(${JSON.stringify(tab)},{instant:true})`);
        await collect('editor-' + tab, '#editor-panel', tab === 'sub');
      }
      await b.eval('window.__panel.showTab("settings",{instant:true});document.querySelector("#btn-export-advanced").click()');
      await collect('advanced-export', '#adv-export-overlay .modal-surface', true);
      await b.eval('document.querySelector("#adv-export-cancel").click()');
      await b.eval('document.querySelector("#btn-export-video").click()');
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
  const persisted = await b.eval('({pack:document.body.dataset.themePack,mode:document.body.dataset.theme})');
  await b.goto(server.origin + '/?theme-persistence=1#/batch');
  await b.waitFor('document.readyState === "complete" && document.body && window.__sfStudio && window.__dbg');
  assert.deepEqual(await b.eval('({pack:document.body.dataset.themePack,mode:document.body.dataset.theme})'),persisted,'theme persists across reload');
  report.persistence = 'passed';
  report.exceptions = b.logs.filter(line => line.startsWith('[exception]'));
  for (const error of report.exceptions) report.issues.push({error});
  console.log(`Theme render: ${report.samples.length} states, ${report.themes.length} themes, ${report.issues.length} findings; ${out}`);
  if (report.issues.length && !diagnostic) process.exitCode = 1;
} catch(error) {
  report.error=String(error.stack || error);
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
