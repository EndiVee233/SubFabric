package com.subfabric.android;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** Desktop-compatible project ZIP; media is deliberately external. Never extracts paths. */
final class StudioPack {
    static final Set<String> FILES=new HashSet<>(Arrays.asList("project.json","subtitle.ass","subtitle.srt","asr.json","reseg.json","translation.json","notes.json","oplog.json","draft.log"));
    static byte[] export(JSONObject p)throws Exception {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(ZipOutputStream zip=new ZipOutputStream(bytes)){
            String subtitle=p.optString("subtitleName").toLowerCase().endsWith(".srt")?"subtitle.srt":"subtitle.ass";
            JSONObject meta=new JSONObject().put("name",p.optString("name")).put("subtitle",new JSONObject().put("file",subtitle).put("format",subtitle.endsWith(".ass")?"ass":"srt")).put("createdAt",p.optLong("createdAt"));
            if(p.has("kar"))meta.put("kar",p.get("kar"));if(p.has("region"))meta.put("region",p.get("region"));
            put(zip,"project.json",meta.toString());put(zip,subtitle,p.optString("text"));
            put(zip,"notes.json",p.optJSONArray("notes")==null?"[]":p.getJSONArray("notes").toString());put(zip,"oplog.json",p.optJSONArray("oplog")==null?"[]":p.getJSONArray("oplog").toString());
            JSONObject extras=p.optJSONObject("packExtras");if(extras!=null)for(Iterator<String> keys=extras.keys();keys.hasNext();){String name=keys.next();if(FILES.contains(name)&&!Arrays.asList("project.json","subtitle.ass","subtitle.srt","notes.json","oplog.json").contains(name))put(zip,name,extras.getString(name));}
        }
        return bytes.toByteArray();
    }
    private static void put(ZipOutputStream zip,String name,String text)throws Exception{zip.putNextEntry(new ZipEntry(name));zip.write(text.getBytes(StandardCharsets.UTF_8));zip.closeEntry();}
    static JSONObject read(InputStream input,StudioStore store)throws Exception {
        Map<String,String> files=new HashMap<>();Set<String> seen=new HashSet<>();long total=0;int count=0;
        try(ZipInputStream zip=new ZipInputStream(input)){
            for(ZipEntry entry;(entry=zip.getNextEntry())!=null;){
                if(++count>128)throw new IOException("项目包文件数量超过上限");String path=entry.getName();
                if(path.contains("\\")||path.contains(":")||path.startsWith("/")||Arrays.asList(path.split("/")).contains(".."))throw new IOException("项目包包含非法路径");
                if(entry.isDirectory())continue;if(path.split("/").length>2)throw new IOException("项目包目录层数过多");String name=path.substring(path.lastIndexOf('/')+1);
                if(!seen.add(name.toLowerCase(java.util.Locale.ROOT)))throw new IOException("项目包包含重复文件");
                ByteArrayOutputStream data=new ByteArrayOutputStream();byte[] buffer=new byte[65536];
                for(int n;(n=zip.read(buffer))!=-1;){total+=n;if(total>16*1024*1024)throw new IOException("项目包内容超过安卓编辑器 16 MB 上限");if(FILES.contains(name))data.write(buffer,0,n);}
                if(FILES.contains(name))files.put(name,data.toString("UTF-8"));
            }
        }
        String subtitle=files.containsKey("subtitle.ass")?"subtitle.ass":"subtitle.srt";
        if(!files.containsKey(subtitle))throw new IOException("项目包中没有 ASS 或 SRT 字幕");
        JSONObject meta=files.containsKey("project.json")?new JSONObject(files.get("project.json")):new JSONObject();
        JSONObject p=new JSONObject().put("name",meta.optString("name","导入的稿件")).put("subtitleName",subtitle).put("text",files.get(subtitle)).put("originalText",files.get(subtitle)).put("createdAt",System.currentTimeMillis());
        JSONObject kar=meta.optJSONObject("kar");if(kar!=null&&kar.optString("wordStyle").length()<121)p.put("kar",new JSONObject().put("wordStyle",kar.optString("wordStyle")));
        JSONObject region=meta.optJSONObject("region");if(region!=null&&region.optDouble("start",-1)>=0&&(region.isNull("end")||region.optDouble("end",-1)>region.optDouble("start")))p.put("region",new JSONObject().put("start",region.get("start")).put("end",region.get("end")));
        p.put("notes",files.containsKey("notes.json")?new JSONArray(files.get("notes.json")):new JSONArray());p.put("oplog",files.containsKey("oplog.json")?new JSONArray(files.get("oplog.json")):new JSONArray());
        JSONObject extras=new JSONObject();for(Map.Entry<String,String> entry:files.entrySet())if(!entry.getKey().equals("project.json"))extras.put(entry.getKey(),entry.getValue());p.put("packExtras",extras);
        return (JSONObject)store.call("studioCreate",new JSONObject().put("project",p));
    }
}
