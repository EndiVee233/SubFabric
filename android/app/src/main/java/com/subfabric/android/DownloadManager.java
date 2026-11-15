package com.subfabric.android;

import android.content.*;
import android.app.ActivityManager;
import android.graphics.BitmapFactory;
import android.os.Process;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import com.arthenica.ffmpegkit.*;

/** Download-worker process owns networking and private media staging; the UI remains a separate process. */
public final class DownloadManager {
    private static DownloadManager instance;
    static synchronized DownloadManager get(Context context){if(instance==null)instance=new DownloadManager(context.getApplicationContext());return instance;}
    private final Context context;
    private final File root;
    private final DownloadSettings settings;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService clock=Executors.newScheduledThreadPool(2);
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private final boolean child;
    private JSONObject current;
    private volatile AbstractSession session;
    private ScheduledFuture<?> watchdog;
    private boolean working;
    private long lastProgress;
    private DownloadManager(Context context){this.context=context;root=new File(context.getFilesDir(),"download-jobs");root.mkdirs();settings=new DownloadSettings(context);boolean isChild=false;for(ActivityManager.RunningAppProcessInfo p:context.getSystemService(ActivityManager.class).getRunningAppProcesses())if(p.pid==Process.myPid())isChild=p.processName.equals(context.getPackageName()+":download");child=isChild;}
    File folder(String id) throws IOException {if(!id.matches("[0-9a-f-]{36}"))throw new IOException("下载任务 ID 无效");return new File(root,id);}
    private JSONObject read(String id,String name) throws Exception {return new JSONObject(new String(Files.readAllBytes(new File(folder(id),name).toPath()),StandardCharsets.UTF_8));}
    private void write(String id,String name,JSONObject data) throws Exception {File file=new File(folder(id),name),temp=new File(file.getPath()+".tmp");try(FileOutputStream out=new FileOutputStream(temp)){out.write(data.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}Files.move(temp.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}
    @SuppressWarnings("deprecation") private boolean alive(){for(ActivityManager.RunningServiceInfo s:context.getSystemService(ActivityManager.class).getRunningServices(64))if(s.service.getClassName().equals(DownloadService.class.getName())&&s.pid>0)return true;return false;}
    @SuppressWarnings("deprecation") private boolean ownerAlive(JSONObject job){for(ActivityManager.RunningServiceInfo s:context.getSystemService(ActivityManager.class).getRunningServices(64))if(s.service.getClassName().equals(DownloadService.class.getName())&&s.pid>0&&(!job.has("pid")||job.optInt("pid")==s.pid))return true;return false;}
    private synchronized void persist() throws Exception {current.put("updatedAt",System.currentTimeMillis());write(current.getString("id"),"job.json",current);DownloadService.progress(context,current);}
    static String url(String value) throws Exception {
        String raw=value.trim();if(!raw.contains("://"))raw="https://"+raw;
        if(raw.length()>8192||raw.matches("(?s).*[\\p{Cntrl}].*"))throw new IOException("链接格式无效");URI uri=new URI(raw);
        if(uri.getHost()==null||uri.getUserInfo()!=null||!String.valueOf(uri.getScheme()).matches("https?"))throw new IOException("仅支持不含账号密码的 HTTP/HTTPS 链接");
        LlmClient.endpoint(new JSONObject().put("baseUrl",raw.split("#",2)[0]));return raw.split("#",2)[0];
    }
    private static String display(String value) throws Exception {URI uri=new URI(value);return new URI(uri.getScheme(),null,uri.getHost(),uri.getPort(),uri.getPath(),null,null).toString();}
    synchronized JSONObject start(JSONObject input) throws Exception {
        String active=context.getSharedPreferences("download",0).getString("active","");
        if(alive()||!active.isEmpty()&&status(active).optString("status").equals("running"))throw new IOException("已有下载或解析任务进行中");
        String kind=input.optString("kind","download");if(!kind.matches("download|probe|runtime|cookie"))throw new IOException("下载任务类型无效");
        JSONObject cfg=settings.read();String quality=input.optString("quality",cfg.optString("quality","best"));if(!DownloadSettings.quality(quality))throw new IOException("画质档位无效");
        String link=kind.matches("runtime|cookie")?"https://www.bilibili.com/":url(input.getString("url"));
        String id=UUID.randomUUID().toString();File folder=folder(id);if(!folder.mkdir())throw new IOException("无法准备下载目录");
        JSONObject request=new JSONObject().put("kind",kind).put("urlEnc",settings.seal(link)).put("quality",quality).put("part",Math.max(1,Math.min(100000,input.optInt("part",1)))).put("settings",cfg).put("attempt",0);
        JSONObject job=new JSONObject().put("id",id).put("kind",kind).put("status","running").put("stage","正在准备下载组件").put("pct",0).put("bytes",0).put("url",display(link)).put("quality",quality).put("startedAt",System.currentTimeMillis());
        write(id,"request.json",request);write(id,"job.json",job);context.getSharedPreferences("download",0).edit().putString("active",id).commit();
        try{context.startForegroundService(new Intent(context,DownloadService.class).putExtra("jobId",id));}catch(Exception e){job.put("status","error").put("error","无法启动下载前台任务");write(id,"job.json",job);throw e;}return job;
    }
    synchronized JSONObject status(String id) throws Exception {
        if(child&&current!=null&&current.optString("id").equals(id))return new JSONObject(current.toString());
        JSONObject job=read(id,"job.json");
        if(job.optString("status").equals("running")&&!ownerAlive(job)&&(job.has("pid")||System.currentTimeMillis()-job.optLong("startedAt")>5000)){
            job.put("status",job.optBoolean("cancelRequested")?"cancelled":"interrupted").put("error",job.optBoolean("cancelRequested")?"下载已取消":"下载已中断，可重新开始");write(id,"job.json",job);
        }return job;
    }
    synchronized JSONObject retry(String id) throws Exception {
        JSONObject job=status(id);if(!job.optString("kind").equals("download")||!job.optString("status").matches("error|cancelled|interrupted"))throw new IOException("此任务无法重新下载");
        if(alive())throw new IOException("已有下载或解析任务进行中");
        JSONObject request=read(id,"request.json");request.put("settings",settings.read()).put("attempt",request.optInt("attempt")+1);
        job.remove("error");job.remove("cancelRequested");job.remove("pid");job.put("status","running").put("stage","正在重新下载").put("pct",0).put("bytes",0).put("startedAt",System.currentTimeMillis());
        write(id,"request.json",request);write(id,"job.json",job);context.getSharedPreferences("download",0).edit().putString("active",id).commit();
        try{context.startForegroundService(new Intent(context,DownloadService.class).putExtra("jobId",id));}catch(Exception e){job.put("status","error").put("error","无法启动下载前台任务");write(id,"job.json",job);throw e;}return job;
    }
    synchronized JSONArray list() throws Exception {File[] dirs=root.listFiles(f->f.isDirectory()&&f.getName().matches("[0-9a-f-]{36}"));JSONArray jobs=new JSONArray();if(dirs!=null){Arrays.sort(dirs,(a,b)->Long.compare(b.lastModified(),a.lastModified()));for(File f:dirs){if(jobs.length()>=200)break;try{JSONObject job=status(f.getName());if(job.optString("kind").equals("download"))jobs.put(job);}catch(Exception ignored){}}}return jobs;}
    synchronized boolean running(){return current!=null&&current.optString("status").equals("running");}
    void cancel(String id) throws Exception {
        if(!child){if(alive())context.startService(new Intent(context,DownloadService.class).setAction("cancel").putExtra("jobId",id));return;}
        synchronized(this){if(current==null||!current.optString("id").equals(id)||!running())return;cancelled.set(true);current.put("cancelRequested",true).put("stage","正在取消下载");persist();}
        stopAfter(id,"cancelled","下载已取消",3);AbstractSession active=session;if(active!=null)active.cancel();
    }
    void debugCrash(String id) throws Exception {if((context.getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0)throw new IOException("仅开发构建允许故障注入");if(child){if(current!=null&&current.optString("id").equals(id)&&running())Process.killProcess(Process.myPid());}else{if(!alive())throw new IOException("没有运行中的下载任务");context.startService(new Intent(context,DownloadService.class).setAction("debug-crash").putExtra("jobId",id));}}
    String diagnostic(String id) throws Exception {
        if((context.getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0)throw new IOException("仅开发构建允许诊断");JSONObject config=read(id,"request.json").getJSONObject("settings");
        if(!config.optString("biliEnc").isEmpty()||!config.optString("youtubeEnc").isEmpty())throw new IOException("含登录信息的任务不提供明文诊断");
        return settings.unseal(new String(Files.readAllBytes(new File(folder(id),"error.enc").toPath()),StandardCharsets.UTF_8)).replaceAll("https?://[^\\s'\"]+","[链接]");
    }
    private void stopAfter(String id,String state,String message,long seconds){clock.schedule(()->{synchronized(this){if(child&&current!=null&&current.optString("id").equals(id)&&running()){try{current.put("status",state).put("error",message);persist();}catch(Exception ignored){}Process.killProcess(Process.myPid());}}},seconds,TimeUnit.SECONDS);}
    synchronized void receive(String id) throws Exception {
        if(!child||working)throw new IOException("下载任务启动失败");current=read(id,"job.json");if(!current.optString("status").equals("running"))throw new IOException("下载任务状态已变化");
        JSONObject request=read(id,"request.json");current.put("pid",Process.myPid());persist();working=true;cancelled.set(false);
        watchdog=clock.schedule(()->stopAfter(id,"error","下载任务超时，请重试",3),request.optString("kind").equals("download")?4*60*60:120,TimeUnit.SECONDS);
        worker.execute(()->run(id,request));
    }
    private void check() throws IOException {if(cancelled.get())throw new IOException("下载已取消");}
    public final class JobCallback implements DownloadRuntime.Callback {
        @Override public boolean isCancelled(){return cancelled.get();}
        @Override public void onProgress(long bytes,long total,double pct,String stage){long now=System.currentTimeMillis();if(now-lastProgress<350)return;lastProgress=now;try{synchronized(DownloadManager.this){current.put("bytes",bytes).put("total",total).put("pct",Math.max(0,Math.min(90,pct))).put("stage",stage);persist();}}catch(Exception ignored){}}
    }
    private void run(String id,JSONObject request){
        try{
            DownloadRuntime runtime=new DownloadRuntime(context);JSONObject result;
            if(request.optString("kind").equals("runtime"))result=runtime.info();else{
                JSONObject cfg=request.getJSONObject("settings");JSONObject plain=new JSONObject(request.toString());plain.remove("settings");plain.remove("urlEnc");plain.put("url",settings.unseal(request.getString("urlEnc"))).put("proxy",cfg.optString("proxy"));
                result=runtime.run(plain,folder(id),settings.secret(cfg,"biliEnc"),settings.secret(cfg,"youtubeEnc"),new JobCallback());
                check();if(request.optString("kind").equals("download"))result=publishMedia(id,result);
            }
            File thumbnail=new File(folder(id),"thumbnail.bin");if(thumbnail.isFile()){BitmapFactory.Options image=new BitmapFactory.Options();image.inJustDecodeBounds=true;BitmapFactory.decodeFile(thumbnail.getPath(),image);if(image.outWidth<=0||image.outHeight<=0||(long)image.outWidth*image.outHeight>16000000)thumbnail.delete();}
            result.put("hasThumbnail",thumbnail.isFile());
            synchronized(this){current.put("status","done").put("pct",100).put("stage","已完成").put("result",result);persist();}
        }catch(Throwable error){try{synchronized(this){String raw=error.getClass().getSimpleName()+": "+(error.getMessage()==null?"":error.getMessage());if(raw.length()>8000)raw=raw.substring(0,8000);Files.write(new File(folder(id),"error.enc").toPath(),settings.seal(raw).getBytes(StandardCharsets.UTF_8));String message=cancelled.get()?"下载已取消":"下载失败，请检查链接、登录态或网络";java.util.regex.Matcher http=java.util.regex.Pattern.compile("HTTP(?: Error)?[: ]+(\\d{3})").matcher(raw);if(http.find())message+="（HTTP "+http.group(1)+"）";current.put("status",cancelled.get()?"cancelled":"error").put("error",message);persist();}}catch(Exception ignored){}}
        finally{if(watchdog!=null)watchdog.cancel(false);context.stopService(new Intent(context,DownloadService.class));synchronized(this){working=false;}}
    }
    private JSONObject publishMedia(String id,JSONObject result) throws Exception {
        JSONArray tracks=result.getJSONArray("tracks");if(tracks.length()<1||tracks.length()>4)throw new IOException("下载媒体轨道无效");File dir=folder(id);List<File> files=new ArrayList<>();
        for(int i=0;i<tracks.length();i++){String name=tracks.getJSONObject(i).getString("file");if(!name.matches("track-[a-zA-Z0-9_-]+\\.[a-z0-9]{1,8}"))throw new IOException("下载文件名无效");File f=new File(dir,name);if(!f.isFile()||f.length()==0)throw new IOException("下载文件不完整");files.add(f);}
        check();synchronized(this){current.put("stage","正在合并并检查媒体").put("pct",94);persist();}
        File output=new File(dir,"complete.mp4");
        if(files.size()==1&&tracks.getJSONObject(0).optString("ext").equals("mp4")){Files.copy(files.get(0).toPath(),output.toPath(),StandardCopyOption.REPLACE_EXISTING);}else{
            List<String> args=new ArrayList<>(Arrays.asList("-hide_banner","-nostats","-v","warning","-y"));
            for(File file:files)Collections.addAll(args,"-protocol_whitelist","file,pipe","-i",file.getPath());
            boolean video=false,audio=false;for(int i=0;i<tracks.length();i++){JSONObject track=tracks.getJSONObject(i);if(!video&&track.optBoolean("video")){Collections.addAll(args,"-map",i+":v:0?");video=true;}if(!audio&&track.optBoolean("audio")){Collections.addAll(args,"-map",i+":a:0?");audio=true;}}
            Collections.addAll(args,"-c","copy","-movflags","+faststart",output.getPath());
            FFmpegSession merge=FFmpegSession.create(args.toArray(new String[0]),null,log->{},stat->{},LogRedirectionStrategy.NEVER_PRINT_LOGS);session=merge;
            ScheduledFuture<?> limit=clock.schedule(()->{stopAfter(id,"error","媒体合并超时，请重试",3);merge.cancel();},10,TimeUnit.MINUTES);
            try{FFmpegKitConfig.ffmpegExecute(merge);check();if(merge.getReturnCode()==null||!ReturnCode.isSuccess(merge.getReturnCode()))throw new IOException("媒体合并失败");}finally{limit.cancel(false);session=null;}
        }
        check();if(output.length()==0||output.length()>2L*1024*1024*1024)throw new IOException("下载媒体体积无效");
        android.media.MediaExtractor extractor=new android.media.MediaExtractor();boolean hasVideo=false,hasAudio=false;try{extractor.setDataSource(output.getPath());for(int i=0;i<extractor.getTrackCount();i++){String type=extractor.getTrackFormat(i).getString(android.media.MediaFormat.KEY_MIME);hasVideo|=type.startsWith("video/");hasAudio|=type.startsWith("audio/");}}finally{extractor.release();}if(!hasVideo&&!hasAudio)throw new IOException("安卓无法读取下载媒体");
        String mediaId=UUID.randomUUID().toString();File media=new File(context.getFilesDir(),"media");media.mkdirs();File destination=new File(media,mediaId+".media");Files.move(output.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);
        JSONObject source=result.getJSONObject("source");String name=source.optString("title","在线素材")+".mp4",mime=hasVideo?"video/mp4":"audio/mp4";
        JSONObject legacy=new JSONObject().put("id",mediaId).put("title",name).put("mime",mime).put("media",true).put("cues",new JSONArray()).put("updated",System.currentTimeMillis());
        File metadata=new File(context.getFilesDir(),"projects/"+mediaId+".json");Files.write(metadata.toPath(),legacy.toString().getBytes(StandardCharsets.UTF_8));
        return new JSONObject().put("mediaId",mediaId).put("mediaName",name).put("source",source).put("bytes",destination.length()).put("hasVideo",hasVideo).put("hasAudio",hasAudio);
    }
    void stopped(String id){try{if(child&&current!=null&&current.optString("id").equals(id)&&running())cancel(id);}catch(Exception ignored){}}
}
