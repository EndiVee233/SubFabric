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
import com.k2fsa.sherpa.onnx.*;

/** Immutable media request and separate result files; recognition never edits a Studio document. */
final class AsrManager {
    private static AsrManager instance;
    static synchronized AsrManager get(Context context){if(instance==null)instance=new AsrManager(context.getApplicationContext());return instance;}
    private final Context context;
    private final File root,models;
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
    private AsrManager(Context context){
        this.context=context;root=new File(context.getFilesDir(),"asr-jobs");root.mkdirs();models=new File(context.getFilesDir(),"parakeet");
        boolean found=false;List<ActivityManager.RunningAppProcessInfo> processes=context.getSystemService(ActivityManager.class).getRunningAppProcesses();
        if(processes!=null)for(ActivityManager.RunningAppProcessInfo process:processes)if(process.pid==Process.myPid())found=process.processName.equals(context.getPackageName()+":asr");child=found;
    }
    static JSONObject modelStatus(Context context) throws Exception {
        File directory=new File(context.getFilesDir(),"parakeet");JSONArray files=new JSONArray();long bytes=0,total=0;boolean ready=true;
        for(String name:ModelFiles.NAMES){File file=new File(directory,name);long size=ModelFiles.size(name),actual=file.isFile()?file.length():0;boolean ok=actual==size;ready&=ok;bytes+=actual;total+=size;files.put(new JSONObject().put("name",name).put("bytes",actual).put("size",size).put("ready",ok));}
        return new JSONObject().put("ready",ready).put("bytes",bytes).put("totalBytes",total).put("files",files);
    }
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
        String kind=input.optString("kind","recognize");if(!kind.matches("recognize|model"))throw new IOException("识别任务类型无效");
        if(kind.equals("model"))return startModel();
        if(!modelStatus(context).getBoolean("ready"))throw new IOException("请先导入 Parakeet v2 int8 模型");
        String mediaId=input.getString("mediaId");File source=media(mediaId);
        double start=input.optDouble("start",0),end=input.has("end")&&!input.isNull("end")?input.optDouble("end",Double.NaN):-1;
        if(!Double.isFinite(start)||start<0||start>86400||end!=-1&&(!Double.isFinite(end)||end<=start||end-start>14400))throw new IOException("识别时间范围无效，单次最长四小时");
        int threads=input.optInt("threads",Math.min(4,Math.max(1,Runtime.getRuntime().availableProcessors())));if(threads<1||threads>8)throw new IOException("识别线程数需为 1–8");
        String id=UUID.randomUUID().toString();if(!folder(id).mkdir())throw new IOException("无法准备识别目录");
        JSONObject request=new JSONObject().put("kind","recognize").put("mediaId",mediaId).put("start",start).put("end",end).put("threads",threads).put("mediaBytes",source.length()).put("mediaModified",source.lastModified());
        JSONObject job=new JSONObject().put("id",id).put("kind","recognize").put("mediaId",mediaId).put("status","running").put("stage","正在准备 Parakeet").put("pct",0).put("startedAt",System.currentTimeMillis());
        write(id,"request.json",request);write(id,"job.json",job);context.getSharedPreferences("asr",0).edit().putString("active",id).commit();
        try{context.startForegroundService(new Intent(context,AsrService.class).putExtra("jobId",id));}catch(Exception error){job.put("status","error").put("error","无法启动本地识别前台任务");write(id,"job.json",job);throw error;}
        return job;
    }
    private JSONObject startModel() throws Exception {
        String id=UUID.randomUUID().toString();if(!folder(id).mkdir())throw new IOException("无法准备模型下载目录");
        JSONObject request=new JSONObject().put("kind","model"),job=new JSONObject().put("id",id).put("kind","model").put("status","running").put("stage","正在检查 Parakeet 模型").put("pct",0).put("bytes",0).put("total",modelStatus(context).getLong("totalBytes")).put("startedAt",System.currentTimeMillis());
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
        Thread thread=workerThread;if(thread!=null)thread.interrupt();forceStop(id,"cancelled","识别已停止，原稿保留",3);
    }
    private void forceStop(String id,String state,String message,int seconds){clock.schedule(()->{synchronized(this){if(child&&working&&current!=null&&current.optString("id").equals(id)){try{current.put("status",state).put("error",message);persist();}catch(Exception ignored){}Process.killProcess(Process.myPid());}}},seconds,TimeUnit.SECONDS);}
    synchronized void receive(String id) throws Exception {
        if(!child||working)throw new IOException("本地识别任务启动失败");JSONObject job=read(id,"job.json");if(!job.optString("status").equals("running"))return;
        JSONObject request=read(id,"request.json");current=job;current.put("pid",Process.myPid());working=true;cancelled.set(false);timedOut=false;persist();
        watchdog=clock.schedule(()->{timedOut=true;cancelled.set(true);forceStop(id,"error","Parakeet 任务超时，原稿保留",3);Thread thread=workerThread;if(thread!=null)thread.interrupt();},request.optString("kind").equals("model")?1:6,TimeUnit.HOURS);
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
            if(request.optString("kind").equals("model")){downloadModels(id);return;}
            check();File source=media(request.getString("mediaId"));if(source.length()!=request.getLong("mediaBytes")||source.lastModified()!=request.getLong("mediaModified"))throw new IOException("识别源媒体已经变化，请重新选择");
            progress("正在校验 Parakeet 模型",0);for(String name:ModelFiles.NAMES){check();ModelFiles.verify(new File(models,name),name);}
            progress("正在加载 Parakeet 模型",1);
            OfflineModelConfig model=new OfflineModelConfig();model.getTransducer().setEncoder(new File(models,"encoder.int8.onnx").getPath());model.getTransducer().setDecoder(new File(models,"decoder.int8.onnx").getPath());model.getTransducer().setJoiner(new File(models,"joiner.int8.onnx").getPath());
            model.setTokens(new File(models,"tokens.txt").getPath());model.setModelType("nemo_transducer");model.setProvider("cpu");model.setNumThreads(request.getInt("threads"));
            OfflineRecognizerConfig config=new OfflineRecognizerConfig();config.setModelConfig(model);OfflineRecognizer recognizer=new OfflineRecognizer(null,config);
            JSONArray cues;
            try{check();cues=wave(source,recognizer,request);if(cues==null)cues=decode(source,recognizer,request);}finally{recognizer.release();}
            check();if(cues.length()==0)throw new IOException("没有识别到英文语音，原稿保留");
            JSONObject result=new JSONObject().put("cues",cues).put("engine","parakeet-tdt-v2-int8").put("language","en").put("mediaId",request.getString("mediaId")).put("start",request.getDouble("start")).put("end",request.getDouble("end"));
            if(result.toString().length()>12*1024*1024)throw new IOException("识别结果过大，请分段识别");write(id,"result.json",result);check();
            synchronized(this){current.put("status","done").put("pct",100).put("stage","本地识别完成，等待写入稿件");persist();}
        }catch(Throwable error){
            try{synchronized(this){boolean stopped=!timedOut&&(cancelled.get()||Thread.currentThread().isInterrupted()||new File(folder(id),"cancel.flag").isFile());String message=timedOut?"Parakeet 任务超时，原稿保留":stopped?"Parakeet 任务已停止，原稿保留":error instanceof IOException?error.getMessage():"Parakeet 识别失败，原稿保留";current.put("status",stopped?"cancelled":"error").put("error",message).put("stage",message);persist();}}catch(Exception ignored){}
        }finally{Thread.interrupted();workerThread=null;if(watchdog!=null)watchdog.cancel(false);synchronized(this){working=false;}context.stopService(new Intent(context,AsrService.class));}
    }
    private void downloadModels(String id) throws Exception {
        models.mkdirs();long total=0,completed=0;for(long size:ModelFiles.SIZES)total+=size;
        for(String name:ModelFiles.NAMES){
            check();File target=new File(models,name);boolean valid=false;
            if(target.isFile())try{progress("正在校验模型 · "+name,100.0*completed/total);ModelFiles.verify(target,name);valid=true;}catch(IOException error){check();}
            if(valid){completed+=ModelFiles.size(name);continue;}
            File part=new File(folder(id),name+".part");long expected=ModelFiles.size(name);
            if(folder(id).getUsableSpace()<expected+32L*1024*1024)throw new IOException("空间不足，无法下载 Parakeet 模型");
            HttpsURLConnection connection=null;
            try{
                URL url=new URL("https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main/"+name);
                for(int hop=0;hop<=5;hop++){
                    check();if(!url.getProtocol().equals("https")||url.getUserInfo()!=null)throw new IOException("模型下载重定向无效");
                    connection=(HttpsURLConnection)url.openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Accept-Encoding","identity");
                    int status=connection.getResponseCode();if(status>=300&&status<400){String location=connection.getHeaderField("Location");connection.disconnect();connection=null;if(location==null||hop==5)throw new IOException("模型下载重定向过多");url=new URL(url,location);continue;}
                    if(status!=200)throw new IOException("模型下载失败（HTTP "+status+"）");break;
                }
                if(connection==null)throw new IOException("模型下载连接失败");long declared=connection.getContentLengthLong();if(declared>=0&&declared!=expected)throw new IOException("模型下载大小不匹配");
                long downloaded=0,last=0;byte[] buffer=new byte[262144];
                try(InputStream in=connection.getInputStream();FileOutputStream out=new FileOutputStream(part)){
                    for(int count;(count=in.read(buffer))!=-1;){check();downloaded+=count;if(downloaded>expected)throw new IOException("模型下载超过预期大小");out.write(buffer,0,count);long now=System.currentTimeMillis();if(now-last>=350){last=now;synchronized(this){current.put("bytes",completed+downloaded).put("total",total);}progress("正在下载 Parakeet · "+name,100.0*(completed+downloaded)/total);}}
                    out.getFD().sync();
                }
                check();progress("正在校验模型 · "+name,100.0*(completed+downloaded)/total);ModelFiles.verify(part,name);check();
                Files.move(part.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);completed+=expected;
            }catch(IOException error){check();String message=error.getMessage();if(message!=null&&(message.startsWith("模型")||message.startsWith("空间不足")))throw error;throw new IOException("模型下载失败，请检查网络后重试");}
            finally{if(connection!=null)connection.disconnect();if(part.isFile())part.delete();}
        }
        check();write(id,"result.json",new JSONObject().put("modelReady",true));
        synchronized(this){current.put("status","done").put("stage","Parakeet 模型已就绪").put("pct",100).put("bytes",total).put("total",total);persist();}
    }
    private double end(JSONObject request,double duration) throws Exception {
        double value=request.getDouble("end"),start=request.getDouble("start");if(value<0)value=duration;else if(duration>0)value=Math.min(value,duration);
        if(!Double.isFinite(value)||value<=start||value-start>14400)throw new IOException("音轨时长无效，单次识别最长四小时");return value;
    }
    /** Direct PCM WAV support: MediaCodec does not provide an audio/raw decoder. */
    private JSONArray wave(File source,OfflineRecognizer recognizer,JSONObject request) throws Exception {
        try(RandomAccessFile input=new RandomAccessFile(source,"r")){
            byte[] h=new byte[12];if(input.read(h)!=12||!new String(h,0,4,StandardCharsets.US_ASCII).equals("RIFF")||!new String(h,8,4,StandardCharsets.US_ASCII).equals("WAVE"))return null;
            int type=0,channels=0,rate=0,bits=0;long data=-1,size=0;
            while(input.getFilePointer()+8<=input.length()){
                byte[] header=new byte[8];input.readFully(header);String name=new String(header,0,4,StandardCharsets.US_ASCII);long count=ByteBuffer.wrap(header,4,4).order(ByteOrder.LITTLE_ENDIAN).getInt()&0xffffffffL,next=input.getFilePointer()+count+(count%2);
                if(next>input.length()+1)throw new IOException("WAV 文件不完整");
                if(name.equals("fmt ")){if(count<16)throw new IOException("WAV 格式无效");byte[] format=new byte[16];input.readFully(format);ByteBuffer b=ByteBuffer.wrap(format).order(ByteOrder.LITTLE_ENDIAN);type=b.getShort()&65535;channels=b.getShort()&65535;rate=b.getInt();b.getInt();b.getShort();bits=b.getShort()&65535;}
                else if(name.equals("data")){data=input.getFilePointer();size=count;}input.seek(next);
            }
            if(data<0||rate<8000||rate>192000||channels<1||channels>8||!((type==1&&bits==16)||(type==3&&bits==32)))throw new IOException("WAV 需使用 16 位 PCM 或 32 位浮点编码");
            int bytes=bits/8,frame=channels*bytes;double start=request.getDouble("start"),finish=end(request,size/(double)frame/rate);long first=(long)Math.ceil(start*rate),last=Math.min(size/frame,(long)Math.floor(finish*rate));input.seek(data+first*frame);
            Collector out=new Collector(recognizer,rate,start,finish);byte[] buffer=new byte[Math.min(rate,48000)*frame];long position=first;
            while(position<last){check();int frames=(int)Math.min(buffer.length/frame,last-position);input.readFully(buffer,0,frames*frame);ByteBuffer pcm=ByteBuffer.wrap(buffer,0,frames*frame).order(ByteOrder.LITTLE_ENDIAN);out.accept(pcm,channels,type==3?AudioFormat.ENCODING_PCM_FLOAT:AudioFormat.ENCODING_PCM_16BIT,position/(double)rate);position+=frames;}
            return out.finish();
        }
    }
    private JSONArray decode(File source,OfflineRecognizer recognizer,JSONObject request) throws Exception {
        MediaExtractor extractor=new MediaExtractor();MediaCodec codec=null;
        try{
            extractor.setDataSource(source.getPath());MediaFormat format=null;
            for(int i=0;i<extractor.getTrackCount();i++){MediaFormat value=extractor.getTrackFormat(i);if(value.getString(MediaFormat.KEY_MIME).startsWith("audio/")){format=value;extractor.selectTrack(i);break;}}
            if(format==null)throw new IOException("媒体没有可解码的音轨");
            double start=request.getDouble("start"),duration=format.containsKey(MediaFormat.KEY_DURATION)?format.getLong(MediaFormat.KEY_DURATION)/1000000.0:-1,finish=end(request,duration);
            int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE),channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT),encoding=format.containsKey(MediaFormat.KEY_PCM_ENCODING)?format.getInteger(MediaFormat.KEY_PCM_ENCODING):AudioFormat.ENCODING_PCM_16BIT;
            Collector out=new Collector(recognizer,rate,start,finish);extractor.seekTo((long)(start*1000000),MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            if(format.getString(MediaFormat.KEY_MIME).equals("audio/raw")){
                ByteBuffer buffer=ByteBuffer.allocate(2*1024*1024);while(true){check();buffer.clear();long stamp=extractor.getSampleTime();int count=extractor.readSampleData(buffer,0);if(count<0||stamp/1000000.0>=finish)break;buffer.position(0);buffer.limit(count);out.accept(buffer,channels,encoding,stamp/1000000.0);extractor.advance();}return out.finish();
            }
            codec=MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));codec.configure(format,null,null,0);codec.start();
            boolean inputEnd=false,outputEnd=false;MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();long lastOutput=System.currentTimeMillis();
            while(!outputEnd){
                check();if(System.currentTimeMillis()-lastOutput>120000)throw new IOException("音频解码超时，请换用 WAV / MP4");
                if(!inputEnd){int i=codec.dequeueInputBuffer(10000);if(i>=0){ByteBuffer buffer=codec.getInputBuffer(i);long stamp=extractor.getSampleTime();int count=extractor.readSampleData(buffer,0);if(count<0||stamp/1000000.0>finish+.5){codec.queueInputBuffer(i,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputEnd=true;}else{codec.queueInputBuffer(i,0,count,stamp,0);extractor.advance();}}}
                int i=codec.dequeueOutputBuffer(info,10000);
                if(i==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat actual=codec.getOutputFormat();channels=actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT);int next=actual.getInteger(MediaFormat.KEY_SAMPLE_RATE);if(next!=rate)throw new IOException("音轨采样率发生变化");encoding=actual.containsKey(MediaFormat.KEY_PCM_ENCODING)?actual.getInteger(MediaFormat.KEY_PCM_ENCODING):AudioFormat.ENCODING_PCM_16BIT;}
                else if(i>=0){ByteBuffer buffer=codec.getOutputBuffer(i);buffer.position(info.offset);buffer.limit(info.offset+info.size);out.accept(buffer,channels,encoding,info.presentationTimeUs/1000000.0);lastOutput=System.currentTimeMillis();outputEnd=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0||info.presentationTimeUs/1000000.0>=finish;codec.releaseOutputBuffer(i,false);}
            }
            return out.finish();
        }finally{if(codec!=null){try{codec.stop();}catch(Exception ignored){}codec.release();}extractor.release();}
    }
    private final class Collector {
        final OfflineRecognizer recognizer;final int rate;final double start,end;final float[] samples;final JSONArray cues=new JSONArray();int used,wordCount;double offset;
        Collector(OfflineRecognizer recognizer,int rate,double start,double end) throws IOException {if(rate<8000||rate>192000)throw new IOException("音频采样率不受支持");this.recognizer=recognizer;this.rate=rate;this.start=start;this.end=end;samples=new float[rate*20];}
        void accept(ByteBuffer pcm,int channels,int encoding,double stamp) throws Exception {
            if(channels<1||channels>8||encoding!=AudioFormat.ENCODING_PCM_FLOAT&&encoding!=AudioFormat.ENCODING_PCM_16BIT)throw new IOException("不支持该 PCM 音频格式");
            int bytes=encoding==AudioFormat.ENCODING_PCM_FLOAT?4:2,index=0;pcm.order(ByteOrder.LITTLE_ENDIAN);
            while(pcm.remaining()>=bytes*channels){float value=0;for(int c=0;c<channels;c++)value+=encoding==AudioFormat.ENCODING_PCM_FLOAT?pcm.getFloat():pcm.getShort()/32768f;double time=stamp+index++/(double)rate;if(time<start||time>=end)continue;if(!Float.isFinite(value))value=0;if(used==0)offset=time;samples[used++]=Math.max(-1,Math.min(1,value/channels));if(used==samples.length)flush();}
        }
        void flush() throws Exception {
            if(used==0)return;check();double chunkEnd=offset+used/(double)rate;OfflineStream stream=recognizer.createStream();
            try{
                stream.acceptWaveform(used==samples.length?samples:Arrays.copyOf(samples,used),rate);recognizer.decode(stream);check();
                OfflineRecognizerResult result=recognizer.getResult(stream);String[] tokens=result.getTokens();float[] stamps=result.getTimestamps(),durations=result.getDurations();
                if(tokens.length>0&&stamps.length!=tokens.length)throw new IOException("模型未返回逐词时间，请检查模型版本");
                JSONArray words=new JSONArray();StringBuilder word=new StringBuilder();double wordStart=0,wordEnd=0,previous=0;
                for(int i=0;i<tokens.length;i++){
                    String token=tokens[i];if(token==null||token.isEmpty()||token.startsWith("<")&&token.endsWith(">"))continue;
                    double at=stamps[i],duration=i<durations.length?durations[i]:0;if(!Double.isFinite(at)||at<previous-.001||at<0)throw new IOException("模型返回的逐词时间无效");previous=at;
                    double from=Math.max(offset,Math.min(chunkEnd,offset+at)),to=Math.min(chunkEnd,offset+at+(Double.isFinite(duration)&&duration>0?duration:i+1<stamps.length?Math.max(0,stamps[i+1]-at):Math.max(0,chunkEnd-offset-at)));
                    String text=token.replace('▁',' ');boolean starts=Character.isWhitespace(text.charAt(0));
                    if(starts&&word.length()>0){words.put(new JSONObject().put("text",word.toString()).put("start",wordStart).put("end",Math.max(wordStart,wordEnd)));word.setLength(0);}
                    text=text.trim();if(text.isEmpty())continue;if(word.length()==0)wordStart=from;word.append(text);wordEnd=Math.max(from,to);
                }
                if(word.length()>0)words.put(new JSONObject().put("text",word.toString()).put("start",wordStart).put("end",Math.max(wordStart,wordEnd)));
                wordCount+=words.length();if(wordCount>100000)throw new IOException("识别结果过多，请分段识别");
                JSONArray sentence=new JSONArray();StringBuilder text=new StringBuilder();
                for(int i=0;i<words.length();i++){JSONObject item=words.getJSONObject(i);sentence.put(item);if(text.length()>0)text.append(' ');text.append(item.getString("text"));if(item.getString("text").matches(".*[.!?]$" )||text.length()>=100||sentence.length()>=18||i==words.length()-1){double from=sentence.getJSONObject(0).getDouble("start"),to=sentence.getJSONObject(sentence.length()-1).getDouble("end");if(to>from)cues.put(new JSONObject().put("start",from).put("end",to).put("text",text.toString()).put("words",sentence));sentence=new JSONArray();text.setLength(0);}}
                progress("识别中 · 已生成 "+cues.length()+" 条字幕",2+96*Math.min(1,(chunkEnd-start)/(end-start)));
            }finally{stream.release();used=0;}
        }
        JSONArray finish() throws Exception {flush();check();return cues;}
    }
}
