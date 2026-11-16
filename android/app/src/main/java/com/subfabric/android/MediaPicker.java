package com.subfabric.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ClipData;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import java.io.IOException;
import java.util.Locale;

/** Shared entry point for both WebView video inputs and native media association. */
final class MediaPicker {
    static Uri[] result(int result,Intent data){
        if(result!=Activity.RESULT_OK||data==null)return null;
        ClipData clips=data.getClipData();
        if(clips!=null&&clips.getItemCount()>0){
            Uri[] uris=new Uri[clips.getItemCount()];for(int i=0;i<uris.length;i++)uris[i]=clips.getItemAt(i).getUri();return uris;
        }
        return data.getData()==null?null:new Uri[]{data.getData()};
    }
    interface Selection { void choose(Intent intent) throws Exception; void cancel(); void error(Exception error); }
    static boolean acceptsVideo(String[] accepts){
        if(accepts==null)return false;
        for(String group:accepts){if(group==null)continue;for(String item:group.toLowerCase(Locale.ROOT).split(",")){
            String type=item.trim();if(type.startsWith("video/")||type.matches("\\.(mp4|mkv|avi|mov|m4v|webm|3gp|mpeg|mpg|ts|m2ts)"))return true;
        }}return false;
    }
    static Intent files(boolean multiple,boolean audio){
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(audio?"*/*":"video/*");
        if(audio)intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"video/*","audio/*"});
        return intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,multiple);
    }
    static Intent gallery(Activity activity,boolean multiple) throws IOException {
        Intent picker=new Intent(MediaStore.ACTION_PICK_IMAGES).setType("video/*");
        if(picker.resolveActivity(activity.getPackageManager())!=null){
            if(multiple)picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX,Build.VERSION.SDK_INT>=33?MediaStore.getPickImagesMaxLimit():20);
            return picker;
        }
        Intent legacy=new Intent(multiple?Intent.ACTION_GET_CONTENT:Intent.ACTION_PICK).setType("video/*");
        if(multiple)legacy.addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);
        else legacy.setDataAndType(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,"video/*");
        if(legacy.resolveActivity(activity.getPackageManager())!=null)return legacy;
        throw new IOException("当前系统没有可用的相册选择器，请从文件导入");
    }
    static void show(Activity activity,boolean multiple,boolean audio,Selection selection){
        new AlertDialog.Builder(activity).setTitle("导入视频").setItems(new String[]{"从相册导入","从文件导入"},(dialog,index)->{
            try{selection.choose(index==0?gallery(activity,multiple):files(multiple,audio));}catch(Exception error){selection.error(error);}
        }).setNegativeButton("取消",(dialog,which)->selection.cancel()).setOnCancelListener(dialog->selection.cancel()).show();
    }
}
