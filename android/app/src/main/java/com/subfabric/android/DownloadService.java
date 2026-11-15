package com.subfabric.android;

import android.app.*;
import android.content.*;
import android.os.IBinder;
import org.json.*;

public final class DownloadService extends Service {
    private static final int NOTICE=5505;
    private static final String CHANNEL="subfabric-download";
    private static volatile boolean visible;
    private String id="";
    private android.os.PowerManager.WakeLock wake;
    private static Notification notice(Context context,JSONObject job){
        String id=job==null?"":job.optString("id");Intent cancel=new Intent(context,DownloadService.class).setAction("cancel").putExtra("jobId",id);
        return new Notification.Builder(context,CHANNEL).setSmallIcon(context.getApplicationInfo().icon).setContentTitle("SubFabric 素材下载").setContentText(job==null?"正在准备下载组件":job.optString("stage"))
            .setOngoing(true).setOnlyAlertOnce(true).setProgress(100,job==null?0:job.optInt("pct"),false)
            .setContentIntent(PendingIntent.getActivity(context,2,new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE))
            .addAction(new Notification.Action.Builder(null,"取消",PendingIntent.getService(context,3,cancel,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).build()).build();
    }
    @Override public void onCreate(){super.onCreate();getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,"素材下载",NotificationManager.IMPORTANCE_LOW));startForeground(NOTICE,notice(this,null));visible=true;wake=getSystemService(android.os.PowerManager.class).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"SubFabric:Download");wake.acquire(4*60*60*1000L);}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        DownloadManager manager=DownloadManager.get(this);
        if(intent==null){if(!manager.running())stopSelf(startId);return START_NOT_STICKY;}
        try{
            String task=intent.getStringExtra("jobId");
            if("cancel".equals(intent.getAction()))manager.cancel(task);
            else if("debug-crash".equals(intent.getAction()))manager.debugCrash(task);
            else if(!manager.running()){id=task;manager.receive(id);}
        }catch(Exception ignored){}
        // A stale redelivery must not stop a newer startId or its active worker.
        if(!manager.running())stopSelf(startId);
        return START_NOT_STICKY;
    }
    static void progress(Context context,JSONObject job){if(visible)context.getSystemService(NotificationManager.class).notify(NOTICE,notice(context,job));}
    @Override public void onDestroy(){visible=false;DownloadManager.get(this).stopped(id);if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
