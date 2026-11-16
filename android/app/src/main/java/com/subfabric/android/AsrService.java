package com.subfabric.android;

import android.app.*;
import android.content.*;
import android.os.IBinder;
import org.json.*;

/** Native recognition has its own process so model loading cannot freeze or crash the editor. */
public final class AsrService extends Service {
    private static final int NOTICE=6606;
    private static final String CHANNEL="subfabric-asr";
    private static volatile boolean visible;
    private String id="";
    private android.os.PowerManager.WakeLock wake;
    private static Notification notice(Context context,JSONObject job){
        String id=job==null?"":job.optString("id");
        Intent cancel=new Intent(context,AsrService.class).setAction("cancel").putExtra("jobId",id);
        return new Notification.Builder(context,CHANNEL).setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle("SubFabric "+(job!=null&&job.optString("kind").equals("align")?"字幕对齐":job!=null&&job.optString("kind").equals("model")?"模型下载":"Vulkan 语音识别")).setContentText(job==null?"正在准备 Vulkan 任务":job.optString("stage"))
            .setOngoing(true).setOnlyAlertOnce(true).setProgress(100,job==null?0:job.optInt("pct"),false)
            .setContentIntent(PendingIntent.getActivity(context,6,new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE))
            .addAction(new Notification.Action.Builder(null,"停止",PendingIntent.getService(context,7,cancel,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).build()).build();
    }
    @Override public void onCreate(){
        super.onCreate();getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,"本地语音识别",NotificationManager.IMPORTANCE_LOW));
        startForeground(NOTICE,notice(this,null));visible=true;
        wake=getSystemService(android.os.PowerManager.class).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"SubFabric:ASR");wake.acquire(6*60*60*1000L);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        AsrManager manager=AsrManager.get(this);
        if(intent!=null)try{
            String task=intent.getStringExtra("jobId");
            if("cancel".equals(intent.getAction()))manager.cancel(task);
            else if(!manager.running()){id=task;manager.receive(id);}
        }catch(Exception ignored){}
        if(!manager.running())stopSelf(startId);
        return START_NOT_STICKY;
    }
    static void progress(Context context,JSONObject job){if(visible)context.getSystemService(NotificationManager.class).notify(NOTICE,notice(context,job));}
    @Override public void onDestroy(){visible=false;AsrManager.get(this).stopped(id);if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
