package com.subfabric.android;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Native HTTP transport: WebView never receives credentials or remote navigation access. */
final class LlmClient {
    private final LlmStore store;
    private final ConcurrentHashMap<String,Call> active=new ConcurrentHashMap<>();
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();
    private final Semaphore slots=new Semaphore(2);
    private volatile boolean closed;
    private static final class Call {volatile HttpURLConnection connection;final AtomicBoolean cancelled=new AtomicBoolean();void cancel(){cancelled.set(true);HttpURLConnection c=connection;if(c!=null)c.disconnect();}}
    LlmClient(LlmStore store){this.store=store;}
    static URL endpoint(JSONObject cfg) throws Exception {
        URI uri;
        try{uri=new URI(cfg.optString("baseUrl").trim());}catch(Exception e){throw new IOException("请填写有效的 API 接口地址");}
        String scheme=uri.getScheme(),host=uri.getHost();
        if(host==null||uri.getUserInfo()!=null||uri.getFragment()!=null||(!"http".equals(scheme)&&!"https".equals(scheme)))throw new IOException("API 地址只支持 HTTP/HTTPS，凭证请填入 API Key");
        // Plain HTTP is explicitly limited to local engines / development loopback, never a public endpoint.
        if("http".equals(scheme)&&!localHost(host))throw new IOException("公网 API 地址必须使用 HTTPS；HTTP 仅支持本机或局域网地址");
        String path=uri.getPath()==null?"":uri.getPath().replaceAll("/+$","");
        if(cfg.optString("provider").equals("anthropic")){if(!path.endsWith("/messages"))path+=(path.endsWith("/v1")?"/messages":"/v1/messages");}
        else if(!path.endsWith("/chat/completions"))path+="/chat/completions";
        return new URI(scheme,null,host,uri.getPort(),path,uri.getQuery(),null).toURL();
    }
    private static boolean localHost(String host){
        if(host.equals("localhost")||host.equals("[::1]")||host.equals("::1"))return true;
        if(!host.matches("\\d{1,3}(\\.\\d{1,3}){3}"))return false;
        try{InetAddress a=InetAddress.getByName(host);return a.isLoopbackAddress()||a.isSiteLocalAddress();}catch(Exception e){return false;}
    }
    static boolean ready(JSONObject cfg){return !cfg.optString("baseUrl").isEmpty()&&!cfg.optString("model").isEmpty()&&(!cfg.optString("apiKeyEnc").isEmpty()||isLocal(cfg));}
    private static boolean isLocal(JSONObject cfg){try{return localHost(new URI(cfg.optString("baseUrl")).getHost());}catch(Exception e){return false;}}
    void cancel(String id){Call call=active.get(id);if(call!=null)call.cancel();}
    void close(){closed=true;for(Call call:active.values())call.cancel();timer.shutdownNow();}
    JSONObject chat(JSONObject arg,boolean test) throws Exception {
        JSONObject cfg=test&&arg.has("config")?store.temporary(arg.getJSONObject("config")):store.config(arg.optString("schemeId"));
        if(!ready(cfg))throw new IOException("还没配置翻译：先在设置里填写接口、模型与 API Key");
        String requestId=arg.optString("requestId");if(!requestId.matches("[A-Za-z0-9_-]{1,80}"))throw new IOException("无效的请求 ID");
        if(closed||!slots.tryAcquire())throw new IOException("翻译请求进行中，请稍后重试");
        Call call=new Call();if(active.putIfAbsent(requestId,call)!=null){slots.release();throw new IOException("请求 ID 已在使用");}
        ScheduledFuture<?> timeout=null;String secret="";
        try{
            timeout=timer.schedule(call::cancel,120,TimeUnit.SECONDS);
            URL url=endpoint(cfg);secret=store.decrypt(cfg);
            JSONArray input=test?new JSONArray().put(new JSONObject().put("role","user").put("content","只回复一个单词：ok")):arg.getJSONArray("messages");
            if(input.length()<1||input.length()>8||input.toString().length()>200000)throw new IOException("翻译请求内容过大");
            boolean anthropic=cfg.optString("provider").equals("anthropic");JSONArray messages=new JSONArray();StringBuilder system=new StringBuilder();
            for(int i=0;i<input.length();i++){
                JSONObject m=input.getJSONObject(i);String role=m.getString("role"),content=m.getString("content");
                if(!role.matches("system|user|assistant"))throw new IOException("消息角色无效");
                if(anthropic&&role.equals("system")){system.append(content).append("\n\n");}else messages.put(new JSONObject().put("role",role).put("content",content));
            }
            JSONObject body=new JSONObject().put("model",cfg.getString("model")).put("messages",messages).put("max_tokens",Math.max(256,Math.min(16384,arg.optInt("maxTokens",4096))));
            if(anthropic){if(system.length()>0)body.put("system",system.toString());}else body.put("temperature",cfg.optDouble("temperature",.3));
            HttpURLConnection conn=(HttpURLConnection)url.openConnection();call.connection=conn;
            conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(15000);conn.setReadTimeout(120000);conn.setRequestMethod("POST");conn.setDoOutput(true);conn.setRequestProperty("Content-Type","application/json");conn.setRequestProperty("Accept","application/json");
            if(anthropic){conn.setRequestProperty("anthropic-version","2023-06-01");if(!secret.isEmpty())conn.setRequestProperty("x-api-key",secret);}
            else if(!secret.isEmpty())conn.setRequestProperty("Authorization","Bearer "+secret);
            if(call.cancelled.get()||closed)throw new IOException("翻译已停止或请求超时");
            byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);conn.setFixedLengthStreamingMode(bytes.length);
            try(OutputStream out=conn.getOutputStream()){out.write(bytes);}
            int status=conn.getResponseCode();
            if(status>=300&&status<400)throw new IOException("API 返回重定向；请填写最终接口地址");
            // Avoid returning provider error bodies: gateways may echo an Authorization header or prompt.
            if(status<200||status>=300)throw new IOException("翻译接口 HTTP "+status+"；请检查配置或稍后重试");
            ByteArrayOutputStream data=new ByteArrayOutputStream();
            try(InputStream in=conn.getInputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(call.cancelled.get()||closed)throw new IOException("翻译已停止或请求超时");if(data.size()+n>2*1024*1024)throw new IOException("翻译响应超过上限");data.write(buffer,0,n);}}
            JSONObject result=new JSONObject(new String(data.toByteArray(),StandardCharsets.UTF_8));String content="",finish="";
            if(anthropic){JSONArray blocks=result.optJSONArray("content");if(blocks!=null)for(int i=0;i<blocks.length();i++){JSONObject block=blocks.getJSONObject(i);if(block.optString("type").equals("text"))content+=block.optString("text");}finish=result.optString("stop_reason");}
            else {JSONObject choice=result.getJSONArray("choices").getJSONObject(0);content=choice.getJSONObject("message").optString("content");finish=choice.optString("finish_reason");}
            if(finish.equals("length")||finish.equals("max_tokens"))throw new IOException("输出被截断，请减小每批行数后重试");
            if(content.trim().isEmpty())throw new IOException("接口返回内容为空");
            // Do not propagate an accidentally echoed credential through a successful provider response either.
            if(!secret.isEmpty())content=content.replace(secret,"[redacted]");
            return new JSONObject().put("content",content).put("finishReason",finish).put("ok",true);
        }catch(Exception e){
            if(call.cancelled.get()||closed)throw new IOException("翻译已停止或请求超时");
            String message=e.getMessage();
            if(e instanceof IOException&&message!=null&&!message.contains("://")&&!message.contains("\n"))throw new IOException(secret.isEmpty()?message:message.replace(secret,"[redacted]"));
            throw new IOException("连接失败，请检查接口地址、Key、模型和网络");
        }finally{if(timeout!=null)timeout.cancel(false);call.cancel();active.remove(requestId);slots.release();}
    }
}
