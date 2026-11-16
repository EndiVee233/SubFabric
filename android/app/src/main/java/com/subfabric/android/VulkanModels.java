package com.subfabric.android;
import android.content.Context;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import org.json.*;
/** Exact Hugging Face revisions and GGUF digests are mirrored in vulkan-models.json. */
final class VulkanModels {
    static final class Spec {
        final String id,name,file,url,sha,license;final long bytes;final int kind;
        Spec(String id,String name,String file,String url,String sha,String license,long bytes,int kind){this.id=id;this.name=name;this.file=file;this.url=url;this.sha=sha;this.license=license;this.bytes=bytes;this.kind=kind;}
        File path(Context c){return new File(c.getFilesDir(),"asr-models/"+file);}
    }
    static final Spec[] ALL={
        new Spec("parakeet-tdt-0.6b-v2-android","Parakeet TDT v2","parakeet-tdt-0.6b-v2-q4_k.gguf","https://huggingface.co/cstr/parakeet-tdt-0.6b-v2-GGUF/resolve/8878172f3c45ba231fac8cfd4aff2542b13bc875/parakeet-tdt-0.6b-v2-q4_k.gguf","287f8a46b64e7785bbd634c2d17fe178145b70266c33f7e7aa8acbf7854d8518","cc-by-4.0",396937984L,1),
        new Spec("qwen3-asr-0.6b-android","Qwen3-ASR 0.6B","qwen3-asr-0.6b-q4_k.gguf","https://huggingface.co/cstr/qwen3-asr-1.7b-GGUF/resolve/674df5d44b50a63e7102a18895ed20e3f91de301/qwen3-asr-0.6b-q4_k.gguf","f63771c02dfa486d9399d41ab6ab8cd2d8ca24e077cd32130ea1f67f4fd8dade","apache-2.0",631026336L,2),
        new Spec("qwen3-forced-aligner-android","Qwen3 Forced Aligner 0.6B","qwen3-forced-aligner-0.6b-q8_0.gguf","https://huggingface.co/cstr/qwen3-forced-aligner-0.6b-GGUF/resolve/1ec5110602ccab18c878ddebedab0891e290a95c/qwen3-forced-aligner-0.6b-q8_0.gguf","539df5dd0fe1721e378ac13bfac9a26b1260dafb62d892c518c1f21244762636","apache-2.0",985594624L,3)
    };
    static Spec find(String id)throws IOException{for(Spec m:ALL)if(m.id.equals(id))return m;throw new IOException("未知安卓 Vulkan 模型");}
    static void verify(File file,Spec model)throws Exception{
        if(!file.isFile()||Files.isSymbolicLink(file.toPath())||file.length()!=model.bytes)throw new IOException("模型文件大小不匹配："+model.name);
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[1024*1024];
        try(InputStream in=new FileInputStream(file)){for(int n;(n=in.read(buffer))!=-1;){if(Thread.currentThread().isInterrupted())throw new IOException("模型校验已停止");digest.update(buffer,0,n);}}
        StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format("%02x",b&255));if(!hash.toString().equals(model.sha))throw new IOException("模型 SHA-256 校验失败："+model.name);
    }
    static String gpuIdentity(Context c,JSONObject gpu)throws Exception{return android.os.Build.FINGERPRINT+":"+gpu.optString("device")+":"+c.getPackageManager().getPackageInfo(c.getPackageName(),0).lastUpdateTime;}
    static JSONObject gpuStatus(Context c)throws Exception{
        JSONObject gpu=VulkanAsr.probe();File f=new File(c.getFilesDir(),"asr-gpu-health.json");
        if(f.isFile())try{JSONObject health=new JSONObject(new String(Files.readAllBytes(f.toPath()),java.nio.charset.StandardCharsets.UTF_8));if(health.optString("identity").equals(gpuIdentity(c,gpu)))gpu.put("available",false).put("error",health.getString("error"));}catch(JSONException ignored){}
        return gpu;
    }
    static void gpuFailure(Context c,String message)throws Exception{
        JSONObject gpu=VulkanAsr.probe(),health=new JSONObject().put("identity",gpuIdentity(c,gpu)).put("error","Vulkan 计算自检未通过；CPU 识别已禁用："+message);File target=new File(c.getFilesDir(),"asr-gpu-health.json"),part=new File(target.getPath()+".tmp");
        try(FileOutputStream out=new FileOutputStream(part)){out.write(health.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));out.getFD().sync();}Files.move(part.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
    }
    static synchronized JSONObject status(Context c)throws Exception{
        JSONObject gpu=gpuStatus(c);JSONArray models=new JSONArray();boolean ready=false;
        for(Spec m:ALL){File f=m.path(c);boolean ok=false;String key=m.id+":"+f.length()+":"+f.lastModified();
            if(f.isFile()&&f.length()==m.bytes){if(c.getSharedPreferences("vulkan-model-checks",0).getBoolean(key,false))ok=true;else try{verify(f,m);c.getSharedPreferences("vulkan-model-checks",0).edit().putBoolean(key,true).commit();ok=true;}catch(IOException ignored){}}
            if(m.kind!=3&&ok&&gpu.optBoolean("available"))ready=true;
            models.put(new JSONObject().put("id",m.id).put("name",m.name).put("kind",m.kind).put("filesOk",ok).put("ready",ok&&gpu.optBoolean("available")).put("bytes",f.isFile()?f.length():0).put("totalBytes",m.bytes).put("license",m.license));
        }
        return new JSONObject().put("gpu",gpu).put("models",models).put("ready",ready).put("segmentSeconds",600).put("cpuFallback",false);
    }
}
