import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardsubBrowserModule } from './export-shared.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=process.argv[2];
if(!assets) throw new Error('Pass the fresh Android assets directory');
const target=path.join(assets,'editor');
const download=path.join(assets,'download/python');fs.mkdirSync(path.join(download,'fetch'),{recursive:true});
const pythonFiles=['__init__.py','selector.py','bilibili.py','bili_format.py','yt_format.py','priority.py'];
for(const file of pythonFiles)fs.copyFileSync(path.join(root,'asr/fetch',file),path.join(download,'fetch',file));
fs.copyFileSync(path.join(root,'android/download.py'),path.join(download,'sf_download.py'));
const {createHash}=await import('node:crypto');
const wheels=['yt_dlp-2026.10.26-py3-none-any.whl','yt_dlp_ejs-0.8.0-py3-none-any.whl','certifi-2026.10.23-py3-none-any.whl'];
const digest=createHash('sha256');digest.update('2.0.2:'+wheels.join(','));for(const file of ['sf_download.py',...pythonFiles.map(f=>'fetch/'+f)])digest.update(fs.readFileSync(path.join(download,file)));
fs.writeFileSync(path.join(assets,'download/runtime.json'),JSON.stringify({id:digest.digest('hex'),wheels}));
fs.mkdirSync(target,{recursive:true});
for(const folder of ['js','css','assets','lang','vendor']) {
  const source=path.join(root,'editor',folder);
  if(!fs.existsSync(source)) throw new Error(`Missing ${folder}; run node editor/scripts/fetch-vendor.js`);
  fs.cpSync(source,path.join(target,folder),{recursive:true});
}
// Browser helpers imported from editor/js; desktop backend and secrets never enter the APK.
const visited=new Set();
function include(file) {
  if(visited.has(file))return;visited.add(file);
  const text=fs.readFileSync(path.join(root,file),'utf8');
  fs.mkdirSync(path.dirname(path.join(assets,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(assets,file));
  for(const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"\n]+\.js)\1/g)) {
    const next=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[2]));
    if(!next.startsWith('editor/'))throw new Error(`Import escapes browser source: ${next}`);
    include(next);
  }
}
for(const file of fs.readdirSync(path.join(root,'editor/js')))if(file.endsWith('.js'))include('editor/js/'+file);
fs.mkdirSync(path.join(target,'themes'),{recursive:true});
fs.copyFileSync(path.join(root,'editor/themes/windows-uwp.theme.json'),path.join(target,'themes/windows-uwp.theme.json'));
// Pure translation contracts are shared with desktop; no server startup / credential code is staged.
const server=fs.readFileSync(path.join(root,'editor/server.js'),'utf8').replace(/\r\n/g,'\n');
function section(start,end){const a=server.indexOf(start),b=server.indexOf(end,a);if(a<0||b<0)throw new Error('Review Android LLM shared source: '+start);return server.slice(a,b);}
const presets=section('const LLM_PRESETS = [','/** 双引擎的分工配置。');
const prompts=section('function parseGlossary(text, lang)', 'function updateLlmKey(');
fs.writeFileSync(path.join(target,'android-llm-defaults.js'),`const ANTHROPIC_PROVIDER='anthropic';\n${presets}\n${prompts}\nexport {LLM_PRESETS,DEFAULT_TRANSLATE_PROMPT,systemPromptWithGlossary,parseGlossary};\n`);
const glossaryMerge=fs.readFileSync(path.join(root,'editor/glossary-merge.js'),'utf8');
if(!glossaryMerge.includes('module.exports = {'))throw new Error('Review Android glossary merge exports');
fs.writeFileSync(path.join(target,'android-glossary-merge.js'),glossaryMerge.replace('module.exports = {','export {'));
fs.writeFileSync(path.join(target,'android-glossary-doc.js'),fs.readFileSync(path.join(root,'android/glossary-doc.mjs'),'utf8').replaceAll("'../editor/js/","'./js/"));
let reseg=section('  const RESEG_MAX_ROWS =','  /* ── 长稿反思纠错');
reseg=reseg.replace('async function planResegRows(id, rows, cfg)','async function planResegRows(id, rows, cfg, llmChat)').replace(", debugFile: path.join(projDir(id), 'llm-debug.jsonl')",'');
if(/path\.|projDir/.test(reseg))throw new Error('Review Android semantic planning dependencies');
fs.writeFileSync(path.join(target,'android-reseg-plan.js'),reseg+'\nexport {planResegRows,parseJsonArrayLoose};\n');
const llmText=fs.readFileSync(path.join(root,'editor/llm-text.js'),'utf8');
if(!llmText.includes('module.exports = {'))throw new Error('Review Android LLM parser exports');
fs.writeFileSync(path.join(target,'android-llm-text.js'),llmText.replace('module.exports = {','export {'));
fs.writeFileSync(path.join(target,'android-translation-doc.js'),fs.readFileSync(path.join(root,'android/translation-doc.mjs'),'utf8').replaceAll("'../editor/js/","'./js/"));
let html=fs.readFileSync(path.join(root,'editor/studio.html'),'utf8');
// Android omits the optional creator feed, including its DOM, cache reader and polling.
for(const pattern of [/<section class="sf-uwp-youtube"[\s\S]*?<\/section>/,/<section class="sf-mu-yt"[\s\S]*?<\/section>/,/<button type="button" class="sf-orbit"[\s\S]*?<\/button>/]){
  if(!pattern.test(html))throw new Error('Review Android creator feed markup');html=html.replace(pattern,'');
}
const studioFile=path.join(target,'js/studio.js');
let studio=fs.readFileSync(studioFile,'utf8').replace(/\r\n/g,'\n');
const feedStart=studio.indexOf('let ytState = null,'),feedEnd=studio.indexOf('function renderMaterialHome()',feedStart);
if(feedStart<0||feedEnd<0)throw new Error('Review Android creator feed module');
studio=studio.slice(0,feedStart)+studio.slice(feedEnd);
for(const text of ["  renderYoutubeUpdates();\n", "  loadYoutubeUpdates();\n", "  write('sf-mu-status-num', ytRecentWeekCount());\n", "  else if (!dashboard.hidden && document.body.dataset.design === 'uwp') { renderYoutubeUpdates(); loadYoutubeUpdates(); }\n", "$('sf-mu-temp').addEventListener('click', () => loadYoutubeUpdates(true));\n", "$('sf-uwp-yt-refresh')?.addEventListener('click', () => loadYoutubeUpdates(true));\n", "const youtubeTimer = setInterval(() => { if (!document.hidden) loadYoutubeUpdates(); }, YT_REFRESH_MS);\n", "if (youtubeTimer && typeof youtubeTimer.unref === 'function') youtubeTimer.unref();\n", "hydrateYoutubeCache();\n"]){
  if(!studio.includes(text))throw new Error('Review Android creator feed integration: '+text);studio=studio.replace(text,'');
}
if(/loadYoutubeUpdates|hydrateYoutubeCache|ytRecentWeekCount|\/api\/youtube\/updates/.test(studio))throw new Error('Android creator feed is still connected');
fs.writeFileSync(studioFile,studio);

html=html.replace('以下内容会被删除，且不会进入回收站。删除后只能通过重新识别、重新下载或重新安装恢复。','仅删除选中的音频与波形缓存；重新打开稿件时从原媒体生成。字幕、原媒体、模型、任务与配置不会删除。');
html=html.replace('只支持 bilibili 与 YouTube 链接。下载的视频存在项目目录里（删项目会连视频一起删）。','支持 bilibili、YouTube 与可解析的媒体链接。下载保存在安卓本机，可关联已有字幕或新建 ASS 稿件。');
html=html.replace('Cookie 只存在本机 asr/settings.json，界面永远不会回显它的值。','Cookie 加密保存在安卓本机，界面不会回显。');
html=html.replace(/<div class="st-grid">\s*<span class="st-lbl">从浏览器读<\/span>[\s\S]*?<select id="st-fetch-browser"[\s\S]*?<\/div>\s*<p class="gl-hint">[\s\S]*?<\/p>/,'<select id="st-fetch-browser" hidden><option value="">（不用）</option></select><p class="gl-hint">安卓请导入浏览器导出的 Netscape Cookie 文件。</p>');
html=html.replace('<script src="js/accent.js">','<script src="/studio/android-boot.js"></script><script src="js/accent.js">');
html=html.replace('</head>','<link rel="stylesheet" href="/studio/android.css"></head>');
html=html.replace('<script type="module" src="js/main.js"></script>','<script type="module" src="js/main.js"></script><script type="module" src="/studio/android-ui.js"></script>');
fs.writeFileSync(path.join(target,'studio.html'),html);
const storageFile=path.join(target,'js/storage.js');
let storage=fs.readFileSync(storageFile,'utf8');
for(const [before,after]of [['音频、波形与识别原始结果','音频与波形缓存；原稿与原媒体保留'],['删除后需要重新下载','模型保留，不参与本页清理'],['未启用的后端环境','应用组件与下载环境，均受保护'],['字节码缓存会自动重建','任务、字体与浏览器数据保留']]){
  if(!storage.includes(before))throw new Error('Review Android storage descriptions');storage=storage.replace(before,after);
}
for(const [before,after]of [
  ['if (state.loading && !force) return;','if (state.loading) return;'],
  ["    $('stg-scan-state').textContent = state.loading", "    $('stg-rescan').disabled = state.loading || state.busy;\n    $('stg-scan-state').textContent = state.loading"],
]){if(!storage.includes(before))throw new Error('Review Android storage scan serialization');storage=storage.replace(before,after);}
fs.writeFileSync(storageFile,storage);
// Keep shared source unchanged: this Android-only branch omits the missing-video modal for subtitle-only documents.
const projectFile=path.join(target,'js/project.js');
let project=fs.readFileSync(projectFile,'utf8');
const before='      } else {\n        promptRelink(m);\n      }';
project=project.replace(/\r\n/g,'\n');
if(!project.includes(before))throw new Error('Review Android subtitle-only project integration against upstream');
project=project.replace(before,'      } else if (!m.androidStandalone) {\n        promptRelink(m);\n      } else { video.removeAttribute("src"); video.load(); }');
project=project.replace('st && st.done && (st.cuda || st.vulkan)','st && st.done && (st.android || st.cuda || st.vulkan)');
const emptyGuard="if (!hasEvents) throw new Error('字幕没有有效事件');";
if(!project.includes(emptyGuard))throw new Error('Review Android empty ASS document integration');
project=project.replace(emptyGuard,"if (!hasEvents && !(m.androidProject && isAss && /^\\s*\\[Events\\]/im.test(text))) throw new Error('字幕没有有效事件');");
if(project.split('p.videoExists || p.fetching').length!==3)throw new Error('Review Android standalone library cards');
project=project.replaceAll('p.videoExists || p.fetching','p.videoExists || p.fetching || p.androidStandalone');
const libraryAnchor='  return {\n    openProject, detachProject, flushSave, saveNow,';
if(!project.includes(libraryAnchor))throw new Error('Review Android library refresh hook');
project=project.replace(libraryAnchor,'  window.__androidRefreshLibrary = renderList;\n'+libraryAnchor);
const relinkBody='body: JSON.stringify({ videoPath: pick.path })';
if(project.split(relinkBody).length!==2)throw new Error('Review Android relink media name');
project=project.replace(relinkBody,'body: JSON.stringify({ videoPath: pick.path, name: pick.name })');
project=project.replace("npVideo.name + '（浏览器选择）'",'npVideo.name');
const browserStart=project.indexOf('  function browserPickVideo() {'),browserEnd=project.indexOf('  /* ── 区域字幕导入',browserStart);
if(browserStart<0||browserEnd<0)throw new Error('Review Android browser media picker cancellation');
project=project.slice(0,browserStart)+`  function browserPickVideo() {
    return new Promise(resolve=>{
      const input=document.createElement('input');input.type='file';input.accept='video/*,.mkv,.avi,.mov,.m4v';input.hidden=true;
      let finished=false;
      const done=file=>{if(finished)return;finished=true;document.removeEventListener('android-media-picker-cancel',cancel);input.remove();resolve(file||null);};
      const cancel=()=>done(null);input.addEventListener('change',()=>done(input.files?.[0]));input.addEventListener('cancel',cancel);
      document.addEventListener('android-media-picker-cancel',cancel);document.body.append(input);input.click();
    });
  }
`+project.slice(browserEnd);
fs.writeFileSync(projectFile,project);
const stateFile=path.join(target,'js/studio-state.js');
let studioState=fs.readFileSync(stateFile,'utf8');
const missingMedia='project.videoExists === false';
if(!studioState.includes(missingMedia))throw new Error('Review Android standalone draft status');
studioState=studioState.replace(missingMedia,'(project.videoExists === false && !project.androidStandalone)');
fs.writeFileSync(stateFile,studioState);
const glossaryFile=path.join(target,'js/glossary-review.js');
let glossary=fs.readFileSync(glossaryFile,'utf8');
for(const [before,after]of [
  ["if (logOp) logOp('glossary',","if (state.project?.id === pid && logOp) logOp('glossary',"],
  ['if (projects && projects.openProject) { try { await projects.openProject(pid); } catch {} }','if (state.project?.id === pid && projects && projects.openProject) { try { await projects.openProject(pid); } catch {} }'],
]){if(!glossary.includes(before))throw new Error('Review Android glossary late-apply guard');glossary=glossary.replace(before,after);}
fs.writeFileSync(glossaryFile,glossary);
const timelineFile=path.join(target,'js/timeline.js');
let timelineSource=fs.readFileSync(timelineFile,'utf8').replace(/\r\n/g,'\n');
const pressStart='        const entering = enterP < 1;',pressEnd='        if (entering) ctx.restore();';
if(timelineSource.split(pressStart).length!==2||timelineSource.split(pressEnd).length!==2)throw new Error('Review Android timeline press rendering');
timelineSource=timelineSource.replace(pressStart,`        const androidPressed = this.androidPressedCue === c;
        if(androidPressed){ctx.save();ctx.translate((x1+x2)/2,band.y+band.h/2+2);ctx.scale(.98,.94);ctx.translate(-(x1+x2)/2,-band.y-band.h/2);}
`+pressStart).replace(pressEnd,pressEnd+'\n        if(androidPressed) ctx.restore();');
fs.writeFileSync(timelineFile,timelineSource);
const mainFile=path.join(target,'js/main.js');
let main=fs.readFileSync(mainFile,'utf8').replace(/\r\n/g,'\n');
const debugAnchor='window.__dbg = { state, assPlayer,';
if(!main.includes(debugAnchor))throw new Error('Review Android project refresh hook');
main=main.replace(debugAnchor,'window.__androidRefreshProject = async id => { Projects.detachProject(); await Projects.openProject(id); };\n'+debugAnchor);
const applyAnchor='async function resegApplyNow() {\n';
if(!main.includes(applyAnchor))throw new Error('Review Android semantic preview apply guard');
main=main.replace(applyAnchor,applyAnchor+"  try { await window.__androidAssistCheck('reseg'); } catch(error) { toast(error.message,5000); return; }\n");
const loopAnchor='    for (const p of picked) {\n';
const resegStart=main.indexOf(applyAnchor),resegEnd=main.indexOf('function initResegLLM()',resegStart);
if(resegEnd<0||!main.slice(resegStart,resegEnd).includes(loopAnchor))throw new Error('Review Android semantic apply owner guard');
main=main.slice(0,resegStart)+main.slice(resegStart,resegEnd).replace(loopAnchor,loopAnchor+"      await window.__androidAssistOwner('reseg');\n")+main.slice(resegEnd);
fs.writeFileSync(mainFile,main);
const hardsub=fs.readFileSync(path.join(root,'editor/hardsub.js'),'utf8');
fs.writeFileSync(path.join(target,'android-hardsub.js'),hardsubBrowserModule(hardsub));
const exportFile=path.join(target,'js/export-video.js');
let exporter=fs.readFileSync(exportFile,'utf8');
for(const [before,after] of [
  ["auto: '自动（优先独显）'","hardware: 'MediaCodec 硬件', auto: '自动（优先硬件）'"],
  ["const order = ['auto'];","const order = ['auto']; if(d.androidHardware)order.push('hardware');"],
  ["$('sf-ev-cap').textContent = bits.join(' · ');","$('sf-ev-cap').textContent = d.androidSummary || bits.join(' · ');\n    if(d.android){$('sf-ev-dir').readOnly=true;$('sf-ev-dir').placeholder='请选择安卓导出文件夹';$('sf-ev-dir').value=d.directory||'';const codec=$('sf-ev-codec'),chosen=codec.value;for(const option of [...codec.options])if(!d.codecs[option.value]?.software&&!d.codecs[option.value]?.hardware?.length)option.remove();codec.value=[...codec.options].some(o=>o.value===chosen)?chosen:codec.options[0]?.value||'';}"],
]){if(!exporter.includes(before))throw new Error('Review Android export controls: '+before);exporter=exporter.replace(before,after);}
const galleryAnchor="    $('sf-ev-k-subtitle').checked = $('sf-ev-k-subtitle').checked || !cap.hasVideo;";
if(!exporter.includes(galleryAnchor))throw new Error('Review Android gallery selection');
exporter=exporter.replace(galleryAnchor,`    document.body.classList.toggle('android-gallery-export',!!cap.album);
    $('sf-ev-browse').hidden=!!cap.album;
    $('sf-ev-k-subtitle').closest('label').hidden=true;
    $('sf-ev-overwrite').closest('label').hidden=!!cap.album;
    $('sf-ev-k-subtitle').checked=false;if(cap.hasVideo&&!kbd.checked&&!kr.checked)kbd.checked=true;
    if(cap.album)$('sf-ev-overwrite').checked=false;`);
exporter=exporter.replace('这个项目没有关联视频，只能导出字幕文件。','请先关联视频，再导出到相册；字幕请使用导出菜单保存。');
fs.writeFileSync(exportFile,exporter);
console.log(`Android Studio: ${visited.size} shared browser modules, complete ASS editor + libass`);
