package com.subfabric.android;

import android.app.ActivityManager;
import android.content.*;
import android.media.*;
import android.os.Process;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import com.arthenica.ffmpegkit.*;

/** Immutable media request and separate result files; recognition never edits a Studio document. */
final class AsrManager {
    private static AsrManager instance;
    static synchronized AsrManager get(Context context){if(instance==null)instance=new AsrManager(context.getApplicationContext());return instance;}
    private final Context context;
    private final File root;
    private final boolean child;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService clock=Executors.newScheduledThreadPool(2);
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private JSONObject current;
    private volatile boolean working;
    private volatile Thread workerThread;
    private ScheduledFuture<?> watchdog;
    private long lastProgress;
    private volatile boolean timedOut;
    private volatile long decodeSession=-1;
    private AsrManager(Context context){
        this.context=context;root=new File(context.getFilesDir(),"asr-jobs");root.mkdirs();
        boolean found=false;List<ActivityManager.RunningAppProcessInfo> processes=context.getSystemService(ActivityManager.class).getRunningAppProcesses();
        if(processes!=null)for(ActivityManager.RunningAppProcessInfo process:processes)if(process.pid==Process.myPid())found=process.processName.equals(context.getPackageName()+":asr");child=found;
    }
    static JSONObject modelStatus(Context context) throws Exception { return VulkanModels.status(context); }
    private File folder(String id) throws IOException {if(id==null||!id.matches("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"))throw new IOException("识别任务 ID 无效");return new File(root,id);}
    private JSONObject read(String id,String name) throws Exception {return new JSONObject(new String(Files.readAllBytes(new File(folder(id),name).toPath()),StandardCharsets.UTF_8));}
    private void write(String id,String name,JSONObject value) throws Exception {
        File target=new File(folder(id),name),temp=new File(target.getPath()+".tmp");
        try(FileOutputStream out=new FileOutputStream(temp)){out.write(value.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(temp.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
    }
    @SuppressWarnings("deprecation") private boolean alive(JSONObject job){
        List<ActivityManager.RunningServiceInfo> services=context.getSystemService(ActivityManager.class).getRunningServices(64);
        if(services!=null)for(ActivityManager.RunningServiceInfo service:services)if(service.service.getClassName().equals(AsrService.class.getName())&&service.pid>0&&(job==null||!job.has("pid")||job.optInt("pid")==service.pid))return true;return false;
    }
    private synchronized void persist() throws Exception {current.put("updatedAt",System.currentTimeMillis());write(current.getString("id"),"job.json",current);AsrService.progress(context,current);}
    synchronized JSONObject start(JSONObject input) throws Exception {
        if(child)throw new IOException("识别任务必须从编辑器启动");
        if(alive(null)||active()!=null)throw new IOException("已有本地识别任务进行中");
        String kind=input.optString("kind","recognize");if(!kind.matches("recognize|model|align"))throw new IOException("识别任务类型无效");
        if(kind.equals("model"))return startModel(input);
        String modelId=input.optString("modelId",VulkanModels.ALL[0].id);VulkanModels.Spec spec=VulkanModels.find(kind.equals("align")?VulkanModels.ALL[2].id:modelId);
        if(!kind.equals("align")&&spec.kind==3)throw new IOException("对齐模型不能用于语音识别");
        JSONObject hardware=VulkanModels.gpuStatus(context);if(!hardware.optBoolean("available"))throw new IOException("Vulkan GPU 不可用；CPU 识别已禁用："+hardware.optString("error"));
        if(!spec.path(context).isFile())throw new IOException("请先下载或导入 "+spec.name);
        if(input.optBoolean("align")&&!VulkanModels.ALL[2].path(context).isFile())throw new IOException("请先下载 Qwen 对齐器");
        String mediaId=input.getString("mediaId");File source=media(mediaId);
        double start=input.optDouble("start",0),end=input.has("end")&&!input.isNull("end")?input.optDouble("end",Double.NaN):-1;
        if(!Double.isFinite(start)||start<0||start>86400||end!=-1&&(!Double.isFinite(end)||end<=start||end-start>14400))throw new IOException("识别时间范围无效，单次最长四小时");
        int threads=input.optInt("threads",Math.min(4,Math.max(1,Runtime.getRuntime().availableProcessors())));if(threads<1||threads>8)throw new IOException("识别线程数需为 1–8");
        String id=UUID.randomUUID().toString();if(!folder(id).mkdir())throw new IOException("无法准备识别目录");
        JSONObject request=new JSONObject(input.toString()).put("kind",kind).put("modelId",spec.id).put("segmentSeconds",600).put("mediaId",mediaId).put("start",start).put("end",end).put("threads",threads).put("mediaBytes",source.length()).put("mediaModified",source.lastModified());
        JSONObject job=new JSONObject().put("id",id).put("kind",kind).put("modelId",spec.id).put("segmentSeconds",600).put("backend","vulkan").put("cpuFallback",false).put("mediaId",mediaId).put("status","running").put("stage","正在准备 Vulkan 识别").put("pct",0).put("startedAt",System.currentTimeMillis());
        write(id,"request.json",request);write(id,"job.json",job);context.getSharedPreferences("asr",0).edit().putString("active",id).commit();
        try{context.startForegroundService(new Intent(context,AsrService.class).putExtra("jobId",id));}catch(Exception error){job.put("status","error").put("error","无法启动本地识别前台任务");write(id,"job.json",job);throw error;}
        return job;
    }
    private JSONObject startModel(JSONObject input) throws Exception {
        VulkanModels.Spec spec=VulkanModels.find(input.optString("modelId",VulkanModels.ALL[0].id));
        String id=UUID.randomUUID().toString();if(!folder(id).mkdir())throw new IOException("无法准备模型下载目录");
        JSONObject request=new JSONObject().put("kind","model").put("modelId",spec.id),job=new JSONObject().put("id",id).put("kind","model").put("status","running").put("stage","正在检查 Vulkan 模型").put("pct",0).put("bytes",0).put("total",spec.bytes).put("modelId",spec.id).put("startedAt",System.currentTimeMillis());
        write(id,"request.json",request);write(id,"job.json",job);context.getSharedPreferences("asr",0).edit().putString("active",id).commit();
        try{context.startForegroundService(new Intent(context,AsrService.class).putExtra("jobId",id));}catch(Exception error){job.put("status","error").put("error","无法启动模型下载前台任务");write(id,"job.json",job);throw error;}return job;
    }
    private File media(String id) throws Exception {
        if(id==null||!id.matches("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"))throw new IOException("媒体 ID 无效");
        File source=new File(context.getFilesDir(),"media/"+id+".media");if(!source.isFile()||source.length()==0||source.length()>2L*1024*1024*1024||Files.isSymbolicLink(source.toPath()))throw new IOException("媒体文件不存在或无效");return source;
    }
    synchronized JSONObject status(String id) throws Exception {
        JSONObject job=child&&current!=null&&current.optString("id").equals(id)?new JSONObject(current.toString()):read(id,"job.json");
        if(!child&&job.optString("status").equals("running")&&!alive(job)&&(job.has("pid")||System.currentTimeMillis()-job.optLong("startedAt")>10000)){
            boolean stopped=new File(folder(id),"cancel.flag").isFile();job.put("status",stopped?"cancelled":"interrupted").put("error",stopped?"识别已停止，原稿保留":"识别已中断，原稿保留，请重新开始");write(id,"job.json",job);
        }
        if(job.optString("status").equals("done"))job.put("result",read(id,"result.json"));return job;
    }
    synchronized JSONObject active() throws Exception {
        String id=context.getSharedPreferences("asr",0).getString("active","");if(id.isEmpty())return null;JSONObject job=status(id);return job.optString("status").equals("running")?job:null;
    }
    synchronized boolean running(){return working;}
    void cancel(String id) throws Exception {
        JSONObject job=status(id);if(!job.optString("status").equals("running"))return;
        if(!child){Files.write(new File(folder(id),"cancel.flag").toPath(),new byte[]{1});if(alive(null))context.startService(new Intent(context,AsrService.class).setAction("cancel").putExtra("jobId",id));return;}
        synchronized(this){if(current==null||!current.optString("id").equals(id)||!working)return;cancelled.set(true);current.put("stage","正在停止识别");persist();}
        if(decodeSession>=0)FFmpegKit.cancel(decodeSession);Thread thread=workerThread;if(thread!=null)thread.interrupt();forceStop(id,"cancelled","识别已停止，原稿保留",3);
    }
    private void forceStop(String id,String state,String message,int seconds){clock.schedule(()->{synchronized(this){if(child&&working&&current!=null&&current.optString("id").equals(id)){try{current.put("status",state).put("error",message);persist();}catch(Exception ignored){}Process.killProcess(Process.myPid());}}},seconds,TimeUnit.SECONDS);}
    synchronized void receive(String id) throws Exception {
        if(!child||working)throw new IOException("本地识别任务启动失败");JSONObject job=read(id,"job.json");if(!job.optString("status").equals("running"))return;
        JSONObject request=read(id,"request.json");current=job;current.put("pid",Process.myPid());working=true;cancelled.set(false);timedOut=false;persist();
        watchdog=clock.schedule(()->{timedOut=true;cancelled.set(true);forceStop(id,"error","Vulkan 任务超时，原稿保留",3);Thread thread=workerThread;if(thread!=null)thread.interrupt();},request.optString("kind").equals("model")?1:6,TimeUnit.HOURS);
        worker.execute(()->run(id,request));
    }
    void stopped(String id){try{if(child&&working)cancel(id);}catch(Exception ignored){}}
    private void check() throws Exception {
        if(cancelled.get()||Thread.currentThread().isInterrupted()||new File(folder(current.getString("id")),"cancel.flag").isFile())throw new IOException("识别已停止，原稿保留");
    }
    private void progress(String stage,double percent) throws Exception {
        check();long now=System.currentTimeMillis();if(now-lastProgress<300&&percent>1&&percent<100)return;lastProgress=now;
        synchronized(this){current.put("stage",stage).put("pct",Math.max(0,Math.min(99,percent)));persist();}
    }
    private void run(String id,JSONObject request){
        workerThread=Thread.currentThread();
        try{
            if(request.optString("kind").equals("model")){downloadModels(id,request);return;}
            check();File source=media(request.getString("mediaId"));if(source.length()!=request.getLong("mediaBytes")||source.lastModified()!=request.getLong("mediaModified"))throw new IOException("识别源媒体已经变化，请重新选择");
            VulkanModels.Spec spec=VulkanModels.find(request.getString("modelId"));
            progress("正在校验 "+spec.name,0);VulkanModels.verify(spec.path(context),spec);
            JSONObject result;
            if(request.optString("kind").equals("align"))result=alignBlocks(source,request);
            else {
                JSONArray cues=recognize(source,spec,request);check();
                if(cues.length()==0)throw new IOException("没有识别到语音，原稿保留");
                if(request.optBoolean("align"))cues=alignCues(source,cues);
                result=new JSONObject().put("cues",cues).put("engine",spec.id).put("backend","vulkan").put("cpuFallback",false).put("segmentSeconds",600).put("mediaId",request.getString("mediaId")).put("start",request.getDouble("start")).put("end",request.getDouble("end"));
            }
            if(result.toString().length()>12*1024*1024)throw new IOException("识别结果过大，请分段识别");write(id,"result.json",result);check();
            synchronized(this){current.put("status","done").put("pct",100).put("stage","本地识别完成，等待写入稿件");persist();}
        }catch(Throwable error){
            if(error.getMessage()!=null&&error.getMessage().contains("self-check"))try{VulkanModels.gpuFailure(context,error.getMessage());}catch(Exception ignored){}
            try{synchronized(this){boolean stopped=!timedOut&&(cancelled.get()||Thread.currentThread().isInterrupted()||new File(folder(id),"cancel.flag").isFile());String message=timedOut?"Vulkan 任务超时，原稿保留":stopped?"Vulkan 任务已停止，原稿保留":error instanceof IOException?error.getMessage():"Vulkan 识别失败，原稿保留";current.put("status",stopped?"cancelled":"error").put("error",message).put("stage",message);persist();}}catch(Exception ignored){}
        }finally{Thread.interrupted();workerThread=null;if(watchdog!=null)watchdog.cancel(false);synchronized(this){working=false;}context.stopService(new Intent(context,AsrService.class));}
    }
    private void downloadModels(String id,JSONObject request) throws Exception {
        VulkanModels.Spec spec=VulkanModels.find(request.getString("modelId"));File directory=spec.path(context).getParentFile();directory.mkdirs();long total=spec.bytes,completed=0;
        for(String name:new String[]{spec.file}){
            check();File target=new File(directory,name);boolean valid=false;
            if(target.isFile())try{progress("正在校验模型 · "+name,100.0*completed/total);VulkanModels.verify(target,spec);valid=true;}catch(IOException error){check();}
            if(valid){completed+=spec.bytes;continue;}
            File part=new File(folder(id),name+".part");long expected=spec.bytes;
            if(folder(id).getUsableSpace()<expected+32L*1024*1024)throw new IOException("空间不足，无法下载 Vulkan 模型");
            HttpsURLConnection connection=null;
            try{
                URL url=new URL(spec.url);
                for(int hop=0;hop<=5;hop++){
                    check();if(!url.getProtocol().equals("https")||url.getUserInfo()!=null)throw new IOException("模型下载重定向无效");
                    connection=(HttpsURLConnection)url.openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Accept-Encoding","identity");
                    int status=connection.getResponseCode();if(status>=300&&status<400){String location=connection.getHeaderField("Location");connection.disconnect();connection=null;if(location==null||hop==5)throw new IOException("模型下载重定向过多");url=new URL(url,location);continue;}
                    if(status!=200)throw new IOException("模型下载失败（HTTP "+status+"）");break;
                }
                if(connection==null)throw new IOException("模型下载连接失败");long declared=connection.getContentLengthLong();if(declared>=0&&declared!=expected)throw new IOException("模型下载大小不匹配");
                long downloaded=0,last=0;byte[] buffer=new byte[262144];
                try(InputStream in=connection.getInputStream();FileOutputStream out=new FileOutputStream(part)){
                    for(int count;(count=in.read(buffer))!=-1;){check();downloaded+=count;if(downloaded>expected)throw new IOException("模型下载超过预期大小");out.write(buffer,0,count);long now=System.currentTimeMillis();if(now-last>=350){last=now;synchronized(this){current.put("bytes",completed+downloaded).put("total",total);}progress("正在下载 Vulkan 模型 · "+name,100.0*(completed+downloaded)/total);}}
                    out.getFD().sync();
                }
                check();progress("正在校验模型 · "+name,100.0*(completed+downloaded)/total);VulkanModels.verify(part,spec);check();
                Files.move(part.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);completed+=expected;
            }catch(IOException error){check();String message=error.getMessage();if(message!=null&&(message.startsWith("模型")||message.startsWith("空间不足")))throw error;throw new IOException("模型下载失败，请检查网络后重试");}
            finally{if(connection!=null)connection.disconnect();if(part.isFile())part.delete();}
        }
        check();write(id,"result.json",new JSONObject().put("filesOk",true).put("modelReady",VulkanModels.gpuStatus(context).optBoolean("available")).put("modelId",spec.id));
        synchronized(this){current.put("status","done").put("stage","Vulkan 模型文件已校验").put("pct",100).put("bytes",total).put("total",total);persist();}
    }
    private double end(JSONObject request,double duration) throws Exception {
        double value=request.getDouble("end"),start=request.getDouble("start");if(value<0)value=duration;else if(duration>0)value=Math.min(value,duration);
        if(!Double.isFinite(value)||value<=start||value-start>14400)throw new IOException("音轨时长无效，单次识别最长四小时");return value;
    }
    private double duration(File source)throws Exception{
        FFprobeSession probe=FFprobeSession.create(new String[]{"-v","error","-show_entries","format=duration","-of","json",source.getPath()});decodeSession=probe.getSessionId();
        ScheduledFuture<?> timer=clock.schedule(()->FFmpegKit.cancel(probe.getSessionId()),120,TimeUnit.SECONDS);
        try{FFmpegKitConfig.ffprobeExecute(probe);check();if(!ReturnCode.isSuccess(probe.getReturnCode()))throw new IOException("无法读取音轨时长或读取超时");
            double value=new JSONObject(probe.getOutput()).getJSONObject("format").optDouble("duration",Double.NaN);if(!Double.isFinite(value)||value<=0)throw new IOException("音轨时长无效");return value;
        }finally{timer.cancel(false);decodeSession=-1;}
    }
    private File decodePcm(File source,double start,double seconds)throws Exception{
        check();if(seconds<=0||seconds>600.001)throw new IOException("解码分段必须在 10 分钟内");
        File pcm=new File(folder(current.getString("id")),"audio.f32");
        FFmpegSession session=FFmpegSession.create(new String[]{"-hide_banner","-loglevel","error","-nostdin","-y","-ss",Double.toString(start),"-i",source.getPath(),"-t",Double.toString(seconds),"-vn","-ac","1","-ar","16000","-f","f32le",pcm.getPath()});decodeSession=session.getSessionId();
        ScheduledFuture<?> timer=clock.schedule(()->FFmpegKit.cancel(session.getSessionId()),120,TimeUnit.SECONDS);
        try{FFmpegKitConfig.ffmpegExecute(session);check();if(!ReturnCode.isSuccess(session.getReturnCode())||!pcm.isFile()||pcm.length()<4||pcm.length()>600L*16000*4+64000)throw new IOException("音频解码失败或超时");return pcm;}
        finally{timer.cancel(false);decodeSession=-1;}
    }
    private float[] readPcm(RandomAccessFile file,int count)throws Exception{
        check();byte[] data=new byte[count*4];file.readFully(data);float[] samples=new float[count];ByteBuffer b=ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);b.asFloatBuffer().get(samples);return samples;
    }
    private JSONArray recognize(File source,VulkanModels.Spec spec,JSONObject request)throws Exception{
        double from=request.getDouble("start"),finish=end(request,duration(source));JSONArray cues=new JSONArray();int total=(int)Math.ceil((finish-from)/600.0),part=0;
        progress("正在加载 "+spec.name+" · Vulkan",1);
        try(VulkanAsr model=new VulkanAsr(spec.path(context).getPath(),spec.kind,request.getInt("threads"))){
            for(double offset=from;offset<finish-.0001;offset+=600){check();part++;double span=Math.min(600,finish-offset);progress("第 "+part+" / "+total+" 段 · 每段最多 10 分钟",2+90*(offset-from)/(finish-from));
                File pcm=decodePcm(source,offset,span);
                try(RandomAccessFile audio=new RandomAccessFile(pcm,"r")){
                    long samples=audio.length()/4;for(long at=0;at<samples;){int count=(int)Math.min(16000*30,samples-at);float[] values=readPcm(audio,count);double energy=0;for(float value:values)energy+=value*value;double start=offset+at/16000.0,stop=Math.min(finish,start+count/16000.0);at+=count;
                        if(energy/count<1e-9)continue;check();JSONObject result=model.recognize(values,start);check();String text=result.optString("text").trim();if(text.isEmpty())continue;
                        if(spec.kind==1)appendParakeet(cues,result,start,stop);else cues.put(new JSONObject().put("text",text).put("start",start).put("end",stop).put("words",new JSONArray()));
                        if(cues.length()>100000)throw new IOException("字幕数量过多，请缩小范围");progress("第 "+part+" / "+total+" 段 · 已生成 "+cues.length()+" 条字幕",2+90*(stop-from)/(finish-from));
                    }
                }finally{pcm.delete();}
            }
        }return cues;
    }
    private void appendParakeet(JSONArray cues,JSONObject result,double start,double stop)throws Exception{
        JSONArray source=result.getJSONArray("words"),words=new JSONArray();StringBuilder text=new StringBuilder();double last=start;
        for(int i=0;i<source.length();i++){JSONObject word=source.getJSONObject(i);double from=word.getDouble("start"),end=word.getDouble("end");String value=word.getString("text").trim();
            if(value.isEmpty()||!Double.isFinite(from)||!Double.isFinite(end)||from<last-.02||from<start-.02||from>=stop||end>stop+.08||end<=from)throw new IOException("Parakeet 返回的逐词时间无效，原稿保留");end=Math.min(stop,end);word.put("end",end);last=end;words.put(word);if(text.length()>0)text.append(' ');text.append(value);
            if(value.matches(".*[.!?]$")||words.length()>=18||text.length()>100||i==source.length()-1){cues.put(new JSONObject().put("start",words.getJSONObject(0).getDouble("start")).put("end",last).put("text",text.toString()).put("words",words));words=new JSONArray();text.setLength(0);}
        }
        if(source.length()==0&&!result.optString("text").isEmpty())throw new IOException("Parakeet 没有返回逐词时间，原稿保留");
    }
    private String[] splitWords(String text){
        List<String> words=new ArrayList<>();StringBuilder latin=new StringBuilder();
        for(int offset=0;offset<text.length();){int cp=text.codePointAt(offset);offset+=Character.charCount(cp);Character.UnicodeScript script=Character.UnicodeScript.of(cp);boolean cjk=script==Character.UnicodeScript.HAN||script==Character.UnicodeScript.HIRAGANA||script==Character.UnicodeScript.KATAKANA;
            if(Character.isWhitespace(cp)||cjk){if(latin.length()>0){words.add(latin.toString());latin.setLength(0);}if(cjk)words.add(new String(Character.toChars(cp)));}else latin.appendCodePoint(cp);
        }if(latin.length()>0)words.add(latin.toString());return words.toArray(new String[0]);
    }
    private JSONArray alignCues(File source,JSONArray cues)throws Exception{
        VulkanModels.Spec spec=VulkanModels.ALL[2];progress("正在校验 Qwen 对齐器",93);VulkanModels.verify(spec.path(context),spec);
        try(VulkanAsr model=new VulkanAsr(spec.path(context).getPath(),3)){
            for(int i=0;i<cues.length();i++){JSONObject cue=cues.getJSONObject(i);double start=cue.getDouble("start"),end=cue.getDouble("end");if(end-start>120)throw new IOException("单条对齐范围不可超过 120 秒，请先分句");
                File pcm=decodePcm(source,start,end-start);float[] values;try(RandomAccessFile input=new RandomAccessFile(pcm,"r")){values=readPcm(input,(int)(input.length()/4));}finally{pcm.delete();}
                String[] words=splitWords(cue.getString("text"));JSONArray tokens=cue.optJSONArray("tokens");if(tokens!=null){if(tokens.length()==0||tokens.length()>2048)throw new IOException("对齐词序无效");words=new String[tokens.length()];StringBuilder joined=new StringBuilder();for(int j=0;j<words.length;j++){words[j]=tokens.getString(j);joined.append(words[j]);}if(!joined.toString().replaceAll("\\s+", "").equals(cue.getString("text").replaceAll("\\s+", "")))throw new IOException("对齐词序与原文不一致");}if(words.length==0)throw new IOException("对齐文本为空");check();long[] times=model.align(values,words);check();if(times==null||times.length!=words.length*2)throw new IOException("对齐结果不完整，原字幕保留");JSONArray output=new JSONArray();
                for(int j=0;j<words.length;j++)output.put(new JSONObject().put("text",words[j]).put("start",start+times[2*j]/1000.0).put("end",start+times[2*j+1]/1000.0));
                cue.put("words",output);progress("Qwen 对齐 · "+(i+1)+" / "+cues.length(),93+6.0*(i+1)/cues.length());
            }
        }return cues;
    }
    private JSONObject alignBlocks(File source,JSONObject request)throws Exception{
        JSONArray blocks=request.optJSONArray("blocks");if(blocks==null||blocks.length()==0||blocks.length()>10000)throw new IOException("对齐字幕范围无效");
        JSONArray cues=new JSONArray();double duration=duration(source);for(int i=0;i<blocks.length();i++){JSONObject item=new JSONObject(blocks.getJSONObject(i).toString());double start=item.optDouble("start",Double.NaN),end=item.optDouble("end",Double.NaN);String text=item.optString("text");if(!Double.isFinite(start)||!Double.isFinite(end)||start<0||end<=start||end>duration+.08||end-start>120||text.trim().isEmpty()||text.length()>12000)throw new IOException("对齐字幕时间或文字无效");cues.put(item);}
        return new JSONObject().put("cues",alignCues(source,cues)).put("backend","vulkan").put("cpuFallback",false).put("segmentSeconds",600).put("mediaId",request.getString("mediaId"));
    }
}
