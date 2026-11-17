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


/** Android Studio: embedded editor, SAF storage and native translation transport. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://subfabric.local";
    private static final int MEDIA = 10, SUBTITLE = 11, MODEL = 12, EXPORT = 13, PACK = 15, DIRECTORY = 16, INPUT_FILES = 17;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService storeWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService llmWorker = Executors.newFixedThreadPool(2);
    private final ExecutorService videoWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService downloadWorker = Executors.newSingleThreadExecutor();
    private LlmStore llmStore;
    private LlmClient llmClient;
    private AppStorage appStorage;
    private final Map<String,Uri> selectedFiles=new ConcurrentHashMap<>();
    private final Map<String,String> selectedNames=new ConcurrentHashMap<>();
    private final Map<String,JSONObject> importedFiles=new ConcurrentHashMap<>();
    private boolean inputVideo;
    private boolean fileChooserMedia;
    private final AtomicBoolean busy = new AtomicBoolean(), cancelled = new AtomicBoolean();
    private final Handler handler = new Handler(android.os.Looper.getMainLooper());
    private WebView web;
    private NativeStudio nativeStudio;
    private String pickerId, exportText;
    private String importModelId;
    private volatile boolean destroyed;
    private volatile long deadline;
    private File projects, media, models;
    private StudioStore studio;
    private ValueCallback<Uri[]> fileChooser;
    private String exportBase64;
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
        studio = new StudioStore(getFilesDir());
        llmStore=new LlmStore(this);llmClient=new LlmClient(llmStore);
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
        // Playback is explicitly started by Android buttons, outside DOM user activation.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (!"https".equals(uri.getScheme()) || !"subfabric.local".equals(uri.getHost())) return empty(403);
                String path = uri.getPath();
                try {
                    if(path.matches("/api/downloads/[0-9a-f-]{36}/thumbnail")){
                        String id=path.split("/")[3];File image=new File(DownloadManager.get(MainActivity.this).folder(id),"thumbnail.bin");if(!image.isFile())return empty(404);return new WebResourceResponse("image/jpeg",null,new FileInputStream(image));
                    }
                    if(path.equals("/api/media")) return serveMedia(uri.getQueryParameter("path"),requestHeader(req,"Range"));
                    if(path.matches("/api/projects/[0-9a-f-]{36}/(audio|peaks)")) {
                        String id=path.split("/")[3]; boolean audio=path.endsWith("audio");
                        File f=studio.file(id,audio?".audio.wav":".peaks.bin");
                        if(!f.isFile())return empty(404);
                        if(audio)return MediaResponse.open(f,"audio/wav",requestHeader(req,"Range"));
                        WebResourceResponse r=new WebResourceResponse("application/octet-stream",null,new FileInputStream(f));
                        Map<String,String> headers=new HashMap<>();headers.put("X-Peak-Rate","100");headers.put("X-Peak-Ch","2");r.setResponseHeaders(headers);return r;
                    }
                    if(path.equals("/api/font-file")) return new WebResourceResponse("font/otf",null,getAssets().open("editor/vendor/fonts/NotoSansCJKsc-Regular.otf"));
                    if (path.startsWith("/media/")) return serveMedia(path.substring(7), requestHeader(req,"Range"));
                    String asset = path.equals("/") ? "editor/studio.html" : path.substring(1);
                    if (!asset.matches("[a-zA-Z0-9_./-]+") || asset.contains("..")) return empty(403);
                    String mime = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".png") ? "image/png" : asset.endsWith(".json") ? "application/json" : asset.endsWith(".wasm")?"application/wasm":asset.endsWith(".otf")?"font/otf":asset.endsWith(".svg")?"image/svg+xml":"text/html";
                    WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", getAssets().open(asset));
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; font-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-src 'none'");
                    headers.put("X-Content-Type-Options", "nosniff");
                    response.setResponseHeaders(headers);
                    return response;
                } catch (Exception e) { return empty(404); }
            }
            @Override public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler h, android.net.http.SslError e) { h.cancel(); }
        });
        web.addJavascriptInterface(new Bridge(), "SubFabric");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if(fileChooser!=null||pickerId!=null){callback.onReceiveValue(null);return true;}
                fileChooser=callback;fileChooserMedia=MediaPicker.acceptsVideo(params.getAcceptTypes());
                boolean multiple=params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE;
                if(fileChooserMedia){emit("media-picker-start",new JSONObject());chooseMedia(14,multiple,false);}
                else{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,multiple);try{startActivityForResult(intent,14);}catch(Exception e){pickerError(14,e);}}
                return true;
            }
            @Override public boolean onJsAlert(WebView v,String url,String message,JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setOnCancelListener(d->result.confirm()).show();return true;
            }
            @Override public boolean onJsConfirm(WebView v,String url,String message,JsResult result) {
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("继续",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true;
            }
            @Override public boolean onConsoleMessage(ConsoleMessage message) { android.util.Log.d("SubFabricWeb",message.message()+" @"+message.lineNumber()); return true; }
        });
        nativeStudio=new NativeStudio(this,web);
        handler.post(watchdog);
        String route=state!=null?state.getString("route","#/home"):getSharedPreferences("window",MODE_PRIVATE).getString("route","#/home");
        if(!route.matches("#/([A-Za-z0-9_/-]*)"))route="#/home";
        web.loadUrl(ORIGIN + "/editor/studio.html"+route);
    }

    private WebResourceResponse empty(int status) {
        return new WebResourceResponse("text/plain", "UTF-8", status, status == 404 ? "Not Found" : "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private String requestHeader(WebResourceRequest request,String name) {
        for(Map.Entry<String,String> header:request.getRequestHeaders().entrySet())if(header.getKey().equalsIgnoreCase(name))return header.getValue();
        return null;
    }
    private WebResourceResponse serveMedia(String id,String range) throws Exception {
        String mime=readProject(id).optString("mime","video/mp4");
        return MediaResponse.open(mediaFile(id),mime,range);
    }

    public final class Bridge {
        @JavascriptInterface public void ui(String json){
            if(destroyed||json==null||json.length()>8*1024*1024)return;
            try{JSONObject snapshot=new JSONObject(json);runOnUiThread(()->{if(!destroyed&&nativeStudio!=null)nativeStudio.accept(snapshot);});}catch(JSONException ignored){}
        }
        @JavascriptInterface public void call(String id, String action, String json) {
            if (destroyed || id == null || id.length() > 80) return;
            if(json.length()>32*1024*1024){reply(id,false,"内容超过安卓传输上限");return;}
            if (action.equals("cancel")) { cancelled.set(true); reply(id, true, new JSONObject()); return; }
            if(action.startsWith("asr")){
                downloadWorker.execute(()->{try{JSONObject arg=new JSONObject(json);AsrManager manager=AsrManager.get(MainActivity.this);Object result;
                    switch(action){
                        case "asrModelStatus":result=AsrManager.modelStatus(MainActivity.this);break;
                        case "asrStart":if(busy.get()||pickerId!=null||fileChooser!=null)throw new IOException("请先完成当前媒体或模型导入");result=manager.start(arg);break;
                        case "asrStatus":result=manager.status(arg.getString("id"));break;
                        case "asrCancel":manager.cancel(arg.getString("id"));result=new JSONObject();break;
                        case "asrActive":result=manager.active();if(result==null)result=JSONObject.NULL;break;
                        default:throw new IOException("未知本机识别操作");
                    }reply(id,true,result);
                }catch(Throwable error){reply(id,false,message(error));}});return;
            }
            if(action.equals("storageScan")||action.equals("storageClean")){
                worker.execute(()->{try{if(appStorage==null)appStorage=new AppStorage(MainActivity.this,studio);JSONObject arg=new JSONObject(json);String protectedProject=arg.optString("protectedProject");reply(id,true,action.equals("storageScan")?appStorage.scan(protectedProject):appStorage.clean(arg.getJSONArray("ids"),protectedProject));}catch(Throwable e){reply(id,false,message(e));}});return;
            }
            if(action.startsWith("download")){
                if(action.equals("downloadStart")&&android.os.Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=android.content.pm.PackageManager.PERMISSION_GRANTED)runOnUiThread(()->requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},45));
                downloadWorker.execute(()->{try{
                    JSONObject arg=new JSONObject(json);DownloadManager manager=DownloadManager.get(MainActivity.this);Object result;
                    switch(action){
                        case "downloadStart":result=manager.start(arg);break;
                        case "downloadRetry":result=manager.retry(arg.getString("id"));break;
                        case "downloadStatus":result=manager.status(arg.getString("id"));break;
                        case "downloadList":result=manager.list();break;
                        case "downloadCancel":manager.cancel(arg.getString("id"));result=new JSONObject();break;
                        case "downloadDebugCrash":manager.debugCrash(arg.getString("id"));result=new JSONObject();break;
                        case "downloadDebugDiagnostic":result=manager.diagnostic(arg.getString("id"));break;
                        case "downloadSettings":DownloadSettings config=new DownloadSettings(MainActivity.this);result=arg.has("patch")?config.update(arg.getJSONObject("patch")):config.publicConfig();break;
                        default:throw new IOException("未知下载操作");
                    }reply(id,true,result);
                }catch(Throwable e){reply(id,false,message(e));}});return;
            }
            if(action.equals("videoCancel")){try{VideoExport.get(MainActivity.this).cancel(new JSONObject(json).getString("id"));reply(id,true,new JSONObject());}catch(Exception e){reply(id,false,message(e));}return;}
            if(action.startsWith("video")){
                if(action.equals("videoStart")&&android.os.Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=android.content.pm.PackageManager.PERMISSION_GRANTED)runOnUiThread(()->requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},44));
                videoWorker.execute(()->{try{
                    JSONObject arg=new JSONObject(json);VideoExport engine=VideoExport.get(MainActivity.this);Object result;
                    switch(action){
                        case "videoCapabilities":result=engine.capabilities(arg.getString("id"));break;
                        case "videoStatus":result=engine.status(arg.getString("id"));break;
                        case "videoStart":result=engine.start(arg.getString("id"),arg.getJSONObject("options"));break;
                        case "videoFont":result=engine.font(arg.getString("base64"));break;
                        case "videoDebugCrash":engine.debugCrash(arg.getString("id"));result=new JSONObject();break;
                        default:throw new IOException("未知视频操作");
                    }reply(id,true,result);
                }catch(Throwable e){reply(id,false,message(e));}});return;
            }
            if(action.equals("llmCancel")){try{llmClient.cancel(new JSONObject(json).getString("requestId"));reply(id,true,new JSONObject());}catch(Exception e){reply(id,false,message(e));}return;}
            if(action.startsWith("llm")){
                llmWorker.execute(()->{try{
                    JSONObject arg=new JSONObject(json);Object result;
                    switch(action){
                        case "llmConfig":
                            if(arg.optString("method").equals("POST"))llmStore.update(arg.getJSONObject("input"));
                            JSONObject cfg=llmStore.config("");result=llmStore.list().put("cfg",LlmStore.publicConfig(cfg)).put("ready",LlmClient.ready(cfg));break;
                        case "llmSchemes":
                            result=arg.optString("method","GET").equals("GET")?llmStore.list():llmStore.mutate(arg.getString("method"),arg.optString("id"),arg.optBoolean("activate"),arg.optJSONObject("input")==null?new JSONObject():arg.getJSONObject("input"));break;
                        case "llmChat":result=llmClient.chat(arg,false);break;
                        case "llmGlossary":result=llmStore.glossary(arg);break;
                        case "llmTest":result=llmClient.chat(arg,true);break;
                        default:throw new IOException("未知翻译操作");
                    }
                    reply(id,true,result);
                }catch(Exception e){reply(id,false,message(e));}});return;
            }
            if(action.equals("rememberRoute")){try{String route=new JSONObject(json).getString("route");if(route.matches("#/([A-Za-z0-9_/-]*)"))getSharedPreferences("window",MODE_PRIVATE).edit().putString("route",route).apply();reply(id,true,new JSONObject());}catch(Exception e){reply(id,false,message(e));}return;}
            if (busy.get() && !action.equals("status") && !action.startsWith("studio")) { reply(id, false, "任务进行中，请先等待或停止"); return; }
            if(action.equals("close")){runOnUiThread(()->finish());reply(id,true,new JSONObject());return;}
            if(action.equals("uiPickFiles")){
                runOnUiThread(()->{try{
                    if(pickerId!=null||fileChooser!=null||busy.get())throw new IOException("请先完成当前文件选择");
                    JSONObject arg=new JSONObject(json);pickerId=id;inputVideo=arg.optBoolean("video");
                    if(inputVideo){chooseMedia(INPUT_FILES,arg.optBoolean("multiple"),false);return;}
                    Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,arg.optBoolean("multiple"));startActivityForResult(intent,INPUT_FILES);
                }catch(Exception error){if(id.equals(pickerId))pickerId=null;reply(id,false,message(error));}});return;
            }
            if(action.equals("uploadSelected")){
                runOnUiThread(()->{try{JSONObject selection=new JSONObject(json);Uri uri=null;
                    if(importedFiles.containsKey(selection.optString("token"))){reply(id,true,importedFiles.get(selection.optString("token")));return;}
                    if(selection.has("token"))uri=selectedFiles.get(selection.getString("token"));
                    else for(String token:selectedNames.keySet())if(selectedNames.get(token).equals(selection.optString("name"))){Uri candidate=selectedFiles.get(token);if(uri!=null&&!uri.equals(candidate))throw new IOException("媒体名称重复，请重新选择文件");uri=candidate;}
                    if(uri==null)throw new IOException("请重新选择媒体文件");if(pickerId!=null||fileChooser!=null)throw new IOException("请先完成当前文件选择");pickerId=id;onActivityResult(MEDIA,RESULT_OK,new Intent().setData(uri));}catch(Exception e){reply(id,false,message(e));}});return;
            }
            if (action.equals("pickMedia") || action.equals("pickSubtitle") || action.equals("pickModel") || action.equals("pickPack") || action.equals("pickExportDirectory") || action.equals("export")) {
                runOnUiThread(() -> {
                    if (pickerId != null) { reply(id, false, "请先完成当前文件选择"); return; }
                    try {
                        JSONObject arg = new JSONObject(json);
                        if(action.equals("pickModel")&&AsrManager.get(MainActivity.this).active()!=null)throw new IOException("请先停止本机识别或模型下载");
                        if(pickerId!=null||fileChooser!=null)throw new IOException("请先完成当前文件选择");
                        pickerId = id;
                        if(action.equals("pickMedia")){chooseMedia(MEDIA,false,true);return;}
                        Intent intent;
                        int request;
                        if(action.equals("pickExportDirectory")){request=DIRECTORY;intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,DocumentsContract.buildDocumentUri("com.android.externalstorage.documents","primary:Movies"));}
                        else if (action.equals("pickModel")) { request = MODEL; importModelId=VulkanModels.find(arg.optString("modelId",VulkanModels.ALL[0].id)).id; intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE); }
                        else if (action.equals("export")) {
                            request = EXPORT; exportText = arg.optString("text");exportBase64=arg.optString("base64",null);
                            String exportName=arg.optString("name","SubFabric.ass");
                            String exportMime=exportName.matches("(?i).*\\.(ass|ssa|srt)$")?"application/octet-stream":arg.optString("mime","application/octet-stream");
                            intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(exportMime).addCategory(Intent.CATEGORY_OPENABLE);
                            intent.putExtra(Intent.EXTRA_TITLE,exportName);
                        } else {
                            request = action.equals("pickMedia") ? MEDIA : action.equals("pickPack")?PACK:SUBTITLE;
                            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                            if (request == MEDIA) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "audio/*"});
                        }
                        startActivityForResult(intent, request);
                    } catch (Exception e) { if(id.equals(pickerId))pickerId = null; reply(id, false, message(e)); }
                });
                return;
            }
            ExecutorService executor=action.startsWith("studio")&&!action.equals("studioPrepare")?storeWorker:worker;
            executor.execute(() -> {
                try {
                    JSONObject arg = new JSONObject(json);
                    Object result;
                    switch (action) {
                        case "studioExportPack":result=android.util.Base64.encodeToString(StudioPack.export(studio.load(arg.getString("id"))),android.util.Base64.NO_WRAP);break;
                        case "studioPrepare": {
                            String pid=arg.getString("id");busy.set(true);cancelled.set(false);deadline=System.currentTimeMillis()+30*60*1000;progress("正在生成音频与波形",-1);
                            try{AudioTools.prepare(mediaFile(arg.getString("mediaId")),studio.file(pid,".audio.wav"),studio.file(pid,".peaks.bin"),()->cancelled.get()||destroyed||System.currentTimeMillis()>deadline);
                                JSONObject patch=new JSONObject().put("hasAudio",true).put("hasPeaks",true).put("prepare",new JSONObject().put("status","done"));result=studio.call("studioUpdate",new JSONObject().put("id",pid).put("patch",patch));
                            }finally{busy.set(false);}break;
                        }
                        case "studioList": case "studioLoad": case "studioOpStats": case "studioCreate": case "studioUpdate": case "studioApplyAsr": case "studioApplyAlignment": case "studioDelete": result=studio.call(action,arg);break;
                        case "status": result = new JSONObject().put("modelReady", AsrManager.modelStatus(MainActivity.this).optBoolean("ready")).put("engine", "Vulkan · CPU 回退已禁用").put("abi", android.os.Build.SUPPORTED_ABIS[0]).put("version", "0.12.2"); break;
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
                        case "recognize": throw new IOException("旧 CPU 识别入口已停用，请从新建初稿选择 Vulkan 模型");
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
    private void checkCancelled() throws IOException { if(cancelled.get() || destroyed || Thread.currentThread().isInterrupted()) throw new IOException("任务已停止；原字幕保留"); }

    private JSONObject importPickedMedia(Uri uri,String name) throws Exception {
        String mediaId=UUID.randomUUID().toString();File target=mediaFile(mediaId);
        try(InputStream input=getContentResolver().openInputStream(uri);OutputStream output=new FileOutputStream(target)){copy(input,output,2L*1024*1024*1024,"正在导入媒体");}catch(Throwable error){target.delete();throw error;}
        JSONObject result=new JSONObject().put("id",mediaId).put("title",name).put("mime",getContentResolver().getType(uri)).put("media",true).put("cues",new JSONArray()).put("updated",System.currentTimeMillis());writeProject(result);return result;
    }

    private void completeWebChooser(Uri[] uris){
        ValueCallback<Uri[]> callback=fileChooser;boolean mediaSelection=fileChooserMedia;fileChooser=null;fileChooserMedia=false;
        if(callback!=null)callback.onReceiveValue(uris);
        if(mediaSelection&&(uris==null||uris.length==0))emit("media-picker-cancel",new JSONObject());
    }
    private void pickerCancel(int request){if(request==14)completeWebChooser(null);else{String id=pickerId;pickerId=null;if(id!=null)reply(id,true,JSONObject.NULL);}}
    private void pickerError(int request,Exception error){if(request==14){completeWebChooser(null);android.widget.Toast.makeText(this,message(error),android.widget.Toast.LENGTH_LONG).show();}else{String id=pickerId;pickerId=null;if(id!=null)reply(id,false,message(error));}}
    private void chooseMedia(int request,boolean multiple,boolean audio){
        MediaPicker.show(this,multiple,audio,new MediaPicker.Selection(){
            public void choose(Intent intent){startActivityForResult(intent,request);}
            public void cancel(){pickerCancel(request);}
            public void error(Exception error){pickerError(request,error);}
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        if(request==INPUT_FILES){
            final String id=pickerId;pickerId=null;final boolean video=inputVideo;inputVideo=false;
            if(id==null)return;final Uri[] uris=MediaPicker.result(result,data);if(uris==null||uris.length==0){reply(id,true,JSONObject.NULL);return;}
            busy.set(true);cancelled.set(false);deadline=System.currentTimeMillis()+15*60*1000;
            worker.execute(()->{try{
                JSONArray files=new JSONArray();for(Uri uri:uris){
                    String name="导入的文件";long size=0;try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE},null,null,null)){if(cursor!=null&&cursor.moveToFirst()){name=cursor.getString(0);size=cursor.getLong(1);}}
                    JSONObject file=new JSONObject().put("name",name).put("size",size).put("type",getContentResolver().getType(uri));
                    if(video){String token=UUID.randomUUID().toString();JSONObject imported=importPickedMedia(uri,name);selectedFiles.put(token,uri);selectedNames.put(token,name);importedFiles.put(token,imported);file.put("token",token).put("mediaId",imported.getString("id")).put("size",mediaFile(imported.getString("id")).length());}
                    else{ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream input=getContentResolver().openInputStream(uri)){copy(input,bytes,32L*1024*1024,"正在读取文件");}file.put("base64",android.util.Base64.encodeToString(bytes.toByteArray(),android.util.Base64.NO_WRAP));}
                    files.put(file);
                }reply(id,true,files);
            }catch(Throwable error){reply(id,false,message(error));}finally{busy.set(false);}});return;
        }
        if(request==14){
            if(fileChooser==null)return;Uri[] uris=MediaPicker.result(result,data);
            try{
                if(fileChooserMedia&&uris!=null&&uris.length>0){JSONArray files=new JSONArray();
                    for(Uri uri:uris){String name=uri.getLastPathSegment();try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
                        if(name==null||name.isEmpty())name="导入的媒体";String token=UUID.randomUUID().toString();selectedFiles.put(token,uri);selectedNames.put(token,name);files.put(new JSONObject().put("token",token));}
                    emit("media-selection",new JSONObject().put("files",files));
                }
                completeWebChooser(uris);
            }catch(Exception error){pickerError(14,error);}return;
        }
        String id = pickerId; pickerId = null;
        if (id == null) return;
        if (result != RESULT_OK || data == null || data.getData() == null) { reply(id,true,JSONObject.NULL); return; }
        Uri uri = data.getData();
        String output = exportText; exportText = null;
        String bytes64=exportBase64;exportBase64=null;
        busy.set(true); cancelled.set(false); deadline=System.currentTimeMillis()+15*60*1000;
        worker.execute(() -> {
            try {
                Object response;
                if(request==DIRECTORY){
                    int flags=data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);getContentResolver().takePersistableUriPermission(uri,flags);
                    SafDirectory directory=new SafDirectory(MainActivity.this,uri.toString());String name=directory.name();getSharedPreferences("export",MODE_PRIVATE).edit().putString("tree",uri.toString()).putString("name",name).commit();response=new JSONObject().put("path",name);
                } else if (request == MEDIA) {
                    String projectId = UUID.randomUUID().toString(); File target=mediaFile(projectId);
                    String name = "导入的媒体";
                    try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) { if(cursor!=null && cursor.moveToFirst()) name=cursor.getString(0); }
                    try(InputStream input=getContentResolver().openInputStream(uri); OutputStream out=new FileOutputStream(target)) {
                        copy(input,out,2L*1024*1024*1024,"正在导入媒体");
                    } catch(Throwable e) { target.delete(); throw e; }
                    JSONObject p=new JSONObject().put("id",projectId).put("title",name).put("mime",getContentResolver().getType(uri)).put("media",true).put("cues",new JSONArray()).put("updated",System.currentTimeMillis());
                    writeProject(p); response=p;
                } else if(request==PACK) {
                    try(InputStream input=getContentResolver().openInputStream(uri)){response=StudioPack.read(input,studio);}
                } else if(request==SUBTITLE) {
                    ByteArrayOutputStream out=new ByteArrayOutputStream();
                    try(InputStream input=getContentResolver().openInputStream(uri)) { copy(input,out,8*1024*1024,"正在导入字幕"); }
                    String name="subtitle.ass";
                    try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
                    byte[] bytes=out.toByteArray();String text;
                    if(bytes.length>=2&&(bytes[0]&255)==255&&(bytes[1]&255)==254)text=new String(bytes,2,bytes.length-2,java.nio.charset.StandardCharsets.UTF_16LE);
                    else if(bytes.length>=2&&(bytes[0]&255)==254&&(bytes[1]&255)==255)text=new String(bytes,2,bytes.length-2,java.nio.charset.StandardCharsets.UTF_16BE);
                    else {try{text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();}catch(java.nio.charset.CharacterCodingException e){text=new String(bytes,java.nio.charset.Charset.forName("GB18030"));}}
                    response=new JSONObject().put("text",text).put("name",name);
                } else if(request==MODEL) {
                    if(AsrManager.get(MainActivity.this).active()!=null)throw new IOException("请先停止本机识别或模型下载");
                    VulkanModels.Spec spec=VulkanModels.find(importModelId);File target=spec.path(MainActivity.this);target.getParentFile().mkdirs();File part=new File(target.getPath()+".part");
                    try {
                        try(InputStream input=getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(part)){copy(input,out,spec.bytes,"正在导入 "+spec.name);out.getFD().sync();}
                        VulkanModels.verify(part,spec);Files.move(part.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
                    } finally {part.delete();}
                    response=AsrManager.modelStatus(MainActivity.this);
                } else {
                    try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")) { out.write(bytes64==null?output.getBytes(StandardCharsets.UTF_8):android.util.Base64.decode(bytes64,android.util.Base64.DEFAULT)); }
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

    @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); }
    @Override protected void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);String url=web.getUrl();if(url!=null&&url.contains("#"))state.putString("route",url.substring(url.indexOf('#')));}
    @Override public void onBackPressed(){if(nativeStudio!=null&&nativeStudio.back())return;if(web!=null)web.evaluateJavascript("window.androidBack?window.androidBack():history.back()",null);else super.onBackPressed();}
    @Override protected void onDestroy() { destroyed=true;if(nativeStudio!=null)nativeStudio.close();if(fileChooser!=null)completeWebChooser(null); cancelled.set(true); handler.removeCallbacks(watchdog); worker.shutdownNow();llmClient.close();llmWorker.shutdownNow();videoWorker.shutdownNow();downloadWorker.shutdownNow();storeWorker.shutdownNow(); if(web!=null) {web.removeJavascriptInterface("SubFabric"); web.destroy();} super.onDestroy(); }
}
