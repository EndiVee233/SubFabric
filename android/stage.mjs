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
fs.writeFileSync(path.join(target,'android-llm-defaults.js'),`const ANTHROPIC_PROVIDER='anthropic';\n${presets}\n${prompts}\nexport {LLM_PRESETS,DEFAULT_TRANSLATE_PROMPT,systemPromptWithGlossary};\n`);
const llmText=fs.readFileSync(path.join(root,'editor/llm-text.js'),'utf8');
if(!llmText.includes('module.exports = {'))throw new Error('Review Android LLM parser exports');
fs.writeFileSync(path.join(target,'android-llm-text.js'),llmText.replace('module.exports = {','export {'));
fs.writeFileSync(path.join(target,'android-translation-doc.js'),fs.readFileSync(path.join(root,'android/translation-doc.mjs'),'utf8').replaceAll("'../editor/js/","'./js/"));
let html=fs.readFileSync(path.join(root,'editor/studio.html'),'utf8');
html=html.replace('只支持 bilibili 与 YouTube 链接。下载的视频存在项目目录里（删项目会连视频一起删）。','支持 bilibili、YouTube 与可解析的媒体链接。下载保存在安卓本机，可关联已有字幕或新建 ASS 稿件。');
html=html.replace('Cookie 只存在本机 asr/settings.json，界面永远不会回显它的值。','Cookie 加密保存在安卓本机，界面不会回显。');
html=html.replace(/<div class="st-grid">\s*<span class="st-lbl">从浏览器读<\/span>[\s\S]*?<select id="st-fetch-browser"[\s\S]*?<\/div>\s*<p class="gl-hint">[\s\S]*?<\/p>/,'<select id="st-fetch-browser" hidden><option value="">（不用）</option></select><p class="gl-hint">安卓请导入浏览器导出的 Netscape Cookie 文件。</p>');
html=html.replace('<script src="js/accent.js">','<script src="/studio/android-boot.js"></script><link rel="stylesheet" href="/studio/android.css"><script src="js/accent.js">');
html=html.replace('<script type="module" src="js/main.js"></script>','<script type="module" src="js/main.js"></script><script type="module" src="/studio/android-ui.js"></script>');
fs.writeFileSync(path.join(target,'studio.html'),html);
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
fs.writeFileSync(projectFile,project);
const mainFile=path.join(target,'js/main.js');
let main=fs.readFileSync(mainFile,'utf8');
const debugAnchor='window.__dbg = { state, assPlayer,';
if(!main.includes(debugAnchor))throw new Error('Review Android project refresh hook');
main=main.replace(debugAnchor,'window.__androidRefreshProject = async id => { Projects.detachProject(); await Projects.openProject(id); };\n'+debugAnchor);
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
fs.writeFileSync(exportFile,exporter);
console.log(`Android Studio: ${visited.size} shared browser modules, complete ASS editor + libass`);
