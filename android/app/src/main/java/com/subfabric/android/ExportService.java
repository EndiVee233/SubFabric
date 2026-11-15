package com.subfabric.android;

import android.app.*;
import android.content.*;
import android.os.IBinder;
import org.json.*;

/** Media export continues while the editor is hidden; the notification exposes a stop action. */
public final class ExportService extends Service {
    private static final int NOTICE=4404;
    private static final String CHANNEL="subfabric-export";
    private static volatile boolean visible;
    private android.os.PowerManager.WakeLock wake;
    private String jobId="";
    private static Notification notification(Context context,JSONObject job){
        String project=job==null?"":job.optString("projectId");
        Intent open=new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent stop=new Intent(context,ExportService.class).setAction("cancel").putExtra("projectId",project);
        Notification.Builder builder=new Notification.Builder(context,CHANNEL).setSmallIcon(context.getApplicationInfo().icon).setContentTitle("SubFabric 视频导出").setContentText("正在导出，完成前请保留所选文件夹权限").setOngoing(true).setOnlyAlertOnce(true).setContentIntent(PendingIntent.getActivity(context,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).addAction(new Notification.Action.Builder(null,"停止",PendingIntent.getService(context,1,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).build());
        if(job!=null){double pct=0;JSONArray steps=job.optJSONArray("steps");if(steps!=null&&steps.length()>0){for(int i=0;i<steps.length();i++)pct+=steps.optJSONObject(i).optDouble("pct");pct/=steps.length();}builder.setProgress(100,(int)pct,false);}
        return builder.build();
    }
    @Override public void onCreate(){super.onCreate();NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel(CHANNEL,"视频导出",NotificationManager.IMPORTANCE_LOW));startForeground(NOTICE,notification(this,null));visible=true;wake=getSystemService(android.os.PowerManager.class).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,"SubFabric:VideoExport");wake.acquire(6*60*60*1000L);}
    @Override public int onStartCommand(Intent intent,int flags,int startId){if(intent!=null){if("debug-crash".equals(intent.getAction())){try{VideoExport.get(this).debugCrash(intent.getStringExtra("projectId"));}catch(Exception ignored){}}else if("cancel".equals(intent.getAction())){VideoExport engine=VideoExport.get(this);engine.cancel(intent.getStringExtra("projectId"));if(!engine.running())stopSelf();}else {jobId=intent.getStringExtra("jobId");try{VideoExport.get(this).receive(intent.getStringExtra("projectId"),jobId);}catch(Exception e){stopSelf();}}}return START_NOT_STICKY;}
    static void progress(Context context,JSONObject job){if(visible)context.getSystemService(NotificationManager.class).notify(NOTICE,notification(context,job));}
    @Override public void onDestroy(){visible=false;VideoExport.get(this).serviceStopped(jobId);if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
