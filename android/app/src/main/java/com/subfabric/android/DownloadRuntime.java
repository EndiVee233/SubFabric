package com.subfabric.android;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.zip.*;
import org.json.*;
import com.chaquo.python.*;
import com.chaquo.python.android.AndroidPlatform;

/** Versioned, APK-owned Python support. Never unpacks user archives or changes global Python installations. */
public final class DownloadRuntime {
    private final Context context;
    private PyObject module;
    DownloadRuntime(Context context){this.context=context;}
    public interface Callback {boolean isCancelled();void onProgress(long bytes,long total,double pct,String stage);}
    private String asset(String name) throws Exception {try(InputStream in=context.getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];for(int n;(n=in.read(b))!=-1;)out.write(b,0,n);return out.toString("UTF-8");}}
    private void copyAssets(String source,File target) throws Exception {
        String[] names=context.getAssets().list(source);if(names!=null&&names.length>0){target.mkdirs();for(String name:names)copyAssets(source+"/"+name,new File(target,name));}
        else {target.getParentFile().mkdirs();try(InputStream in=context.getAssets().open(source)){Files.copy(in,target.toPath(),StandardCopyOption.REPLACE_EXISTING);}}
    }
    private void unpack(String name,File destination) throws Exception {
        int entries=0;long total=0;String prefix=destination.getCanonicalPath()+File.separator;
        try(ZipInputStream in=new ZipInputStream(context.getAssets().open("download/"+name))){ZipEntry entry;byte[] buffer=new byte[65536];
            while((entry=in.getNextEntry())!=null){if(++entries>30000)throw new IOException("下载组件归档条目过多");String path=entry.getName();
                if(path.startsWith("/")||path.contains("\\")||path.contains(":")||path.matches("(^|.*/)\\.\\.(/.*|$)"))throw new IOException("下载组件归档路径无效");
                File file=new File(destination,path);if(!file.getCanonicalPath().startsWith(prefix))throw new IOException("下载组件路径越界");
                if(entry.isDirectory()){file.mkdirs();continue;}file.getParentFile().mkdirs();
                try(OutputStream out=new FileOutputStream(file)){int n;while((n=in.read(buffer))!=-1){total+=n;if(total>150*1024*1024)throw new IOException("下载组件解压超过上限");out.write(buffer,0,n);}}
            }
        }
    }
    private synchronized void init() throws Exception {
        if(module!=null)return;JSONObject manifest=new JSONObject(asset("download/runtime.json"));String id=manifest.getString("id");if(!id.matches("[a-f0-9]{64}"))throw new IOException("下载组件版本无效");
        File root=new File(context.getFilesDir(),"download-runtime/"+id),complete=new File(root,"complete");
        if(!complete.isFile()){root.mkdirs();JSONArray wheels=manifest.getJSONArray("wheels");for(int i=0;i<wheels.length();i++)unpack(wheels.getString(i),root);copyAssets("download/python",root);Files.write(complete.toPath(),new byte[]{1});}
        if(!Python.isStarted())Python.start(new AndroidPlatform(context));
        Python python=Python.getInstance();python.getModule("sys").get("path").callAttr("insert",0,root.getPath());module=python.getModule("sf_download");
    }
    String quickjs(){return new File(context.getApplicationInfo().nativeLibraryDir,"libqjs.so").getPath();}
    JSONObject info() throws Exception {init();return new JSONObject(module.callAttr("runtime_info",quickjs()).toString());}
    JSONObject run(JSONObject request,File folder,String bili,String youtube,Callback callback) throws Exception {init();return new JSONObject(module.callAttr("run",request.toString(),folder.getPath(),quickjs(),bili,youtube,callback).toString());}
}
