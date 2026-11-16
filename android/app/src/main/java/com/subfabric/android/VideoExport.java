package com.subfabric.android;

import android.content.*;
import android.media.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import com.arthenica.ffmpegkit.*;

/** One foreground export at a time. Immutable input snapshot, private staging, gallery/SAF publication after validation. */
final class VideoExport {
    private static VideoExport instance;
    static synchronized VideoExport get(Context context){if(instance==null)instance=new VideoExport(context.getApplicationContext());return instance;}
    private final Context context;
    private final StudioStore store;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService clock=Executors.newScheduledThreadPool(2);
    private final File root,fonts;
    private final boolean exporter;
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private volatile AbstractSession session;
    private volatile JSONObject job;
    private volatile long deadline;
    private String encoders;
    private boolean working;
    private ScheduledFuture<?> jobTimeout;
    private VideoExport(Context context){this.context=context;store=new StudioStore(context.getFilesDir());root=new File(context.getFilesDir(),"export-jobs");root.mkdirs();fonts=new File(context.getFilesDir(),"export-fonts");fonts.mkdirs();boolean child=false;for(android.app.ActivityManager.RunningAppProcessInfo p:context.getSystemService(android.app.ActivityManager.class).getRunningAppProcesses())if(p.pid==android.os.Process.myPid())child=p.processName.equals(context.getPackageName()+":export");exporter=child;}
    @SuppressWarnings("deprecation") private boolean serviceAlive(){for(android.app.ActivityManager.RunningServiceInfo s:context.getSystemService(android.app.ActivityManager.class).getRunningServices(64))if(s.service.getClassName().equals(ExportService.class.getName())&&s.pid>0)return true;return false;}
    private void check() throws IOException {if(cancelled.get()||Thread.currentThread().isInterrupted()||System.currentTimeMillis()>deadline)throw new IOException("导出已停止或超时");}
    synchronized boolean running(){return job!=null&&job.optString("status").equals("running");}
    void cancel(String projectId){
        if(!exporter){if(serviceAlive())context.startService(new Intent(context,ExportService.class).setAction("cancel").putExtra("projectId",projectId));return;}
        if(job!=null&&job.optString("projectId").equals(projectId)&&running()){
            cancelled.set(true);try{synchronized(this){job.put("cancelRequested",true);persist();}}catch(Exception ignored){}
            hardStopJob(job.optString("id"),"cancelled","导出已取消");
            AbstractSession current=session;if(current!=null){hardStopIfStuck(current,"cancelled","导出已取消");current.cancel();}
        }
    }
    synchronized void serviceStopped(String jobId){if(job!=null&&job.optString("id").equals(jobId))cancel(job.optString("projectId"));}
    void debugCrash(String projectId) throws Exception {
        if((context.getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)==0)throw new IOException("仅开发构建允许故障注入");
        if(exporter){if(job!=null&&job.optString("projectId").equals(projectId)&&running())android.os.Process.killProcess(android.os.Process.myPid());}
        else {if(!serviceAlive()||!status(projectId).optString("status").equals("running"))throw new IOException("没有运行中的导出任务");context.startService(new Intent(context,ExportService.class).setAction("debug-crash").putExtra("projectId",projectId));}
    }
    private synchronized void persist() throws Exception {
        if(job==null)return;File file=store.file(job.getString("projectId"),".export.json"),tmp=new File(file.getPath()+".tmp");
        try(FileOutputStream out=new FileOutputStream(tmp)){out.write(job.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        ExportService.progress(context,job);
    }
    synchronized JSONObject status(String id) throws Exception {
        if(exporter&&job!=null&&job.optString("projectId").equals(id))return new JSONObject(job.toString());
        File file=store.file(id,".export.json");if(!file.isFile())return new JSONObject().put("status","idle");
        JSONObject saved=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        if(saved.optString("status").equals("running")&&!serviceAlive()&&(saved.has("pid")||System.currentTimeMillis()-saved.optLong("startedAt")>5000)){
            saved.put("status",saved.optBoolean("cancelRequested")?"cancelled":"error").put("error",saved.optBoolean("cancelRequested")?"导出已取消":"上次导出已中断，请重新开始");
            // The source and completed SAF outputs are retained. Scratch files remain recognizable by job ID.
            File tmp=new File(file.getPath()+".tmp");Files.write(tmp.toPath(),saved.toString().getBytes(StandardCharsets.UTF_8));Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        }return saved;
    }
    private synchronized void step(String kind,String status,double pct,String message) throws Exception {
        JSONArray steps=job.getJSONArray("steps");for(int i=0;i<steps.length();i++)if(steps.getJSONObject(i).getString("kind").equals(kind))steps.getJSONObject(i).put("status",status).put("pct",pct).put("message",message);
        persist();
    }
    private synchronized void note(String text) throws Exception {job.getJSONArray("notes").put(text);persist();}
    private void hardStopIfStuck(AbstractSession current,String status,String message){
        clock.schedule(()->{synchronized(this){if(exporter&&session==current&&running()){try{job.put("status",status).put("error",message);persist();}catch(Exception ignored){}android.os.Process.killProcess(android.os.Process.myPid());}}},3,TimeUnit.SECONDS);
    }
    private void hardStopJob(String token,String status,String message){
        clock.schedule(()->{synchronized(this){if(exporter&&job!=null&&job.optString("id").equals(token)&&running()){try{job.put("status",status).put("error",message);persist();}catch(Exception ignored){}android.os.Process.killProcess(android.os.Process.myPid());}}},3,TimeUnit.SECONDS);
    }
    private FFmpegSession execute(List<String> args,long timeout,boolean progress) throws Exception {
        check();FFmpegSession current=FFmpegSession.create(args.toArray(new String[0]),null,log->{},statistics->{
            if(progress&&job!=null){long now=System.currentTimeMillis();double duration=job.optDouble("duration",0);if(duration>0&&now-job.optLong("progressAt")>700){try{synchronized(this){job.put("progressAt",now);}step("bilingual","running",Math.min(95,statistics.getTime()/duration/10),"正在编码");}catch(Exception ignored){}}}
        },LogRedirectionStrategy.NEVER_PRINT_LOGS);
        session=current;ScheduledFuture<?> timer=clock.schedule(()->{hardStopIfStuck(current,"error","编码器执行超时，请更换编码设置");current.cancel();},timeout,TimeUnit.MILLISECONDS);
        try{FFmpegKitConfig.ffmpegExecute(current);check();if(current.getReturnCode()==null||!ReturnCode.isSuccess(current.getReturnCode())){String detail=current.getAllLogsAsString();if(detail.length()>800)detail=detail.substring(detail.length()-800);detail=detail.replaceAll("/data/[^\\s'\"]+","[本机文件]");throw new IOException("编码器执行失败："+detail);}return current;}
        finally{timer.cancel(false);if(session==current)session=null;}
    }
    private JSONObject inspect(File file) throws Exception {
        com.arthenica.ffmpegkit.FFprobeSession probe=FFprobeSession.create(new String[]{"-v","error","-protocol_whitelist","file,pipe","-show_streams","-show_format","-of","json",file.getPath()},null,log->{},LogRedirectionStrategy.NEVER_PRINT_LOGS);
        if(exporter)session=probe;
        ScheduledFuture<?> timer=clock.schedule(()->{hardStopIfStuck(probe,"error","媒体检测超时");probe.cancel();},30,TimeUnit.SECONDS);
        try{FFmpegKitConfig.ffprobeExecute(probe);if(probe.getReturnCode()==null||!ReturnCode.isSuccess(probe.getReturnCode()))throw new IOException("媒体信息读取失败");return new JSONObject(probe.getOutput());}finally{timer.cancel(false);if(session==probe)session=null;}
    }
    private File media(JSONObject project) throws Exception {
        String id=project.optString("mediaId");if(!id.matches("[0-9a-f-]{36}"))throw new IOException("请先关联视频");File f=new File(context.getFilesDir(),"media/"+id+".media");if(!f.isFile())throw new IOException("关联的视频不存在");return f;
    }
    private static JSONObject videoStream(JSONObject info) throws Exception {
        JSONArray streams=info.getJSONArray("streams");for(int i=0;i<streams.length();i++){JSONObject s=streams.getJSONObject(i);if(s.optString("codec_type").equals("video")&&(s.optJSONObject("disposition")==null||s.optJSONObject("disposition").optInt("attached_pic")==0))return s;}return null;
    }
    private static double duration(JSONObject info){return info.optJSONObject("format")==null?0:info.optJSONObject("format").optDouble("duration",0);}
    private static String mime(String codec){return codec.equals("h265")?"video/hevc":codec.equals("av1")?"video/av01":"video/avc";}
    private List<String> platformCodecs(String codec,boolean wantHardware){
        List<String> names=new ArrayList<>();try{for(MediaCodecInfo info:new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos())if(info.isEncoder())for(String type:info.getSupportedTypes())if(type.equalsIgnoreCase(mime(codec))){boolean hw=android.os.Build.VERSION.SDK_INT>=29?info.isHardwareAccelerated():!info.getName().startsWith("OMX.google.")&&!info.getName().startsWith("c2.android.");if(hw==wantHardware)names.add(info.getName());}}catch(Exception ignored){}return names;
    }
    private List<String> hardware(String codec){return platformCodecs(codec,true);}
    // This SDK's libkvazaar aborts on repeated sessions in WSA; use a platform HEVC encoder instead.
    private static String software(String codec){return codec.equals("h265")?"hevc_mediacodec":codec.equals("av1")?"libaom-av1":"libopenh264";}
    private static String hardwareEncoder(String codec){return codec.equals("h265")?"hevc_mediacodec":codec.equals("av1")?"av1_mediacodec":"h264_mediacodec";}
    synchronized JSONObject capabilities(String id) throws Exception {
        if(encoders==null){
            FFmpegSession probe=FFmpegKit.executeWithArguments(new String[]{"-hide_banner","-encoders"});
            if(probe.getReturnCode()==null||!ReturnCode.isSuccess(probe.getReturnCode()))throw new IOException("安卓编码工具不可用");encoders=probe.getOutput();
        }
        JSONObject p=store.load(id);boolean hasVideo=false;
        if(!p.optString("mediaId").isEmpty()){
            MediaExtractor extractor=new MediaExtractor();try{extractor.setDataSource(media(p).getPath());for(int i=0;i<extractor.getTrackCount();i++)if(extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME).startsWith("video/"))hasVideo=true;}finally{extractor.release();}
        }
        JSONObject codecs=new JSONObject();for(String codec:new String[]{"h264","h265","av1"})codecs.put(codec,new JSONObject().put("software",encoders.contains(software(codec))&&(!codec.equals("h265")||!platformCodecs(codec,false).isEmpty())?software(codec):"").put("platformSoftware",new JSONArray(platformCodecs(codec,false))).put("hardware",encoders.contains(hardwareEncoder(codec))?new JSONArray(hardware(codec)):new JSONArray()));
        String dir=GalleryVideo.available()?GalleryVideo.NAME:context.getSharedPreferences("export",0).getString("name","");
        return new JSONObject().put("hasVideo",hasVideo).put("tools",new JSONObject().put("ok",true)).put("ffmpeg",FFmpegKitConfig.getFFmpegVersion()).put("android",true).put("album",GalleryVideo.available()).put("codecs",codecs).put("directory",dir);
    }
    JSONObject font(String encoded) throws Exception {
        byte[] bytes=android.util.Base64.decode(encoded,android.util.Base64.DEFAULT);if(bytes.length==0||bytes.length>16*1024*1024)throw new IOException("字体文件超过导出上限");
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder id=new StringBuilder();for(byte b:hash)id.append(String.format("%02x",b&255));
        File file=new File(fonts,id+".font");if(!file.isFile()){File tmp=new File(fonts,id+".tmp");Files.write(tmp.toPath(),bytes);Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}return new JSONObject().put("id",id.toString());
    }
    synchronized JSONObject start(String id,JSONObject args) throws Exception {
        if(working||serviceAlive()||(job!=null&&status(job.optString("projectId")).optString("status").equals("running")))throw new IOException("已有视频正在导出");
        JSONObject project=store.load(id);JSONArray kinds=args.getJSONArray("kinds");Set<String> unique=new LinkedHashSet<>();for(int i=0;i<kinds.length();i++){String kind=kinds.getString(i);if(!kind.matches("bilingual|raw|subtitle"))throw new IOException("导出内容无效");unique.add(kind);}if(unique.isEmpty())throw new IOException("请至少选择一种导出内容");
        String tree=context.getSharedPreferences("export",0).getString("tree",""),name=context.getSharedPreferences("export",0).getString("name","");
        boolean gallery=args.optString("destination").equals("gallery");
        if(gallery){if(!GalleryVideo.available())throw new IOException("当前安卓版本请使用系统文件夹导出视频");if(unique.contains("subtitle"))throw new IOException("字幕请使用导出字幕并选择保存位置");}
        else{if(!args.optString("outDir").equals(name))throw new IOException("请重新选择安卓导出文件夹");new SafDirectory(context,tree);}
        String codec=args.optString("codec","h264"),accel=args.optString("accel","auto");if(!codec.matches("h264|h265|av1")||!accel.matches("auto|hardware|cpu"))throw new IOException("编码参数无效");
        if(unique.contains("bilingual")){JSONObject support=capabilities(id).getJSONObject("codecs").getJSONObject(codec);if(support.optString("software").isEmpty()&&(accel.equals("cpu")||support.getJSONArray("hardware").length()==0))throw new IOException("当前设备不支持此视频编码格式");}
        String subtitle=args.has("subtitleText")?args.getString("subtitleText"):project.optString("text");if(subtitle.length()>16*1024*1024)throw new IOException("字幕超过导出上限");
        if(args.optString("renderSubtitleText").length()>16*1024*1024)throw new IOException("字幕超过导出上限");
        if((unique.contains("bilingual")||unique.contains("subtitle"))&&subtitle.trim().isEmpty())throw new IOException("稿件没有字幕");
        if(unique.contains("bilingual")||unique.contains("raw"))media(project);
        String token=UUID.randomUUID().toString();File folder=new File(root,token);if(!folder.mkdir())throw new IOException("无法准备导出缓存");
        JSONArray steps=new JSONArray();for(String kind:unique)steps.put(new JSONObject().put("kind",kind).put("status","pending").put("pct",0));
        job=new JSONObject().put("projectId",id).put("id",token).put("status","running").put("steps",steps).put("notes",new JSONArray()).put("outputs",new JSONArray()).put("startedAt",System.currentTimeMillis());
        JSONObject request=new JSONObject().put("project",project).put("options",args).put("kinds",new JSONArray(unique)).put("tree",tree).put("text",subtitle);
        Files.write(new File(folder,"request.json").toPath(),request.toString().getBytes(StandardCharsets.UTF_8));persist();
        try{context.startForegroundService(new Intent(context,ExportService.class).putExtra("jobId",token).putExtra("projectId",id));}catch(Exception e){job.put("status","error").put("error","无法启动前台导出任务");persist();throw e;}
        return new JSONObject(job.toString());
    }
    synchronized void receive(String projectId,String token) throws Exception {
        if(!exporter||!token.matches("[a-f0-9-]{36}")||working)throw new IOException("导出任务启动失败");
        File folder=new File(root,token);JSONObject request=new JSONObject(new String(Files.readAllBytes(new File(folder,"request.json").toPath()),StandardCharsets.UTF_8));
        job=new JSONObject(new String(Files.readAllBytes(store.file(projectId,".export.json").toPath()),StandardCharsets.UTF_8));
        if(!job.getString("id").equals(token)||!job.getString("status").equals("running")||!request.getJSONObject("project").getString("id").equals(projectId))throw new IOException("导出任务版本不符");
        job.put("pid",android.os.Process.myPid());persist();working=true;cancelled.set(false);deadline=System.currentTimeMillis()+6*60*60*1000;
        jobTimeout=clock.schedule(()->hardStopJob(token,"error","导出任务超时，请重新开始"),6,TimeUnit.HOURS);
        Set<String> kinds=new LinkedHashSet<>();JSONArray list=request.getJSONArray("kinds");for(int i=0;i<list.length();i++)kinds.add(list.getString(i));
        SafDirectory directory=request.getJSONObject("options").optString("destination").equals("gallery")?null:new SafDirectory(context,request.getString("tree"));worker.execute(()->run(request.optJSONObject("project"),request.optJSONObject("options"),kinds,directory,folder,request.optString("text")));
    }
    private List<String> encodeArgs(File input,File output,File subtitle,File jobFonts,String encoder,String codecName,JSONObject stream,JSONObject args,boolean trial){
        int quality=Math.max(0,Math.min(51,args.optInt("quality",23))),threads=Math.max(1,Math.min(8,args.optInt("threads",0)>0?args.optInt("threads"):Math.min(4,Runtime.getRuntime().availableProcessors())));
        long pixels=(long)stream.optInt("width",1280)*stream.optInt("height",720),bitrate=Math.max(300000,Math.min(80000000,Math.round(pixels*30*.09*Math.pow(2,(23-quality)/12.0))));
        List<String> list=new ArrayList<>(Arrays.asList("-hide_banner","-nostats","-v","warning","-y","-protocol_whitelist","file,pipe","-i",input.getPath(),"-map","0:v:0","-map","0:a:0?","-vf","subtitles=filename='"+subtitle.getPath()+"':fontsdir='"+jobFonts.getPath()+"',scale=trunc(iw/2)*2:trunc(ih/2)*2","-c:v",encoder,"-threads",String.valueOf(threads),"-pix_fmt","yuv420p","-b:v",String.valueOf(bitrate)));
        if(!codecName.isEmpty()){list.add("-codec_name");list.add(codecName);}
        if(encoder.equals("libaom-av1"))Collections.addAll(list,"-cpu-used","8","-row-mt","1");
        Collections.addAll(list,"-c:a","aac","-b:a","128k","-movflags","+faststart");if(trial)Collections.addAll(list,"-t","0.5");list.add(output.getPath());return list;
    }
    private void run(JSONObject project,JSONObject args,Set<String> kinds,SafDirectory directory,File folder,String text){
        String current="";
        try{
            String base=project.optString("name","SubFabric").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_").replaceAll("(?i)\\.(ass|ssa|srt|mp4|mkv|webm)$","");if(base.length()>100)base=base.substring(0,100);if(base.trim().isEmpty())base="SubFabric";
            File input=kinds.contains("bilingual")||kinds.contains("raw")?media(project):null;
            String subExt=text.matches("(?is).*\\[events\\].*")?".ass":".srt";File subtitle=new File(folder,"subtitle"+subExt);Files.write(subtitle.toPath(),text.getBytes(StandardCharsets.UTF_8));
            File renderSubtitle=new File(folder,"render"+subExt);Files.write(renderSubtitle.toPath(),args.optString("renderSubtitleText",text).getBytes(StandardCharsets.UTF_8));
            File jobFonts=new File(folder,"fonts");jobFonts.mkdir();try(InputStream in=context.getAssets().open("editor/vendor/fonts/NotoSansCJKsc-Regular.otf")){Files.copy(in,new File(jobFonts,"NotoSansCJKsc-Regular.otf").toPath());}
            JSONArray ids=args.optJSONArray("fontIds");if(ids!=null){if(ids.length()>64)throw new IOException("导出字体过多");for(int i=0;i<ids.length();i++){String fontId=ids.getString(i);if(!fontId.matches("[a-f0-9]{64}"))throw new IOException("字体标识无效");Files.copy(new File(fonts,fontId+".font").toPath(),new File(jobFonts,fontId+".ttf").toPath(),StandardCopyOption.REPLACE_EXISTING);}}
            Map<String,String> aliases=new HashMap<>();JSONArray fallback=args.optJSONArray("fallbackFonts");if(fallback!=null){if(fallback.length()>64)throw new IOException("导出字体过多");for(int i=0;i<fallback.length();i++){String name=fallback.getString(i);if(name.length()>200||name.matches("(?s).*[<>\"&].*"))throw new IOException("字体名称无效");aliases.put(name,"Noto Sans CJK SC");}}
            FFmpegKitConfig.setFontDirectory(context,jobFonts.getPath(),aliases);
            for(String kind:kinds){
                check();current=kind;step(kind,"running",0,"准备导出");File source;String outputName,mime;
                if(kind.equals("bilingual")){
                    JSONObject info=inspect(input),stream=videoStream(info);if(stream==null||duration(info)<=0)throw new IOException("所选媒体没有可压制的视频轨");synchronized(this){job.put("duration",duration(info));}
                    String codec=args.optString("codec","h264"),accel=args.optString("accel","auto"),encoder="",codecName="";File trial=new File(folder,"trial.mp4");
                    if(!accel.equals("cpu"))for(String candidate:hardware(codec)){
                        try{step(kind,"running",0,"正在试跑硬件编码器");execute(encodeArgs(input,trial,renderSubtitle,jobFonts,hardwareEncoder(codec),candidate,stream,args,true),20000,false);encoder=hardwareEncoder(codec);codecName=candidate;break;}
                        catch(Exception e){check();note("硬件编码试跑失败，继续尝试其它编码器");}finally{trial.delete();}
                    }
                    if(encoder.isEmpty()){encoder=software(codec);if(codec.equals("h265")){List<String> cpu=platformCodecs(codec,false);if(cpu.isEmpty())throw new IOException("当前设备没有可用的软件 HEVC 编码器");codecName=cpu.get(0);}step(kind,"running",0,"正在试跑软件编码器");execute(encodeArgs(input,trial,renderSubtitle,jobFonts,encoder,codecName,stream,args,true),30000,false);trial.delete();if(!accel.equals("cpu"))note("当前视频未使用硬件编码，已回退到软件编码");}
                    source=new File(folder,"encoded.mp4");step(kind,"running",0,codecName.isEmpty()?"正在软件编码":"正在硬件编码");
                    execute(encodeArgs(input,source,renderSubtitle,jobFonts,encoder,codecName,stream,args,false),6*60*60*1000,true);
                    JSONObject encoded=inspect(source);if(videoStream(encoded)==null||source.length()<1000||Math.abs(duration(encoded)-duration(info))>Math.max(.6,duration(info)*.02))throw new IOException("成片时长或视频轨验证失败，未发布文件");
                    synchronized(this){job.put("encoder",encoder).put("codecName",codecName);}outputName=base+"_双语.mp4";mime="video/mp4";
                }else if(kind.equals("raw")){
                    source=input;String original=project.optString("mediaName","source.mp4"),ext=original.contains(".")?original.substring(original.lastIndexOf('.')).toLowerCase(Locale.ROOT):".bin";if(!ext.matches("\\.[a-z0-9]{1,8}"))ext=".bin";outputName=base+"_生肉"+ext;mime="application/octet-stream";
                }else{source=subtitle;outputName=base+"_字幕"+subExt;mime="application/octet-stream";}
                step(kind,"running",96,directory==null?"正在导入相册":"正在写入所选文件夹");JSONObject output=directory==null?GalleryVideo.publish(context,source,outputName,this::check):directory.publish(source,outputName,mime,args.optBoolean("overwrite"),this::check);output.put("kind",kind);
                synchronized(this){job.getJSONArray("outputs").put(output);if(output.has("warning"))job.getJSONArray("notes").put(output.getString("warning"));}
                step(kind,"done",100,"已导出并验证写入");
            }
            synchronized(this){job.put("status","done");persist();}
        }catch(Throwable e){try{synchronized(this){job.put("status",cancelled.get()?"cancelled":"error").put("error",e.getMessage()==null?"导出失败":e.getMessage());if(!current.isEmpty())step(current,cancelled.get()?"cancelled":"error",0,job.getString("error"));persist();}}catch(Exception ignored){}}
        finally{
            if(jobTimeout!=null)jobTimeout.cancel(false);
            // Only this job's staging files. Never touch user media, projects or completed SAF outputs.
            File jobFonts=new File(folder,"fonts");File[] local=jobFonts.listFiles();if(local!=null)for(File f:local)f.delete();jobFonts.delete();
            for(String name:new String[]{"request.json","subtitle.ass","subtitle.srt","render.ass","render.srt","trial.mp4","encoded.mp4"})new File(folder,name).delete();folder.delete();
            context.stopService(new Intent(context,ExportService.class));
            synchronized(this){working=false;}
        }
    }
}
