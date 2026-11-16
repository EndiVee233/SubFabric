package com.subfabric.android;

import android.content.*;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import java.io.*;
import org.json.JSONObject;

/** Publishes only this export's new video. Existing gallery items are never replaced. */
final class GalleryVideo {
    static final String NAME="相册 / SubFabric";
    static boolean available(){return Build.VERSION.SDK_INT>=29;}
    static JSONObject publish(Context context,File source,String name,SafDirectory.Check check) throws Exception {
        if(!available())throw new IOException("当前安卓版本请使用系统文件夹导出视频");
        if(!source.isFile()||source.length()==0)throw new IOException("导出视频为空，未写入相册");
        ContentValues values=new ContentValues();MediaMetadataRetriever metadata=new MediaMetadataRetriever();
        try{
            metadata.setDataSource(source.getPath());
            if(!"yes".equals(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO)))throw new IOException("文件没有视频轨，未写入相册");
            String mime=metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE);
            if(mime==null||!mime.startsWith("video/"))throw new IOException("无法确认视频格式，未写入相册");
            values.put(MediaStore.Video.Media.MIME_TYPE,mime);
            for(int[] field:new int[][]{{MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH,0},{MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT,1},{MediaMetadataRetriever.METADATA_KEY_DURATION,2}}){
                String value=metadata.extractMetadata(field[0]);if(value!=null)values.put(new String[]{MediaStore.Video.Media.WIDTH,MediaStore.Video.Media.HEIGHT,MediaStore.Video.Media.DURATION}[field[1]],Long.parseLong(value));
            }
        }finally{metadata.release();}
        values.put(MediaStore.Video.Media.DISPLAY_NAME,name);values.put(MediaStore.Video.Media.RELATIVE_PATH,"Movies/SubFabric/");values.put(MediaStore.Video.Media.IS_PENDING,1);
        ContentResolver resolver=context.getContentResolver();Uri created=null;boolean published=false;
        try{
            check.run();created=resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),values);
            if(created==null)throw new IOException("无法创建相册视频");long copied=0;
            try(InputStream in=new FileInputStream(source);OutputStream out=resolver.openOutputStream(created,"w")){
                if(out==null)throw new IOException("无法写入相册视频");byte[] buffer=new byte[131072];int count;
                while((count=in.read(buffer))!=-1){check.run();out.write(buffer,0,count);copied+=count;}out.flush();
            }
            if(copied!=source.length())throw new IOException("相册视频写入不完整");check.run();
            ContentValues ready=new ContentValues();ready.put(MediaStore.Video.Media.IS_PENDING,0);
            if(resolver.update(created,ready,null,null)!=1)throw new IOException("相册视频发布失败");
            try(Cursor cursor=resolver.query(created,new String[]{MediaStore.Video.Media.DISPLAY_NAME,MediaStore.Video.Media.SIZE,MediaStore.Video.Media.IS_PENDING},null,null,null)){
                if(cursor==null||!cursor.moveToFirst()||cursor.getLong(1)!=copied||cursor.getInt(2)!=0)throw new IOException("相册视频校验失败");
                JSONObject result=new JSONObject().put("path","Movies/SubFabric/"+cursor.getString(0)).put("uri",created.toString()).put("bytes",copied).put("gallery",true);published=true;return result;
            }
        }finally{
            if(created!=null&&!published){try{if(resolver.delete(created,null,null)!=1)throw new IOException("无法清理未完成的相册视频");}catch(Exception failure){throw new IOException("导出未完成，请检查 SubFabric 相册中的未完成视频",failure);}}
        }
    }
}
