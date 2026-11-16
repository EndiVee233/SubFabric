package com.subfabric.android;
import java.io.IOException;
import org.json.*;
/** Vulkan only. No ONNX, CPU model path, Python or cloud transport. */
final class VulkanAsr implements AutoCloseable {
    private static final String loadError;
    static {String error=null;try{System.loadLibrary("subfabric_asr");}catch(Throwable e){error="Vulkan 运行库无法加载；CPU 识别已禁用";}loadError=error;}
    static JSONObject probe()throws JSONException{return loadError==null?new JSONObject(probeNative()):new JSONObject().put("available",false).put("error",loadError).put("cpuFallback",false);}
    private long handle;
    VulkanAsr(String path,int kind)throws IOException{this(path,kind,4);}
    VulkanAsr(String path,int kind,int threads)throws IOException{if(loadError!=null)throw new IOException(loadError);handle=openNative(path,kind,threads);if(handle==0)throw new IOException("Vulkan 模型初始化失败；CPU 识别已禁用");}
    JSONObject recognize(float[] pcm,double offset)throws Exception{return new JSONObject(recognizeNative(handle,pcm,offset));}
    long[] align(float[] pcm,String[] words)throws IOException{return alignNative(handle,pcm,words);}
    public void close(){if(handle!=0){closeNative(handle);handle=0;}}
    private static native String probeNative();
    private static native long openNative(String path,int kind,int threads)throws IOException;
    private static native void closeNative(long handle);
    private static native String recognizeNative(long handle,float[] pcm,double offset)throws IOException;
    private static native long[] alignNative(long handle,float[] pcm,String[] words)throws IOException;
}
