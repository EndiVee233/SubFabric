package com.subfabric.android;

import android.webkit.WebResourceResponse;
import java.io.*;
import java.util.*;

/** WebView applies the request Range to the returned stream before exposing it. */
final class MediaResponse {
    static WebResourceResponse open(File file,String mime,String range) throws IOException {
        long size=file.length(),start=0,end=size-1;
        if(!file.isFile()||size==0)return response(404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
        boolean partial=range!=null&&range.trim().matches("(?i)bytes=\\d*-\\d*");
        if(partial){
            String[] parts=range.trim().substring(6).split("-",-1);
            try{
                if(parts[0].isEmpty()){
                    long suffix=Long.parseLong(parts[1]);
                    if(suffix<=0)return invalid(size);
                    start=Math.max(0,size-suffix);
                }else{
                    start=Long.parseLong(parts[0]);
                    if(!parts[1].isEmpty())end=Math.min(end,Long.parseLong(parts[1]));
                }
            }catch(NumberFormatException error){return invalid(size);}
            if(start>=size||end<start)return invalid(size);
        }
        // Begin at byte zero: Chromium's InputStreamReader seeks by calling skip().
        // Bound the END only, otherwise WebView would apply the start offset twice.
        // available() also gives WebView the size needed to resolve suffix ranges.
        final long endBound=end+1;
        InputStream input=new FilterInputStream(new FileInputStream(file)){
            long remaining=endBound;
            @Override public int available() throws IOException{return (int)Math.min(remaining,super.available());}
            @Override public int read() throws IOException{if(remaining==0)return -1;int n=super.read();if(n>=0)remaining--;return n;}
            @Override public int read(byte[] b,int off,int len) throws IOException{
                if(len==0)return 0;if(remaining==0)return -1;
                int n=super.read(b,off,(int)Math.min(len,remaining));if(n>0)remaining-=n;return n;
            }
            @Override public long skip(long n) throws IOException{if(n<=0)return 0;long skipped=super.skip(Math.min(n,remaining));remaining-=skipped;return skipped;}
        };
        Map<String,String> headers=new HashMap<>();headers.put("Accept-Ranges","bytes");headers.put("Cache-Control","no-store");
        if(partial)headers.put("Content-Range","bytes "+start+"-"+end+"/"+size);
        // WebView adds Content-Length itself after its seek. Adding it again can
        // expose conflicting duplicate lengths to the media demuxer.
        return new WebResourceResponse(mime,null,partial?206:200,partial?"Partial Content":"OK",headers,input);
    }
    private static WebResourceResponse invalid(long size){return response(416,"Range Not Satisfiable",Collections.singletonMap("Content-Range","bytes */"+size),new ByteArrayInputStream(new byte[0]));}
    private static WebResourceResponse response(int code,String reason,Map<String,String> headers,InputStream input){return new WebResourceResponse("text/plain","UTF-8",code,reason,headers,input);}
}
