package com.subfabric.android;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Private atomic settings. Only ciphertext leaves AndroidKeyStore; keys never return to WebView. */
final class LlmStore {
    private final File file;
    private static final String ALIAS="subfabric.llm.v1";
    private static final String[] FIELDS={"provider","baseUrl","model","prompt","glossary","glossaryLang","autoTranslate","batchSize","temperature","contextRows"};
    LlmStore(Context context){file=new File(context.getFilesDir(),"llm-settings.json");}
    private JSONObject read() throws Exception {return file.exists()?new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)):new JSONObject();}
    private void save(JSONObject settings) throws Exception {
        File tmp=new File(file.getPath()+".tmp");
        try(FileOutputStream out=new FileOutputStream(tmp)){out.write(settings.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
    }
    private static synchronized javax.crypto.SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
        if(!ks.containsAlias(ALIAS)){
            KeyGenerator gen=KeyGenerator.getInstance("AES","AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            gen.generateKey();
        }
        return (javax.crypto.SecretKey)ks.getKey(ALIAS,null);
    }
    private String encrypt(String text) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
        return Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(text.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
    }
    String seal(String text) throws Exception {return encrypt(text);}
    String unseal(String text) throws Exception {return decrypt(new JSONObject().put("apiKeyEnc",text));}
    String decrypt(JSONObject cfg) throws Exception {
        String enc=cfg.optString("apiKeyEnc");if(enc.isEmpty())return "";
        try{String[] p=enc.split(":");Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);}
        catch(Exception e){throw new IOException("已存 Key 无法解密，请重新填写");}
    }
    static JSONObject publicConfig(JSONObject raw) throws Exception {
        JSONObject out=new JSONObject();for(String field:FIELDS)if(raw.has(field))out.put(field,raw.get(field));
        out.put("hasKey",!raw.optString("apiKeyEnc").isEmpty());return out;
    }
    private JSONObject patch(JSONObject previous,JSONObject input) throws Exception {
        JSONObject cfg=new JSONObject(previous.toString());
        for(String field:FIELDS)if(input.has(field))cfg.put(field,input.get(field));
        for(String field:new String[]{"provider","baseUrl","model","prompt","glossary","glossaryLang"}){
            if(cfg.has(field)&&!(cfg.get(field) instanceof String))throw new IOException("配置字段格式无效");
        }
        String provider=cfg.optString("provider","custom");
        if(provider.equals("nllb-local"))throw new IOException("本地 NLLB 尚未适配安卓");
        LlmClient.endpoint(cfg);
        if(cfg.optString("model").trim().isEmpty())throw new IOException("请填写模型名称");
        if(cfg.optString("prompt").length()>32000||cfg.optString("glossary").length()>100000)throw new IOException("术语表或提示词过长");
        cfg.put("batchSize",Math.max(5,Math.min(100,cfg.optInt("batchSize",25))));
        cfg.put("contextRows",Math.max(0,Math.min(200,cfg.optInt("contextRows",0))));
        double temperature=cfg.optDouble("temperature",.3);cfg.put("temperature",Double.isFinite(temperature)?Math.max(0,Math.min(2,temperature)):.3);
        cfg.put("provider",provider).put("autoTranslate",cfg.optBoolean("autoTranslate",true));
        if(input.optBoolean("apiKeyClear"))cfg.remove("apiKeyEnc");
        String secret=input.optString("apiKey").trim();
        if(secret.length()>8192)throw new IOException("API Key 过长");
        if(!secret.isEmpty())cfg.put("apiKeyEnc",encrypt(secret));
        cfg.remove("apiKey");return cfg;
    }
    private JSONObject find(JSONObject settings,String id) throws Exception {
        JSONArray schemes=settings.optJSONArray("schemes");
        if(schemes!=null)for(int i=0;i<schemes.length();i++)if(schemes.getJSONObject(i).optString("id").equals(id))return schemes.getJSONObject(i);
        throw new IOException("方案不存在");
    }
    synchronized JSONObject config(String id) throws Exception {
        JSONObject s=read(),cfg=id.isEmpty()?s.optJSONObject("current"):find(s,id);
        return cfg==null?new JSONObject():new JSONObject(cfg.toString());
    }
    synchronized JSONObject temporary(JSONObject input) throws Exception {
        JSONObject prev=input.optString("id").isEmpty()?new JSONObject():find(read(),input.getString("id"));
        return patch(prev,input);
    }
    synchronized JSONObject list() throws Exception {
        JSONObject s=read();JSONArray out=new JSONArray(),items=s.optJSONArray("schemes");
        if(items!=null)for(int i=0;i<items.length();i++){JSONObject item=items.getJSONObject(i);out.put(publicConfig(item).put("id",item.getString("id")).put("name",item.getString("name")));}
        return new JSONObject().put("schemes",out).put("activeSchemeId",s.optString("activeSchemeId"));
    }
    synchronized JSONObject mutate(String method,String id,boolean activate,JSONObject input) throws Exception {
        if(!method.matches("POST|PUT|DELETE")||((method.equals("PUT")||method.equals("DELETE")||activate)&&id.isEmpty()))throw new IOException("方案操作无效");
        JSONObject s=read();JSONArray items=s.optJSONArray("schemes");if(items==null)items=new JSONArray();
        JSONObject previous=id.isEmpty()?new JSONObject():find(s,id);
        if(activate){s.put("current",new JSONObject(previous.toString())).put("activeSchemeId",id);save(s);return list();}
        if(method.equals("DELETE")){
            JSONArray keep=new JSONArray();for(int i=0;i<items.length();i++)if(!items.getJSONObject(i).getString("id").equals(id))keep.put(items.getJSONObject(i));s.put("schemes",keep);
            if(s.optString("activeSchemeId").equals(id))s.put("activeSchemeId","").remove("current");save(s);return list();
        }
        if(id.isEmpty()&&items.length()>=100)throw new IOException("最多保存 100 个方案");
        String name=input.optString("name",previous.optString("name")).trim();if(name.isEmpty()||name.length()>80)throw new IOException("请填写 1–80 字的方案名称");
        for(int i=0;i<items.length();i++){JSONObject other=items.getJSONObject(i);if(other.getString("name").equals(name)&&!other.getString("id").equals(id))throw new IOException("已存在同名方案");}
        JSONObject item=patch(previous,input).put("id",id.isEmpty()?UUID.randomUUID().toString():id).put("name",name);
        if(id.isEmpty())items.put(item);else for(int i=0;i<items.length();i++)if(items.getJSONObject(i).getString("id").equals(id))items.put(i,item);
        s.put("schemes",items);if(input.optBoolean("activate")||s.optString("activeSchemeId").equals(item.getString("id")))s.put("current",new JSONObject(item.toString())).put("activeSchemeId",item.getString("id"));
        save(s);return list().put("savedId",item.getString("id"));
    }
    synchronized JSONObject update(JSONObject input) throws Exception {
        JSONObject s=read(),cfg=patch(s.optJSONObject("current")==null?new JSONObject():s.getJSONObject("current"),input);
        s.put("current",cfg).put("activeSchemeId","");save(s);return publicConfig(cfg);
    }
}
