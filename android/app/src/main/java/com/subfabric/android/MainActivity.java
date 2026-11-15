package com.subfabric.android;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.*;
import android.media.*;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import com.k2fsa.sherpa.onnx.*;

/** Offline prototype: no desktop server, network permission, or broad storage permission. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://subfabric.local";
    private static final int MEDIA = 10, SUBTITLE = 11, MODEL = 12, EXPORT = 13;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(), cancelled = new AtomicBoolean();
    private final Handler handler = new Handler(android.os.Looper.getMainLooper());
    private WebView web;
    private String pickerId, exportText;
    private volatile boolean destroyed;
    private volatile long deadline;
    private File projects, media, models;
    private final Runnable watchdog = new Runnable() {
        public void run() {
            if (busy.get() && System.currentTimeMillis() > deadline) cancelled.set(true);
            if (!destroyed) handler.postDelayed(this, 1000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        projects = new File(getFilesDir(), "projects"); projects.mkdirs();
        media = new File(getFilesDir(), "media"); media.mkdirs();
        models = new File(getFilesDir(), "parakeet"); models.mkdirs();
        getWindow().setStatusBarColor(0xff10131b);
        getWindow().setNavigationBarColor(0xff10131b);
        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.setBackgroundColor(0xff10131b);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (!"https".equals(uri.getScheme()) || !"subfabric.local".equals(uri.getHost())) return empty(403);
                String path = uri.getPath();
                try {
                    if (path.startsWith("/media/")) return serveMedia(path.substring(7), req.getRequestHeaders().get("Range"));
                    String asset = path.equals("/") ? "index.html" : path.substring(1);
                    if (!asset.matches("[a-zA-Z0-9_./-]+") || asset.contains("..")) return empty(403);
                    String mime = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".png") ? "image/png" : asset.endsWith(".json") ? "application/json" : "text/html";
                    WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", getAssets().open(asset));
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'");
                    headers.put("X-Content-Type-Options", "nosniff");
                    response.setResponseHeaders(headers);
                    return response;
                } catch (Exception e) { return empty(404); }
            }
            @Override public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler h, android.net.http.SslError e) { h.cancel(); }
        });
        web.addJavascriptInterface(new Bridge(), "SubFabric");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView v,String url,String message,JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("继续",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true;
            }
            @Override public boolean onConsoleMessage(ConsoleMessage message) { android.util.Log.d("SubFabricWeb",message.message()+" @"+message.lineNumber()); return true; }
        });
        setContentView(web);
        handler.post(watchdog);
        web.loadUrl(ORIGIN + "/");
    }

    private WebResourceResponse empty(int status) {
        return new WebResourceResponse("text/plain", "UTF-8", status, status == 404 ? "Not Found" : "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private WebResourceResponse serveMedia(String id, String range) throws Exception {
        File file = mediaFile(id);
        long size = file.length(), start = 0, end = size - 1;
        if (!file.isFile() || size == 0) return empty(404);
        boolean partial = range != null && range.matches("bytes=\\d*-\\d*");
        if (partial) {
            String[] parts = range.substring(6).split("-", -1);
            if (parts[0].isEmpty()) start = Math.max(0, size - Long.parseLong(parts[1]));
            else {
                start = Long.parseLong(parts[0]);
                if (!parts[1].isEmpty()) end = Math.min(end, Long.parseLong(parts[1]));
            }
            if (start >= size || end < start) return new WebResourceResponse("text/plain", "UTF-8", 416, "Range Not Satisfiable", Collections.singletonMap("Content-Range", "bytes */" + size), new ByteArrayInputStream(new byte[0]));
        }
        FileInputStream input = new FileInputStream(file); input.getChannel().position(start);
        final long limit = end - start + 1;
        InputStream bounded = new FilterInputStream(input) {
            long remaining = limit;
            @Override public int read(byte[] b, int off, int len) throws IOException { if (remaining <= 0) return -1; int n = super.read(b, off, (int)Math.min(len, remaining)); if(n > 0) remaining -= n; return n; }
            @Override public int read() throws IOException { if(remaining <= 0) return -1; int n=super.read(); if(n >= 0) remaining--; return n; }
        };
        Map<String,String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes"); headers.put("Content-Length", String.valueOf(limit));
        if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        String mime = readProject(id).optString("mime", "video/mp4");
        return new WebResourceResponse(mime, null, partial ? 206 : 200, partial ? "Partial Content" : "OK", headers, bounded);
    }

    public final class Bridge {
        @JavascriptInterface public void call(String id, String action, String json) {
            if (destroyed || id == null || id.length() > 80 || json.length() > 8 * 1024 * 1024) return;
            if (action.equals("cancel")) { cancelled.set(true); reply(id, true, new JSONObject()); return; }
            if (busy.get() && !action.equals("status")) { reply(id, false, "任务进行中，请先等待或停止"); return; }
            if (action.equals("pickMedia") || action.equals("pickSubtitle") || action.equals("pickModel") || action.equals("export")) {
                runOnUiThread(() -> {
                    if (pickerId != null) { reply(id, false, "请先完成当前文件选择"); return; }
                    try {
                        JSONObject arg = new JSONObject(json);
                        pickerId = id;
                        Intent intent;
                        int request;
                        if (action.equals("pickModel")) { request = MODEL; intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); }
                        else if (action.equals("export")) {
                            request = EXPORT; exportText = arg.getString("text");
                            intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/x-subrip").addCategory(Intent.CATEGORY_OPENABLE);
                            intent.putExtra(Intent.EXTRA_TITLE, "SubFabric.srt");
                        } else {
                            request = action.equals("pickMedia") ? MEDIA : SUBTITLE;
                            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                            if (request == MEDIA) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "audio/*"});
                        }
                        startActivityForResult(intent, request);
                    } catch (Exception e) { pickerId = null; reply(id, false, message(e)); }
                });
                return;
            }
            worker.execute(() -> {
                try {
                    JSONObject arg = new JSONObject(json);
                    Object result;
                    switch (action) {
                        case "status": result = new JSONObject().put("modelReady", modelReady()).put("engine", "Parakeet TDT v2 · int8 · CPU").put("abi", android.os.Build.SUPPORTED_ABIS[0]).put("version", "0.1.0"); break;
                        case "list": {
                            JSONArray list = new JSONArray();
                            File[] files = projects.listFiles((dir, name) -> name.endsWith(".json"));
                            if (files != null) { Arrays.sort(files, (a,b) -> Long.compare(b.lastModified(),a.lastModified())); for(File f: files) { JSONObject p = new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)); p.remove("cues"); list.put(p); } }
                            result = list; break;
                        }
                        case "load": result = readProject(arg.getString("id")); break;
                        case "save": {
                            String projectId = arg.getString("id"); JSONObject existing = readProject(projectId);
                            existing.put("cues", arg.getJSONArray("cues")).put("title", arg.getString("title")).put("updated", System.currentTimeMillis());
                            writeProject(existing); result = existing; break;
                        }
                        case "new": {
                            JSONObject p = new JSONObject().put("id", UUID.randomUUID().toString()).put("title", "未命名稿件").put("cues", new JSONArray()).put("updated", System.currentTimeMillis());
                            writeProject(p); result = p; break;
                        }
                        case "recognize": result = recognize(arg.getString("id")); break;
                        default: throw new IOException("未知操作");
                    }
                    reply(id, true, result);
                } catch (Throwable e) { reply(id, false, message(e)); }
            });
        }
    }

    private String message(Throwable e) { return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
    private void reply(String id, boolean ok, Object data) { try { emit("response", new JSONObject().put("id", id).put("ok",ok).put("data",data)); } catch(JSONException ignored) {} }
    private void emit(String type, JSONObject data) {
        if (destroyed) return;
        runOnUiThread(() -> { if(!destroyed) web.evaluateJavascript("window.nativeEvent(" + JSONObject.quote(type) + "," + data.toString() + ")", null); });
    }
    private void progress(String text, double percent) { try { emit("progress", new JSONObject().put("message",text).put("percent",percent)); } catch(JSONException ignored) {} }
    private File projectFile(String id) throws IOException { if(!id.matches("[0-9a-f-]{36}")) throw new IOException("无效的稿件 ID"); return new File(projects,id+".json"); }
    private File mediaFile(String id) throws IOException { projectFile(id); return new File(media,id+".media"); }
    private JSONObject readProject(String id) throws Exception { return new JSONObject(new String(Files.readAllBytes(projectFile(id).toPath()), StandardCharsets.UTF_8)); }
    private void writeProject(JSONObject p) throws Exception {
        File dest = projectFile(p.getString("id")); File temp = new File(projects,dest.getName()+".tmp");
        try(FileOutputStream output = new FileOutputStream(temp)) { output.write(p.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        Files.move(temp.toPath(),dest.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
    }
    private boolean modelReady() { for(String name: ModelFiles.NAMES) { if(!new File(models,name).isFile() || new File(models,name).length() != ModelFiles.size(name)) return false; } return true; }
    private void checkCancelled() throws IOException { if(cancelled.get() || destroyed || Thread.currentThread().isInterrupted()) throw new IOException("任务已停止；原字幕保留"); }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        String id = pickerId; pickerId = null;
        if (id == null) return;
        if (result != RESULT_OK || data == null || data.getData() == null) { reply(id,true,JSONObject.NULL); return; }
        Uri uri = data.getData();
        String output = exportText; exportText = null;
        busy.set(true); cancelled.set(false); deadline=System.currentTimeMillis()+15*60*1000;
        worker.execute(() -> {
            try {
                Object response;
                if (request == MEDIA) {
                    String projectId = UUID.randomUUID().toString(); File target=mediaFile(projectId);
                    String name = "导入的媒体";
                    try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) { if(cursor!=null && cursor.moveToFirst()) name=cursor.getString(0); }
                    try(InputStream input=getContentResolver().openInputStream(uri); OutputStream out=new FileOutputStream(target)) {
                        copy(input,out,2L*1024*1024*1024,"正在导入媒体");
                    } catch(Throwable e) { target.delete(); throw e; }
                    JSONObject p=new JSONObject().put("id",projectId).put("title",name).put("mime",getContentResolver().getType(uri)).put("media",true).put("cues",new JSONArray()).put("updated",System.currentTimeMillis());
                    writeProject(p); response=p;
                } else if(request==SUBTITLE) {
                    ByteArrayOutputStream out=new ByteArrayOutputStream();
                    try(InputStream input=getContentResolver().openInputStream(uri)) { copy(input,out,8*1024*1024,"正在导入字幕"); }
                    response=new JSONObject().put("text",out.toString("UTF-8"));
                } else if(request==MODEL) {
                    Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(uri,DocumentsContract.getTreeDocumentId(uri));
                    Map<String,Uri> found=new HashMap<>();
                    try(Cursor cursor=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)) {
                        while(cursor!=null && cursor.moveToNext()) found.put(cursor.getString(1),DocumentsContract.buildDocumentUriUsingTree(uri,cursor.getString(0)));
                    }
                    for(String name:ModelFiles.NAMES) if(!found.containsKey(name)) throw new IOException("所选文件夹缺少 " + name);
                    for(String name:ModelFiles.NAMES) {
                        File temp=new File(models,name+".part");
                        try {
                            try(InputStream input=getContentResolver().openInputStream(found.get(name)); OutputStream out=new FileOutputStream(temp)) { copy(input,out,ModelFiles.size(name),"正在导入 "+name); }
                            ModelFiles.verify(temp,name);
                            Files.move(temp.toPath(),new File(models,name).toPath(),StandardCopyOption.REPLACE_EXISTING);
                        } finally { temp.delete(); }
                    }
                    response=new JSONObject().put("modelReady",modelReady());
                } else {
                    try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")) { out.write(output.getBytes(StandardCharsets.UTF_8)); }
                    response=new JSONObject().put("exported",true);
                }
                reply(id,true,response);
            } catch(Throwable e) { reply(id,false,message(e)); }
            finally { busy.set(false); }
        });
    }

    private void copy(InputStream in,OutputStream out,long max,String label) throws Exception {
        if(in==null) throw new IOException("无法读取所选文件");
        byte[] buffer=new byte[65536]; long total=0,last=0;
        for(int n;(n=in.read(buffer))!=-1;) { checkCancelled(); total+=n; if(total>max) throw new IOException("文件超过原型大小上限"); out.write(buffer,0,n); if(System.currentTimeMillis()-last>500) { progress(label+" · "+total/1048576+" MB",-1); last=System.currentTimeMillis(); } }
    }

    private JSONObject recognize(String id) throws Exception {
        if(!modelReady()) throw new IOException("请先在识别设置导入 Parakeet v2 int8 模型");
        if(!busy.compareAndSet(false,true)) throw new IOException("已有任务进行中");
        cancelled.set(false); deadline=System.currentTimeMillis()+30*60*1000;
        OfflineRecognizer recognizer=null; MediaExtractor extractor=new MediaExtractor(); MediaCodec codec=null;
        try {
            JSONObject project=readProject(id);
            if(!project.optBoolean("media")) throw new IOException("请先导入音频或视频");
            progress("加载 Parakeet · 仅在本机识别",0);
            // Verify hashes before passing any imported ONNX into native code.
            for(String name:ModelFiles.NAMES) { checkCancelled(); ModelFiles.verify(new File(models,name),name); }
            OfflineModelConfig model=new OfflineModelConfig();
            model.getTransducer().setEncoder(new File(models,"encoder.int8.onnx").getPath());
            model.getTransducer().setDecoder(new File(models,"decoder.int8.onnx").getPath());
            model.getTransducer().setJoiner(new File(models,"joiner.int8.onnx").getPath());
            model.setTokens(new File(models,"tokens.txt").getPath()); model.setModelType("nemo_transducer");
            model.setProvider("cpu"); model.setNumThreads(Math.min(4,Math.max(1,Runtime.getRuntime().availableProcessors())));
            OfflineRecognizerConfig config=new OfflineRecognizerConfig(); config.setModelConfig(model);
            recognizer=new OfflineRecognizer(null,config);
            JSONArray wavCues=recognizeWave(mediaFile(id),recognizer);
            if(wavCues!=null) return finishRecognition(id,wavCues);
            extractor.setDataSource(mediaFile(id).getPath());
            MediaFormat format=null;
            for(int t=0;t<extractor.getTrackCount();t++) { MediaFormat f=extractor.getTrackFormat(t); if(f.getString(MediaFormat.KEY_MIME).startsWith("audio/")) { extractor.selectTrack(t); format=f; break; } }
            if(format==null) throw new IOException("媒体没有可解码的音轨");
            long duration=format.containsKey(MediaFormat.KEY_DURATION)?format.getLong(MediaFormat.KEY_DURATION):0;
            codec=MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)); codec.configure(format,null,null,0); codec.start();
            int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE), channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT), encoding=AudioFormat.ENCODING_PCM_16BIT;
            float[] samples=new float[rate*20]; int used=0; double chunkStart=0; boolean inputEnd=false,outputEnd=false;
            JSONArray cues=new JSONArray(); MediaCodec.BufferInfo info=new MediaCodec.BufferInfo(); long lastOutput=System.currentTimeMillis();
            while(!outputEnd) {
                checkCancelled();
                if(System.currentTimeMillis()-lastOutput>120000) throw new IOException("音频解码超时，请换用 WAV / MP4");
                if(!inputEnd) { int idx=codec.dequeueInputBuffer(10000); if(idx>=0) { ByteBuffer buffer=codec.getInputBuffer(idx); int n=extractor.readSampleData(buffer,0); if(n<0) { codec.queueInputBuffer(idx,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnd=true; } else { codec.queueInputBuffer(idx,0,n,extractor.getSampleTime(),0); extractor.advance(); } } }
                int idx=codec.dequeueOutputBuffer(info,10000);
                if(idx==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat f=codec.getOutputFormat(); rate=f.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels=f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    encoding=f.containsKey(MediaFormat.KEY_PCM_ENCODING)?f.getInteger(MediaFormat.KEY_PCM_ENCODING):AudioFormat.ENCODING_PCM_16BIT;
                    if(encoding!=AudioFormat.ENCODING_PCM_FLOAT && encoding!=AudioFormat.ENCODING_PCM_16BIT) throw new IOException("暂不支持该 PCM 音频编码");
                    if(used!=0) throw new IOException("不支持中途改变采样率的音轨");
                    samples=new float[rate*20];
                } else if(idx>=0) {
                    lastOutput=System.currentTimeMillis();
                    ByteBuffer buffer=codec.getOutputBuffer(idx); buffer.position(info.offset); buffer.limit(info.offset+info.size); buffer.order(ByteOrder.LITTLE_ENDIAN);
                    if(used==0 && info.size>0) chunkStart=info.presentationTimeUs/1000000.0;
                    int bytes=encoding==AudioFormat.ENCODING_PCM_FLOAT?4:2;
                    while(buffer.remaining()>=bytes*channels) {
                        float value=0; for(int c=0;c<channels;c++) value+=encoding==AudioFormat.ENCODING_PCM_FLOAT?buffer.getFloat():buffer.getShort()/32768f;
                        samples[used++]=value/channels;
                        if(used==samples.length) {
                            appendResult(recognizer,samples,rate,chunkStart,cues); checkCancelled();
                            chunkStart+=used/(double)rate; used=0;
                            progress("识别中 · 已生成 "+cues.length()+" 条字幕",duration>0?Math.min(99,100*chunkStart/(duration/1000000.0)):-1);
                        }
                    }
                    outputEnd=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0; codec.releaseOutputBuffer(idx,false);
                }
            }
            if(used>0) appendResult(recognizer,Arrays.copyOf(samples,used),rate,chunkStart,cues);
            checkCancelled();
            if(cues.length()==0) throw new IOException("没有识别到英文语音，原字幕保留");
            // Reload metadata so this worker only replaces its own result fields.
            return finishRecognition(id,cues);
        } finally {
            if(codec!=null) { try { codec.stop(); } catch(Exception ignored) {} codec.release(); }
            extractor.release(); if(recognizer!=null) recognizer.release(); busy.set(false);
        }
    }

    private JSONObject finishRecognition(String id,JSONArray cues) throws Exception {
        checkCancelled();
        if(cues.length()==0) throw new IOException("没有识别到英文语音，原字幕保留");
        JSONObject project=readProject(id); project.put("cues",cues).put("updated",System.currentTimeMillis()).put("engine","parakeet-tdt-v2-int8");
        writeProject(project); progress("本地识别完成",100); return project;
    }

    /** WAV PCM is read directly: Android MediaCodec has no audio/raw decoder. */
    private JSONArray recognizeWave(File file,OfflineRecognizer recognizer) throws Exception {
        try(RandomAccessFile input=new RandomAccessFile(file,"r")) {
            byte[] header=new byte[12]; if(input.read(header)!=12 || !new String(header,0,4,StandardCharsets.US_ASCII).equals("RIFF") || !new String(header,8,4,StandardCharsets.US_ASCII).equals("WAVE")) return null;
            int type=0,channels=0,rate=0,bits=0; long dataOffset=-1,dataSize=0;
            while(input.getFilePointer()+8<=input.length()) {
                byte[] chunk=new byte[8]; input.readFully(chunk); String name=new String(chunk,0,4,StandardCharsets.US_ASCII);
                long size=ByteBuffer.wrap(chunk,4,4).order(ByteOrder.LITTLE_ENDIAN).getInt()&0xffffffffL;
                long next=input.getFilePointer()+size+(size%2);
                if(next>input.length()+1) throw new IOException("WAV 文件不完整");
                if(name.equals("fmt ")) {
                    if(size<16) throw new IOException("WAV 格式无效");
                    byte[] fmt=new byte[16]; input.readFully(fmt); ByteBuffer b=ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN);
                    type=b.getShort()&65535; channels=b.getShort()&65535; rate=b.getInt(); b.getInt(); b.getShort(); bits=b.getShort()&65535;
                } else if(name.equals("data")) { dataOffset=input.getFilePointer(); dataSize=size; }
                input.seek(next);
            }
            if(dataOffset<0 || rate<8000 || rate>192000 || channels<1 || channels>8 || !((type==1 && bits==16)||(type==3 && bits==32))) throw new IOException("WAV 需使用 16 位 PCM 或 32 位浮点编码");
            input.seek(dataOffset); int bytes=bits/8, frame=channels*bytes; long consumed=0; JSONArray cues=new JSONArray();
            byte[] buffer=new byte[rate*20*frame];
            while(consumed<dataSize) {
                checkCancelled(); int count=(int)Math.min(buffer.length,dataSize-consumed); count-=count%frame;
                if(count==0) break; input.readFully(buffer,0,count); ByteBuffer pcm=ByteBuffer.wrap(buffer,0,count).order(ByteOrder.LITTLE_ENDIAN);
                float[] samples=new float[count/frame];
                for(int i=0;i<samples.length;i++) { float value=0; for(int c=0;c<channels;c++) value+=type==3?pcm.getFloat():pcm.getShort()/32768f; samples[i]=value/channels; }
                appendResult(recognizer,samples,rate,consumed/(double)frame/rate,cues); consumed+=count;
                progress("识别中 · 已生成 "+cues.length()+" 条字幕",100.0*consumed/dataSize);
            }
            return cues;
        }
    }

    private void appendResult(OfflineRecognizer recognizer,float[] samples,int rate,double offset,JSONArray cues) throws Exception {
        checkCancelled(); OfflineStream stream=recognizer.createStream();
        try {
            stream.acceptWaveform(samples,rate); recognizer.decode(stream); checkCancelled();
            OfflineRecognizerResult result=recognizer.getResult(stream);
            String[] tokens=result.getTokens(); float[] stamps=result.getTimestamps(); float[] durations=result.getDurations();
            StringBuilder text=new StringBuilder(); double start=offset,end=offset;
            for(int i=0;i<tokens.length;i++) {
                if(text.length()==0) start=offset+(i<stamps.length?stamps[i]:0);
                text.append(tokens[i].replace('▁',' '));
                end=offset+(i<stamps.length?stamps[i]:0)+(i<durations.length?durations[i]:0.08);
                boolean boundary=text.toString().trim().matches(".*[.!?]$") || text.length()>100 || i==tokens.length-1;
                if(boundary && text.toString().trim().length()>0) {
                    double chunkEnd=offset+samples.length/(double)rate;
                    cues.put(new JSONObject().put("id",cues.length()+1).put("start",Math.max(offset,start)).put("end",Math.min(chunkEnd,Math.max(start+0.08,end))).put("lines",new JSONArray().put(text.toString().trim())));
                    text.setLength(0);
                }
            }
        } finally { stream.release(); }
    }
    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); }
    @Override protected void onDestroy() { destroyed=true; cancelled.set(true); handler.removeCallbacks(watchdog); worker.shutdownNow(); if(web!=null) {web.removeJavascriptInterface("SubFabric"); web.destroy();} super.onDestroy(); }
}
