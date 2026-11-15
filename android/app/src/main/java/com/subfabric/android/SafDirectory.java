package com.subfabric.android;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.util.*;
import org.json.*;

/** Only directories explicitly granted by the system picker; no filesystem path from WebView. */
final class SafDirectory {
    final Context context;
    final Uri tree;
    final ContentResolver resolver;
    SafDirectory(Context context,String value) throws Exception {
        this.context=context;resolver=context.getContentResolver();tree=Uri.parse(value);
        boolean granted=false;for(UriPermission p:resolver.getPersistedUriPermissions())if(p.getUri().equals(tree)&&p.isWritePermission())granted=true;
        if(!granted||!DocumentsContract.isTreeUri(tree))throw new IOException("请重新选择安卓导出文件夹");
    }
    Uri root(){return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));}
    String name() throws Exception {try(Cursor c=resolver.query(root(),new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())return c.getString(0);}throw new IOException("导出目录不可读取");}
    Map<String,Uri> children() throws Exception {
        Map<String,Uri> files=new HashMap<>();Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));
        try(Cursor c=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){
            if(c==null)throw new IOException("导出目录不可读取");while(c.moveToNext()){if(files.containsKey(c.getString(1)))throw new IOException("导出目录存在重复名称，请选择其它文件夹");files.put(c.getString(1),DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0)));}
        }return files;
    }
    long flags(Uri uri) throws Exception {try(Cursor c=resolver.query(uri,new String[]{DocumentsContract.Document.COLUMN_FLAGS},null,null,null)){if(c!=null&&c.moveToFirst())return c.getLong(0);}return 0;}
    String documentName(Uri uri) throws Exception {try(Cursor c=resolver.query(uri,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)){if(c!=null&&c.moveToFirst()){if(DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)))throw new IOException("同名项目是文件夹，不能覆盖");return c.getString(0);}}throw new IOException("导出文件不可读取");}
    interface Check {void run() throws Exception;}
    JSONObject publish(File source,String name,String mime,boolean overwrite,Check check) throws Exception {
        Map<String,Uri> existing=children();Uri old=existing.get(name),temp=null,backup=null;
        if(old!=null&&!overwrite)throw new IOException("导出目录已有同名文件："+name);
        if(old!=null)documentName(old);
        if(old!=null&&(flags(old)&DocumentsContract.Document.FLAG_SUPPORTS_RENAME)==0)throw new IOException("此目录不支持安全覆盖，请改用新的文件名或文件夹");
        String token=UUID.randomUUID().toString(),suffix=name.contains(".")?name.substring(name.lastIndexOf('.')):"";
        try{
            check.run();temp=DocumentsContract.createDocument(resolver,root(),mime,"SubFabric-part-"+token+suffix);
            if(temp==null)throw new IOException("无法创建导出文件");
            if((flags(temp)&DocumentsContract.Document.FLAG_SUPPORTS_RENAME)==0)throw new IOException("此文件夹不支持完成后改名，请选择本机文档文件夹");
            long copied=0;
            try(InputStream in=new FileInputStream(source);OutputStream out=resolver.openOutputStream(temp,"wt")){
                if(out==null)throw new IOException("无法写入导出文件");byte[] buffer=new byte[131072];int n;
                while((n=in.read(buffer))!=-1){check.run();out.write(buffer,0,n);copied+=n;}out.flush();
            }
            if(copied!=source.length())throw new IOException("导出写入不完整");check.run();
            // Recheck immediately before publishing. Concurrent new files are never silently replaced.
            Uri latest=children().get(name);if(!Objects.equals(latest,old))throw new IOException("导出目录同名文件已变化，请重试");
            if(old!=null){backup=DocumentsContract.renameDocument(resolver,old,"SubFabric-backup-"+token+suffix);if(backup==null)throw new IOException("无法保留旧文件，已停止覆盖");}
            Uri output=DocumentsContract.renameDocument(resolver,temp,name);if(output==null)throw new IOException("导出文件改名失败");temp=output;
            if(!documentName(output).equals(name))throw new IOException("导出目录出现同名文件，未覆盖并发内容");temp=null;
            JSONObject result=new JSONObject().put("path",name).put("uri",output.toString()).put("bytes",copied);
            if(backup!=null){try{if(!DocumentsContract.deleteDocument(resolver,backup))result.put("warning","旧文件备份仍在导出目录中");}catch(Exception e){result.put("warning","旧文件备份仍在导出目录中");}backup=null;}
            return result;
        }finally{
            boolean cleanupFailed=false;
            if(temp!=null)try{if(!DocumentsContract.deleteDocument(resolver,temp))cleanupFailed=true;}catch(Exception e){cleanupFailed=true;}
            if(backup!=null)try{Uri restored=DocumentsContract.renameDocument(resolver,backup,name);if(restored==null||!documentName(restored).equals(name))cleanupFailed=true;}catch(Exception e){cleanupFailed=true;}
            if(cleanupFailed)throw new IOException("导出未完成，请检查目录中的临时文件或旧文件备份");
        }
    }
}
