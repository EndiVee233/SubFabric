const rpc=(action,data)=>window.androidRpc(action,data);
async function fontIds(){
  const doc=window.__dbg?.state.assDoc,ids=[],fallbackFonts=[];
  if(!doc)return {fontIds:ids,fallbackFonts};
  const names=new Set([...doc.styles.values()].map(style=>style.values[style.format.indexOf('fontname')]).filter(Boolean));
  for(const name of names){
    if(name.toLowerCase()==='noto sans cjk sc')continue;
    const blob=await window.__dbg.assPlayer._fontBlob(name);
    if(!blob){fallbackFonts.push(name);continue;}
    if(blob.size>16*1024*1024)throw new Error('字体文件超过导出上限');
    const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
    const saved=await rpc('videoFont',{base64});ids.push(saved.id);
  }
  return {fontIds:[...new Set(ids)],fallbackFonts};
}
export async function route(id,path,method,options){
  if(path==='/capabilities'){
    const data=await rpc('videoCapabilities',{id});
    const hardware=Object.values(data.codecs).some(codec=>codec.hardware.length>0);
    return {...data,androidHardware:hardware,androidSummary:hardware?'优先试跑 MediaCodec 硬件编码，失败后回退软件编码。':'当前未发现硬件编码器候选，将试跑软件编码。'};
  }
  if(path==='/status')return rpc('videoStatus',{id});
  if(path==='/cancel'&&method==='POST')return rpc('videoCancel',{id});
  if(path===''&&method==='POST'){
    if(options.outDir==='相册 / SubFabric'){options.destination='gallery';options.overwrite=false;}
    if(options.kinds?.includes('bilingual')){
      const {injectSacrificialEvent}=await import('/editor/android-hardsub.js');
      const raw=options.subtitleText??(await window.androidStudio.load(id)).text;
      options.renderSubtitleText=injectSacrificialEvent(raw).text;
      Object.assign(options,await fontIds());
    }
    return rpc('videoStart',{id,options});
  }
  throw new Error('视频导出操作无效');
}
