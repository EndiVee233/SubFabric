package com.subfabric.android;

import android.content.Context;
import android.app.ActivityManager;
import android.os.StatFs;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;

/** Private storage inventory. Cleanup accepts scan IDs, never client paths, and only regenerable inactive audio caches. */
final class AppStorage {
    private final Context context;
    private final StudioStore studio;
    private final Map<String,Entry> registered=new HashMap<>();
    private long deadline,expires;
    private int visited;
    private boolean truncated;
    private static final class Entry {
        String id,project,revision;long modified;
        final List<File> files=new ArrayList<>();
        final Map<String,String> stamps=new HashMap<>();
    }
    AppStorage(Context context,StudioStore studio){this.context=context;this.studio=studio;}
    private boolean safe(File file) throws IOException {return !Files.isSymbolicLink(file.toPath())&&file.getCanonicalPath().startsWith(context.getDataDir().getCanonicalPath()+File.separator);}
    private long size(File file) throws IOException {
        if(++visited>200000||System.currentTimeMillis()>deadline){truncated=true;return 0;}
        if(!file.exists()||!safe(file))return 0;if(file.isFile())return file.length();long bytes=0;File[] children=file.listFiles();if(children!=null)for(File child:children)bytes+=size(child);return bytes;
    }
    private String stamp(File file) throws Exception {
        android.system.StructStat s=android.system.Os.lstat(file.getPath());
        String value=s.st_dev+":"+s.st_ino+":"+s.st_size+":"+s.st_mtime+":"+s.st_ctime;
        if(android.os.Build.VERSION.SDK_INT>=27)value+=":"+s.st_mtim.tv_nsec+":"+s.st_ctim.tv_nsec;
        return value;
    }
    @SuppressWarnings("deprecation") private boolean mediaTask(){for(ActivityManager.RunningServiceInfo s:context.getSystemService(ActivityManager.class).getRunningServices(64))if(s.pid>0&&(s.service.getClassName().equals(ExportService.class.getName())||s.service.getClassName().equals(DownloadService.class.getName())||s.service.getClassName().equals(AsrService.class.getName())))return true;return false;}
    private void item(JSONArray items,String category,String name,String detail,long bytes,Entry entry) throws Exception {
        if(bytes==0)return;String id=UUID.randomUUID().toString();if(entry!=null){entry.id=id;registered.put(id,entry);}
        items.put(new JSONObject().put("id",id).put("category",category).put("name",name).put("detail",detail).put("size",bytes).put("removable",entry!=null));
    }
    synchronized JSONObject scan(String protectedProject) throws Exception {
        if(Files.isSymbolicLink(studio.directory.toPath()))throw new IOException("稿件目录不可安全扫描");
        deadline=System.currentTimeMillis()+15000;expires=System.currentTimeMillis()+10*60*1000;visited=0;truncated=false;registered.clear();JSONArray items=new JSONArray();boolean active=mediaTask();
        Set<String> groups=new HashSet<>();long documents=0;
        File[] files=studio.directory.listFiles();if(files!=null)for(File file:files){
            if(!safe(file))continue;String name=file.getName();
            if(!name.matches("[0-9a-f-]{36}\\.(audio\\.wav|peaks\\.bin)")){documents+=size(file);continue;}
            String id=name.substring(0,36);if(!groups.add(id))continue;
            JSONObject p;try{p=studio.load(id);}catch(Exception ignored){groups.remove(id);documents+=size(file);continue;}
            Entry entry=new Entry();entry.project=id;entry.revision=p.optString("revision");entry.modified=p.optLong("modifiedAt");long bytes=0;
            for(String suffix:new String[]{".audio.wav",".peaks.bin"}){File cache=studio.file(id,suffix);if(cache.isFile()&&safe(cache)){entry.files.add(cache);entry.stamps.put(cache.getName(),stamp(cache));bytes+=size(cache);}}
            boolean removable=!active&&!id.equals(protectedProject)&&p.optString("mediaId").matches("[0-9a-f-]{36}")&&new File(context.getFilesDir(),"media/"+p.optString("mediaId")+".media").isFile();
            item(items,"project",p.optString("name","稿件")+" · 音频与波形",removable?"可从本机原媒体重新生成；字幕与原媒体保留":"当前稿件、后台任务或缺少原媒体：保留缓存",bytes,removable?entry:null);
        }
        item(items,"project","稿件、备注与操作记录","字幕、项目包附加信息与历史记录受保护",documents,null);
        File root=context.getFilesDir();
        for(String[] group:new String[][]{{"media","project","原始媒体"},{"projects","project","媒体索引"},{"models","model","语音模型"},{"parakeet","model","Parakeet 语音模型"},{"chaquopy","runtime","Python 运行组件"},{"download-runtime","runtime","下载运行时"},{"download-jobs","cache","下载任务与分片"},{"export-jobs","cache","导出任务与快照"},{"export-fonts","cache","导出字体"},{"fonts","cache","字体"}})
            item(items,group[1],group[2],"保留，不参与本页清理",size(new File(root,group[0])),null);
        Set<String> known=new HashSet<>(Arrays.asList("studio","media","projects","models","parakeet","chaquopy","download-runtime","download-jobs","export-jobs","export-fonts","fonts"));long other=0;File[] children=root.listFiles();if(children!=null)for(File f:children)if(!known.contains(f.getName()))other+=size(f);
        for(String dir:new String[]{"app_webview","shared_prefs","databases","code_cache","cache"})other+=size(new File(context.getDataDir(),dir));
        item(items,"cache","配置、浏览器数据及其它应用文件","包含登录配置、导入字体与界面偏好，均受保护",other,null);
        File apk=new File(context.getApplicationInfo().sourceDir);item(items,"runtime","应用安装包","应用代码与内置组件，受系统管理",apk.length(),null);
        long nativeBytes=0;File[] libraries=new File(context.getApplicationInfo().nativeLibraryDir).listFiles();if(libraries!=null)for(File f:libraries)if(f.isFile()&&!Files.isSymbolicLink(f.toPath()))nativeBytes+=f.length();
        item(items,"runtime","原生组件","系统安装的应用原生组件，受保护",nativeBytes,null);
        StatFs disk=new StatFs(context.getFilesDir().getPath());long total=disk.getTotalBytes(),free=disk.getAvailableBytes();
        return new JSONObject().put("items",items).put("disk",new JSONObject().put("total",total).put("free",free).put("used",total-free)).put("truncated",truncated).put("android",true).put("scannedAt",System.currentTimeMillis());
    }
    synchronized JSONObject clean(JSONArray ids,String protectedProject) throws Exception {
        if(Files.isSymbolicLink(studio.directory.toPath()))throw new IOException("稿件目录不可安全扫描");
        if(expires<System.currentTimeMillis())throw new IOException("CONFLICT: 扫描已过期，请重新扫描");
        if(ids.length()==0||ids.length()>1000)throw new IOException("清理条目数量无效");
        // Validate the whole request before deleting anything.
        for(int i=0;i<ids.length();i++)if(!registered.containsKey(ids.getString(i)))throw new IOException("CONFLICT: 条目不在本次可清理列表，请重新扫描");
        if(mediaTask())throw new IOException("CONFLICT: 后台媒体任务正在运行，请稍后重新扫描");
        JSONArray removed=new JSONArray(),failed=new JSONArray();long freed=0,limit=System.currentTimeMillis()+15000;
        synchronized(studio){for(int i=0;i<ids.length();i++){
            String key=ids.getString(i);Entry e=registered.get(key);if(e==null)continue;
            try{
                JSONObject p=studio.load(e.project);if(System.currentTimeMillis()>limit||e.project.equals(protectedProject)||!p.optString("revision").equals(e.revision)||p.optLong("modifiedAt")!=e.modified||!new File(context.getFilesDir(),"media/"+p.optString("mediaId")+".media").isFile())throw new IOException("稿件状态已变化");
                for(File f:e.files)if(!safe(f)||!f.isFile()||!stamp(f).equals(e.stamps.get(f.getName())))throw new IOException("缓存文件已变化");
                // Clear only regeneration metadata. Text, originals, notes and history are never part of the patch.
                studio.call("studioUpdate",new JSONObject().put("id",e.project).put("patch",new JSONObject().put("hasAudio",false).put("hasPeaks",false).put("prepare",JSONObject.NULL)));
                for(File f:e.files){long bytes=f.length();Files.delete(f.toPath());freed+=bytes;}
                removed.put(key);registered.remove(key);
            }catch(Exception ignored){failed.put(new JSONObject().put("id",key).put("name","缓存状态已变化，请重新扫描"));registered.remove(key);}
        }}
        return new JSONObject().put("ok",true).put("freed",freed).put("removed",removed).put("failed",failed);
    }
}
