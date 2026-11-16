package com.subfabric.android;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Android-owned project documents. Original ASS remains the authoritative text. */
final class StudioStore {
    final File directory;
    StudioStore(File root) { directory=new File(root,"studio"); directory.mkdirs(); }
    File file(String id,String suffix) throws IOException {
        if(!id.matches("[0-9a-f-]{36}")) throw new IOException("无效的稿件 ID");
        return new File(directory,id+suffix);
    }
    JSONObject load(String id) throws Exception { return new JSONObject(new String(Files.readAllBytes(file(id,".json").toPath()),StandardCharsets.UTF_8)); }
    static String revision(String text) throws Exception {
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder out=new StringBuilder(); for(byte b:bytes) out.append(String.format("%02x",b&255)); return out.toString();
    }
    synchronized void write(JSONObject project) throws Exception {
        File dest=file(project.getString("id"),".json"), temp=new File(directory,dest.getName()+".tmp");
        try(FileOutputStream out=new FileOutputStream(temp)) {out.write(project.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(temp.toPath(),dest.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
    }
    synchronized Object call(String action,JSONObject args) throws Exception {
        switch(action) {
            case "studioList": {
                JSONArray list=new JSONArray(); File[] files=directory.listFiles((d,n)->n.matches("[0-9a-f-]{36}\\.json"));
                if(files!=null) {Arrays.sort(files,(a,b)->Long.compare(b.lastModified(),a.lastModified()));for(File f:files){JSONObject p=load(f.getName().replace(".json","")); p.remove("text");p.remove("originalText");p.remove("srtOriginalText");p.remove("packExtras");p.remove("oplog");p.remove("notes");list.put(p);}}
                return list;
            }
            case "studioLoad": return load(args.getString("id"));
            case "studioOpStats": {
                int days=Math.max(1,Math.min(365,args.optInt("days",7))),total=0;long cutoff=System.currentTimeMillis()-days*86400000L,deadline=System.currentTimeMillis()+5000;
                List<JSONObject> output=new ArrayList<>();File[] files=directory.listFiles((d,n)->n.matches("[0-9a-f-]{36}\\.json"));
                if(files!=null)for(File f:files){
                    if(System.currentTimeMillis()>deadline)throw new IOException("操作统计读取超时，请稍后重试");
                    JSONObject p=load(f.getName().substring(0,36));if(p.optBoolean("archived"))continue;JSONArray logs=p.optJSONArray("oplog");int count=0;
                    if(logs!=null)for(int i=0;i<logs.length();i++){JSONObject entry=logs.optJSONObject(i);if(entry==null)continue;try{if(java.time.Instant.parse(entry.optString("t")).toEpochMilli()>=cutoff)count++;}catch(Exception ignored){}}
                    if(count>0){total+=count;output.add(new JSONObject().put("id",p.getString("id")).put("name",p.optString("name")).put("count",count).put("modifiedAt",p.optLong("modifiedAt")));}
                }
                output.sort((a,b)->Integer.compare(b.optInt("count"),a.optInt("count")));
                return new JSONObject().put("days",days).put("total",total).put("projects",new JSONArray(output));
            }
            case "studioCreate": {
                JSONObject p=args.getJSONObject("project");p.put("id",UUID.randomUUID().toString());p.put("modifiedAt",System.currentTimeMillis());
                p.put("revision",revision(p.optString("text")));write(p);return p;
            }
            case "studioUpdate": {
                JSONObject p=load(args.getString("id")); JSONObject patch=args.getJSONObject("patch");
                if(patch.has("text") && args.has("revision") && !args.getString("revision").equals(p.optString("revision"))) throw new IOException("CONFLICT: 稿件已被更新，请重新打开");
                for(Iterator<String> keys=patch.keys();keys.hasNext();) {String key=keys.next();if(!key.equals("id")&&!key.equals("revision"))p.put(key,patch.get(key));}
                if(patch.has("text"))p.put("revision",revision(p.getString("text")));
                p.put("modifiedAt",System.currentTimeMillis());write(p);return p;
            }
            case "studioApplyAsr": {
                JSONObject p=load(args.getString("id")),draft=p.optJSONObject("draft");
                if(draft==null||!draft.optString("taskId").equals(args.getString("taskId"))||!p.optString("revision").equals(args.getString("revision"))||!p.optString("mediaId").equals(args.getString("mediaId")))throw new IOException("CONFLICT: 识别期间稿件已变化，原字幕保留");
                JSONObject patch=args.getJSONObject("patch");
                for(String key:new String[]{"text","originalText","subtitleName","draft"})if(patch.has(key))p.put(key,patch.get(key));
                if(patch.has("text"))p.put("revision",revision(p.getString("text")));
                p.put("modifiedAt",System.currentTimeMillis());write(p);return p;
            }
            case "studioApplyAlignment": {
                JSONObject p=load(args.getString("id")),task=p.optJSONObject("androidRealign");
                if(task==null||!task.optString("taskId").equals(args.getString("taskId"))||!p.optString("revision").equals(args.getString("revision"))||!p.optString("mediaId").equals(args.getString("mediaId"))||!task.optString("sourceFormat").equals("srt")||!task.optString("sourceRevision").equals(args.getString("revision"))||!task.optString("mediaId").equals(args.getString("mediaId"))||!task.optString("projectId").equals(p.getString("id")))throw new IOException("CONFLICT: 对齐期间稿件已变化，原字幕保留");
                if(!p.has("srtOriginalText"))p.put("srtOriginalText",p.optString("text"));
                if(!p.has("originalSubtitleName"))p.put("originalSubtitleName",p.optString("subtitleName","subtitle.srt"));
                p.put("text",args.getString("text")).put("subtitleName","subtitle.ass").put("revision",revision(args.getString("text"))).put("modifiedAt",System.currentTimeMillis());write(p);return p;
            }
            case "studioDelete": {
                // Preserve a recoverable private snapshot instead of deleting project assets.
                JSONObject p=load(args.getString("id")); p.put("archived",true);write(p);return new JSONObject().put("ok",true);
            }
            default: throw new IOException("未知的稿件操作");
        }
    }
}
