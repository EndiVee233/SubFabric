package com.subfabric.android;

import android.content.Context;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.json.*;

final class DownloadSettings {
    private final File file;
    private final LlmStore secrets;
    DownloadSettings(Context context){file=new File(context.getFilesDir(),"download-settings.json");secrets=new LlmStore(context);}
    synchronized JSONObject read() throws Exception {return file.isFile()?new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)):new JSONObject();}
    String secret(JSONObject config,String field) throws Exception {String cipher=config.optString(field);if(cipher.isEmpty())return "";try{return secrets.unseal(cipher);}catch(Exception e){throw new IOException("已存登录信息无法解密，请重新导入");}}
    String seal(String value) throws Exception {return secrets.seal(value);}
    String unseal(String value) throws Exception {return secrets.unseal(value);}
    static boolean quality(String value){return value.matches("best|2160|1440|1080|720|480|360|audio|worst");}
    synchronized JSONObject update(JSONObject patch) throws Exception {
        JSONObject settings=read();
        if(patch.has("quality")){String quality=patch.getString("quality");if(!quality(quality))throw new IOException("画质档位无效");settings.put("quality",quality);}
        if(patch.has("proxy")){
            String proxy=patch.getString("proxy").trim();if(proxy.length()>2048)throw new IOException("代理地址过长");
            if(!proxy.isEmpty()){URI uri=new URI(proxy);if(uri.getHost()==null||uri.getUserInfo()!=null||uri.getRawFragment()!=null||!String.valueOf(uri.getScheme()).matches("https?|socks5h?"))throw new IOException("代理地址需为不含账号密码的 HTTP/HTTPS/SOCKS5 地址");}
            settings.put("proxy",proxy);
        }
        if(!patch.optString("cookiesFromBrowser").isEmpty())throw new IOException("安卓请导入 Cookie 文件或粘贴登录信息");
        for(String[] field:new String[][]{{"biliCookie","biliEnc"},{"youtubeCookies","youtubeEnc"}})if(patch.has(field[0])){
            String text=patch.getString(field[0]);if(text.getBytes(StandardCharsets.UTF_8).length>256*1024)throw new IOException("Cookie 文件超过 256KB 上限");
            if(field[0].equals("youtubeCookies")&&!text.trim().isEmpty()&&!text.contains("Netscape HTTP Cookie File"))throw new IOException("请选择 Netscape 格式的 YouTube cookies.txt");
            settings.put(field[1],text.trim().isEmpty()?"":secrets.seal(text));
        }
        File tmp=new File(file.getPath()+".tmp");try(FileOutputStream out=new FileOutputStream(tmp)){out.write(settings.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);return publicConfig();
    }
    synchronized JSONObject publicConfig() throws Exception {
        JSONObject settings=read();boolean bili=!settings.optString("biliEnc").isEmpty(),youtube=!settings.optString("youtubeEnc").isEmpty();
        return new JSONObject().put("ready",true).put("quality",settings.optString("quality","best")).put("proxy",settings.optString("proxy")).put("cookiesFromBrowser","")
            .put("hasBiliCookie",bili).put("biliCookieEnc",bili).put("biliCookieKeys",bili?new JSONArray().put("SESSDATA"):new JSONArray()).put("cookieBackend","android-keystore").put("hasYoutubeCookies",youtube);
    }
}
