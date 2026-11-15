package com.subfabric.android;
import android.media.*;
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.function.BooleanSupplier;

/** Streaming PCM audio cache and real 100 Hz min/max peaks; no full-media RAM decode. */
final class AudioTools {
    static void prepare(File source,File wav,File peaks,BooleanSupplier stop) throws Exception {
        File wt=new File(wav.getPath()+".part"),pt=new File(peaks.getPath()+".part");
        MediaExtractor extractor=new MediaExtractor();MediaCodec codec=null;
        try(Collector out=new Collector(wt,pt,stop)) {
            extractor.setDataSource(source.getPath());MediaFormat format=null;
            for(int i=0;i<extractor.getTrackCount();i++){MediaFormat f=extractor.getTrackFormat(i);if(f.getString(MediaFormat.KEY_MIME).startsWith("audio/")){format=f;extractor.selectTrack(i);break;}}
            if(format==null)throw new IOException("媒体没有音轨");
            int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE),channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT),encoding=AudioFormat.ENCODING_PCM_16BIT;
            out.start(rate);
            if(format.getString(MediaFormat.KEY_MIME).equals("audio/raw")) {
                ByteBuffer buffer=ByteBuffer.allocate(1024*1024);
                while(true){out.check();buffer.clear();int count=extractor.readSampleData(buffer,0);if(count<0)break;buffer.position(0);buffer.limit(count);out.accept(buffer,channels,encoding);extractor.advance();}
            }else{
                codec=MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));codec.configure(format,null,null,0);codec.start();
                boolean inputEnd=false,outputEnd=false;MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();long last=System.currentTimeMillis();
                while(!outputEnd){
                    out.check();if(System.currentTimeMillis()-last>120000)throw new IOException("音频解码超时");
                    if(!inputEnd){int i=codec.dequeueInputBuffer(10000);if(i>=0){ByteBuffer b=codec.getInputBuffer(i);int count=extractor.readSampleData(b,0);if(count<0){codec.queueInputBuffer(i,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputEnd=true;}else{codec.queueInputBuffer(i,0,count,extractor.getSampleTime(),0);extractor.advance();}}}
                    int i=codec.dequeueOutputBuffer(info,10000);
                    if(i==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat f=codec.getOutputFormat();channels=f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);int actual=f.getInteger(MediaFormat.KEY_SAMPLE_RATE);if(actual!=rate)throw new IOException("音轨采样率发生变化");encoding=f.containsKey(MediaFormat.KEY_PCM_ENCODING)?f.getInteger(MediaFormat.KEY_PCM_ENCODING):AudioFormat.ENCODING_PCM_16BIT;}
                    else if(i>=0){last=System.currentTimeMillis();ByteBuffer b=codec.getOutputBuffer(i);b.position(info.offset);b.limit(info.offset+info.size);out.accept(b,channels,encoding);outputEnd=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;codec.releaseOutputBuffer(i,false);}
                }
            }
            out.finish();
        }catch(Throwable e){wt.delete();pt.delete();throw e;}finally{if(codec!=null){try{codec.stop();}catch(Exception ignored){}codec.release();}extractor.release();}
        Files.move(wt.toPath(),wav.toPath(),StandardCopyOption.REPLACE_EXISTING);Files.move(pt.toPath(),peaks.toPath(),StandardCopyOption.REPLACE_EXISTING);
    }
    private static final class Collector implements AutoCloseable {
        final RandomAccessFile wav;final OutputStream audio,peaks;final BooleanSupplier stop;int rate,phase;float low=1,high=-1;long samples,bucket;boolean finished;
        Collector(File wf,File pf,BooleanSupplier stop) throws Exception {this.stop=stop;wav=new RandomAccessFile(wf,"rw");wav.setLength(0);wav.write(new byte[44]);audio=new BufferedOutputStream(new FileOutputStream(wav.getFD()),65536);peaks=new BufferedOutputStream(new FileOutputStream(pf),65536);}
        void start(int rate)throws Exception{if(rate<8000||rate>192000)throw new IOException("不支持该音频采样率");this.rate=rate;}
        void check()throws Exception{if(stop.getAsBoolean()||Thread.currentThread().isInterrupted())throw new IOException("音频准备已停止");}
        void accept(ByteBuffer b,int channels,int encoding)throws Exception{
            if(channels<1||channels>8)throw new IOException("不支持该音轨通道数");
            boolean floating=encoding==AudioFormat.ENCODING_PCM_FLOAT;int bytes=floating?4:2;
            if(!floating&&encoding!=AudioFormat.ENCODING_PCM_16BIT)throw new IOException("不支持该 PCM 编码");
            b.order(ByteOrder.LITTLE_ENDIAN);check();
            while(b.remaining()>=bytes*channels){float v=0;for(int c=0;c<channels;c++)v+=floating?b.getFloat():b.getShort()/32768f;v=Math.max(-1,Math.min(1,v/channels));int s=Math.round(v*32767);audio.write(s&255);audio.write((s>>>8)&255);samples++;low=Math.min(low,v);high=Math.max(high,v);bucket++;phase+=100;if(phase>=rate){phase-=rate;flushPeak();}}
        }
        void flushPeak()throws Exception{if(bucket==0)return;peaks.write(Math.max(0,Math.min(255,128+Math.round(low*127))));peaks.write(Math.max(0,Math.min(255,128+Math.round(high*127))));low=1;high=-1;bucket=0;}
        void finish()throws Exception{
            if(samples==0)throw new IOException("音轨为空");check();flushPeak();audio.flush();peaks.flush();
            ByteBuffer h=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);h.put(new byte[]{'R','I','F','F'}).putInt((int)(samples*2+36)).put(new byte[]{'W','A','V','E','f','m','t',' '}).putInt(16).putShort((short)1).putShort((short)1).putInt(rate).putInt(rate*2).putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt((int)(samples*2));wav.seek(0);wav.write(h.array());wav.getFD().sync();finished=true;
        }
        public void close()throws Exception{try{audio.flush();peaks.close();}finally{wav.close();}}
    }
}
