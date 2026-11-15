package com.subfabric.android;
import java.io.*;
import java.security.MessageDigest;

/** Pinned to the official archive whose digest is in android/model-files.json. */
final class ModelFiles {
    static final String[] NAMES={"encoder.int8.onnx","decoder.int8.onnx","joiner.int8.onnx","tokens.txt"};
    static final long[] SIZES={652282309L,7257753L,1739080L,9384L};
    static final String[] HASHES={"92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b","4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41","77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428","ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"};
    static long size(String name) { for(int i=0;i<NAMES.length;i++) if(NAMES[i].equals(name)) return SIZES[i]; return -1; }
    static void verify(File file,String name) throws Exception {
        int index=java.util.Arrays.asList(NAMES).indexOf(name);
        if(index<0 || file.length()!=SIZES[index]) throw new IOException("模型文件大小不匹配："+name);
        MessageDigest digest=MessageDigest.getInstance("SHA-256"); byte[] buffer=new byte[262144];
        try(InputStream input=new FileInputStream(file)) { for(int n;(n=input.read(buffer))!=-1;) { if(Thread.currentThread().isInterrupted()) throw new IOException("任务已停止"); digest.update(buffer,0,n); } }
        StringBuilder hash=new StringBuilder(); for(byte value:digest.digest()) hash.append(String.format("%02x",value&255));
        if(!HASHES[index].equals(hash.toString())) throw new IOException("模型 SHA-256 校验失败："+name);
    }
}
