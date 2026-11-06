import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {serverFunctions} from './helpers/server-functions.mjs';
import vm from 'node:vm';
const require=createRequire(import.meta.url),secretStore=require('../editor/secret-store.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-cookie-fixture-'));
let settings={fetch:{}},requests=[],throwCli=false;
const youtube='# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tFAKE_YOUTUBE_FIXTURE\n.other.invalid\tTRUE\t/\tFALSE\t0\tignored\tFAKE_OTHER_SITE\n';
const globals={fs,path,os:{tmpdir:()=>root},secretStore,normalizeBiliCookie:s=>s,
  readAsrSettings:()=>structuredClone(settings),writeAsrSettings:s=>{settings=structuredClone(s);},fetchReady:()=>true,
  fetchSiteOf:url=>new URL(url).hostname.includes('bilibili')?'bilibili':'youtube',normalizeFetchUrl:s=>s,normalizePart:n=>n||1,
  readBody:(req,res,max,fn)=>fn(null,Buffer.from(JSON.stringify(req.data||{}))),
  sendJson:(res,status,value)=>res.resolve({status,value}),biliLoginCheck:async()=>({ok:true,isLogin:true}),
  runFetchCli:async(id,args)=>{const at=args.indexOf('--cookies-file');const text=at<0?'':fs.readFileSync(args[at+1],'utf8');requests.push({args:Array.from(args),text});if(throwCli)throw Error('fixture failure');return{done:{meta:{id:'fixture',title:'fixture',cookieWarning:'fixture fallback warning'}}};},
};
const f=serverFunctions(['normalizeYoutubeCookies','prepareFetchCookies','writeNetscapeCookieFile','fetchSettings','fetchPublicSettings','patchFetchSettings','handleFetchRoutes'],globals);
const api=(pathname,method='GET',data)=>new Promise(resolve=>f.handleFetchRoutes({method,data},{resolve},new URL('http://local'+pathname)));
try {
  assert.throws(()=>f.normalizeYoutubeCookies('not a cookie file'),/没有 YouTube Cookie/);
  assert.throws(()=>f.normalizeYoutubeCookies('.youtube.com\tTRUE\t/\tTRUE\tbad\tSID\tvalue'),/格式错误/);
  assert.throws(()=>f.normalizeYoutubeCookies('.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\u0000'),/格式错误/);
  const normalized=f.normalizeYoutubeCookies(youtube);assert.ok(normalized.includes('#HttpOnly_'));assert.ok(!normalized.includes('OTHER_SITE'));
  const saved=await api('/api/fetch/settings','POST',{youtubeCookies:youtube,cookiesFromBrowser:'chrome'});
  assert.equal(saved.status,200);assert.equal(saved.value.hasYoutubeCookies,true);
  assert.ok(settings.fetch.youtubeCookiesEnc.startsWith('aes:')||settings.fetch.youtubeCookiesEnc.startsWith('dpapi:'));
  assert.ok(!JSON.stringify(settings).includes('FAKE_YOUTUBE_FIXTURE'),'settings contain ciphertext only');
  const publicSettings=await api('/api/fetch/settings');assert.ok(!JSON.stringify(publicSettings).includes('FAKE_YOUTUBE_FIXTURE'));
  assert.equal(publicSettings.value.youtubeCookiesEnc,undefined);
  const before=JSON.stringify(settings);
  assert.equal((await api('/api/fetch/settings','POST',{youtubeCookies:'wrong file'})).status,400);
  assert.equal(JSON.stringify(settings),before,'bad import preserves old login');
  assert.equal((await api('/api/fetch/settings','POST',{youtubeCookies:'x'.repeat(256*1024+1)})).status,400);
  // Existing bilibili credentials must not override the separately imported YouTube login.
  settings.fetch.biliCookieEnc=secretStore.encrypt('SESSDATA=FAKE_BILI_FIXTURE');
  const result=await api('/api/fetch/probe','POST',{url:'https://youtu.be/fixture'});assert.equal(result.status,200);
  assert.equal(result.value.warning,'fixture fallback warning');assert.ok(requests.at(-1).text.includes('FAKE_YOUTUBE_FIXTURE'));
  assert.ok(!requests.at(-1).args.includes('--cookies-from-browser'));assert.ok(!requests.at(-1).text.includes('FAKE_BILI_FIXTURE'));
  assert.deepEqual(fs.readdirSync(root),[],'probe removes plaintext after success');
  await api('/api/fetch/probe','POST',{url:'https://www.bilibili.com/video/BVfixture'});
  assert.ok(requests.at(-1).text.includes('FAKE_BILI_FIXTURE'));assert.ok(!requests.at(-1).text.includes('FAKE_YOUTUBE_FIXTURE'));
  throwCli=true;assert.equal((await api('/api/fetch/probe','POST',{url:'https://youtu.be/fixture'})).status,500);throwCli=false;
  assert.deepEqual(fs.readdirSync(root),[],'probe removes plaintext after failure');
  assert.equal((await api('/api/fetch/settings','POST',{youtubeCookies:''})).value.hasYoutubeCookies,false);
  await api('/api/fetch/probe','POST',{url:'https://youtu.be/fixture'});
  assert.ok(requests.at(-1).args.includes('chrome'),'browser selection works even while bilibili Cookie exists');
  assert.equal(requests.at(-1).text,'');
  assert.ok(!JSON.stringify(requests.map(r=>r.args)).includes('FAKE_'),'credential values never enter argv');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
// Run the actual import/clear event registrations with browser File-shaped fixtures.
{
  const source=fs.readFileSync(new URL('../editor/js/project.js',import.meta.url),'utf8');
  const start=source.indexOf("  const youtubeFile = $('#st-fetch-youtube-file')");
  const end=source.indexOf('  // 编辑器工具栏也有一个设置入口',start);assert.ok(start>0&&end>start);
  const handlers=new Map(),messages=[],patches=[];let clicks=0,fail=false;
  const file={value:'fixture',files:[],click(){clicks++;},addEventListener:(type,fn)=>handlers.set(type,fn)};
  const button={disabled:false,addEventListener:(type,fn)=>handlers.set('import-'+type,fn)};
  const clear={addEventListener:(type,fn)=>handlers.set('clear-'+type,fn)};
  const ctx=vm.createContext({$:id=>({'#st-fetch-youtube-file':file,'#st-fetch-youtube-import':button,'#st-fetch-youtube-clear':clear})[id],
    toast:message=>messages.push(message),saveFetchSettings:async patch=>{patches.push(patch);return fail?null:{hasYoutubeCookies:true};}});
  vm.runInContext(source.slice(start,end),ctx);
  handlers.get('import-click')();assert.equal(clicks,1);
  file.files=[{size:100,text:async()=>youtube}];await handlers.get('change')();
  assert.equal(patches.at(-1).youtubeCookies,youtube);assert.equal(file.value,'');assert.equal(button.disabled,false);
  fail=true;messages.length=0;await handlers.get('change')();assert.equal(messages.length,0,'failed save never reports success');
  file.files=[{size:256*1024+1}];const count=patches.length;await handlers.get('change')();assert.equal(patches.length,count);
  fail=false;await handlers.get('clear-click')();assert.equal(patches.at(-1).youtubeCookies,'');
}
const python=process.env.SUBFABRIC_PYTHON||path.resolve('asr/runtime-python/python.exe');
if(!fs.existsSync(python))console.log('SKIP: Python unavailable; JS cookie routing passed, Python retry cases not run');
else execFileSync(python,['tests/fetch-cookie-retry-test.py'],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'},stdio:'pipe'});
console.log('fetch-browser-cookie: encrypted YouTube import, site isolation, temporary cleanup and Chrome/Edge retry passed');
