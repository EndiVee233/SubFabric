import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {connect,shell} from './cdp.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));let c=await connect();const ev=s=>c.evaluate(s),rpc=(a,p={})=>ev(`androidRpc(${JSON.stringify(a)},${JSON.stringify(p)})`);
const before=await rpc('downloadSettings');if(before.hasBiliCookie||before.hasYoutubeCookies){c.close();throw new Error('Use an isolated profile without existing download credentials for this settings fixture');}
const fake='android-isolated-fake-cookie',youtube='# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\t'+fake+'\n',results=[];
async function until(fn){for(let i=0;i<100;i++){const x=await fn();if(x)return x;await wait(150);}throw new Error('Settings timeout');}
try{
 await ev(`location.hash='#/settings'`);await wait(600);await ev(`document.getElementById('sf-settings-tab-fetch').click();document.getElementById('st-fetch-cookie').value='SESSDATA=${fake}';document.getElementById('st-fetch-cookie-save').click()`);
 await until(async()=>(await rpc('downloadSettings')).hasBiliCookie);await until(()=>ev(`document.getElementById('st-fetch-cookie').value===''`));
 await ev(`(()=>{const input=document.getElementById('st-fetch-youtube-file'),dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(youtube)}],'cookies.txt',{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(async()=>(await rpc('downloadSettings')).hasYoutubeCookies);
 const config=await rpc('downloadSettings');assert.equal(JSON.stringify(config).includes(fake),false);assert.equal(config.cookieBackend,'android-keystore');const disk=shell('exec-out','run-as','com.subfabric.android','cat','files/download-settings.json');assert.equal(disk.includes(fake),false);assert.match(disk,/biliEnc/);assert.match(disk,/youtubeEnc/);
 // The original settings UI may have an optional login check in flight: cancel only this app's metadata job.
 const active=shell('exec-out','run-as','com.subfabric.android','cat','shared_prefs/download.xml').match(/name="active">([^<]+)/)?.[1];if(active)await rpc('downloadCancel',{id:active});await wait(1000);
 await ev('__subfabricFlushSave()');c.close();shell('shell','am','force-stop','com.subfabric.android');shell('shell','am','start','-n','com.subfabric.android/.MainActivity');await wait(1200);c=await connect();await until(()=>ev('window.androidReady'));
 const reopened=await rpc('downloadSettings');assert.equal(reopened.hasBiliCookie,true);assert.equal(reopened.hasYoutubeCookies,true);assert.equal(JSON.stringify(reopened).includes(fake),false);
 results.push('Production cookie-save and Netscape-file import work, fields clear, public API never returns credentials, disk holds ciphertext, settings survive cold reopen');
 const job=await until(async()=>{try{return await rpc('downloadStart',{kind:'runtime'});}catch(error){if(!/已有下载或解析/.test(error.message))throw error;return false;}});await until(async()=> (await rpc('downloadStatus',{id:job.id})).status!=='running');await assert.rejects(()=>rpc('downloadDebugDiagnostic',{id:job.id}),/含登录信息/);results.push('Credential-bearing job snapshots refuse plaintext diagnostic output');
 await fs.writeFile(new URL('./out/download-settings-results.json',import.meta.url),JSON.stringify({results},null,2));console.log(results);
}finally{await rpc('downloadSettings',{patch:{biliCookie:'',youtubeCookies:'',quality:before.quality,proxy:before.proxy}}).catch(()=>{});await ev(`location.hash='#/home'`).catch(()=>{});c.close();}
