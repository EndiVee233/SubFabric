#include <jni.h>
#include <android/log.h>
#include <vulkan/vulkan.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "parakeet.h"
#include "ggml-impl.h"
#include "qwen3_asr.h"
#include "core/gpu_backend_pref.h"
#include "core/qwen3_prompt.h"
#include "core/greedy_decode.h"
#include "core/bpe.h"
#include "core/ngram_loop_fix.h"
using std::string;
static string quote(const string& s) { string o="\"";for(unsigned char c:s){if(c=='"'||c=='\\'){o+='\\';o+=c;}else if(c<32){char b[7];snprintf(b,7,"\\u%04x",c);o+=b;}else o+=c;}return o+'"'; }
static string utf(JNIEnv* e,jstring s){if(!s)return "";jclass cls=e->FindClass("java/lang/String");jstring charset=e->NewStringUTF("UTF-8");auto bytes=(jbyteArray)e->CallObjectMethod(s,e->GetMethodID(cls,"getBytes","(Ljava/lang/String;)[B"),charset);int n=e->GetArrayLength(bytes);string result(n,'\0');e->GetByteArrayRegion(bytes,0,n,reinterpret_cast<jbyte*>(result.data()));e->DeleteLocalRef(bytes);e->DeleteLocalRef(charset);e->DeleteLocalRef(cls);return result;}
// Return real UTF-8, including supplementary CJK characters, through Java's decoder.
static jstring javaString(JNIEnv* e,const string& s){jbyteArray bytes=e->NewByteArray(s.size());e->SetByteArrayRegion(bytes,0,s.size(),reinterpret_cast<const jbyte*>(s.data()));jclass cls=e->FindClass("java/lang/String");jstring charset=e->NewStringUTF("UTF-8");jstring out=(jstring)e->NewObject(cls,e->GetMethodID(cls,"<init>","([BLjava/lang/String;)V"),bytes,charset);e->DeleteLocalRef(bytes);e->DeleteLocalRef(charset);e->DeleteLocalRef(cls);return out;}
static void fail(JNIEnv* e,const char* s){e->ThrowNew(e->FindClass("java/io/IOException"),s);}
struct Device { string name;int index=-1;bool compatible=true; };
static Device probe(){
 VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};app.pApplicationName="SubFabric ASR";app.apiVersion=VK_API_VERSION_1_2;
 VkInstanceCreateInfo ci{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};ci.pApplicationInfo=&app;VkInstance instance;
 if(vkCreateInstance(&ci,nullptr,&instance)!=VK_SUCCESS)throw std::runtime_error("Vulkan 1.2 GPU unavailable; CPU inference disabled");
 uint32_t n=0;vkEnumeratePhysicalDevices(instance,&n,nullptr);std::vector<VkPhysicalDevice> ds(n);vkEnumeratePhysicalDevices(instance,&n,ds.data());Device result;
 for(uint32_t i=0;i<n;i++){VkPhysicalDeviceProperties p;vkGetPhysicalDeviceProperties(ds[i],&p);string name=p.deviceName,lower=name;std::transform(lower.begin(),lower.end(),lower.begin(),::tolower);
  if((p.deviceType==VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU||p.deviceType==VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU)&&p.apiVersion>=VK_API_VERSION_1_2&&lower.find("swiftshader")==string::npos&&lower.find("llvmpipe")==string::npos&&lower.find("lavapipe")==string::npos){Device candidate{name,(int)i,!(p.driverVersion==96477283&&lower.find("direct3d12")!=string::npos)};if(candidate.compatible){result=candidate;break;}if(result.index<0)result=candidate;}}
 vkDestroyInstance(instance,nullptr);if(result.index<0)throw std::runtime_error("No hardware Vulkan GPU; CPU inference disabled");return result;
}
static void validateGpu(){
 struct Resources{ggml_backend_t backend=nullptr;ggml_context* ctx=nullptr;ggml_backend_buffer_t buffer=nullptr;~Resources(){if(buffer)ggml_backend_buffer_free(buffer);if(ctx)ggml_free(ctx);if(backend)ggml_backend_free(backend);}};
 for(auto type:{GGML_TYPE_F32,GGML_TYPE_F16,GGML_TYPE_Q4_K}){
  Resources r;r.backend=crispasr_init_gpu_backend();if(!r.backend||core_cpu_backend::is_cpu(r.backend))throw std::runtime_error("Hardware Vulkan backend unavailable; CPU disabled");
  ggml_init_params ip{ggml_tensor_overhead()*16+ggml_graph_overhead_custom(16,false)+1024,nullptr,true};r.ctx=ggml_init(ip);if(!r.ctx)throw std::runtime_error("Vulkan self-check allocation failed");
  constexpr int k=256;auto a=ggml_new_tensor_2d(r.ctx,type,k,2),b=ggml_new_tensor_2d(r.ctx,GGML_TYPE_F32,k,2);auto result=ggml_mul_mat(r.ctx,a,b);auto graph=ggml_new_graph_custom(r.ctx,16,false);ggml_build_forward_expand(graph,result);
  r.buffer=ggml_backend_alloc_ctx_tensors(r.ctx,r.backend);if(!r.buffer)throw std::runtime_error("Vulkan self-check buffer failed");std::vector<float> av(k*2),bv(k*2),reference(k*2);for(int i=0;i<k*2;i++){av[i]=std::sin(i*.13f);bv[i]=std::cos(i*.07f);}
  std::vector<uint8_t> packed(ggml_nbytes(a));if(type==GGML_TYPE_F32)memcpy(packed.data(),av.data(),packed.size());else if(type==GGML_TYPE_F16){auto dst=reinterpret_cast<ggml_fp16_t*>(packed.data());for(size_t i=0;i<av.size();i++)dst[i]=ggml_fp32_to_fp16(av[i]);}else ggml_quantize_chunk(type,av.data(),packed.data(),0,2,k,nullptr);
  if(type==GGML_TYPE_F32)reference=av;else ggml_get_type_traits(type)->to_float(packed.data(),reference.data(),reference.size());ggml_backend_tensor_set(a,packed.data(),0,packed.size());
  for(int round=0;round<2;round++){
   if(round)for(float& value:bv)value*=2;ggml_backend_tensor_set(b,bv.data(),0,bv.size()*sizeof(float));if(ggml_backend_graph_compute(r.backend,graph)!=GGML_STATUS_SUCCESS)throw std::runtime_error("Vulkan matrix self-check execution failed; CPU disabled");float output[4];ggml_backend_tensor_get(result,output,0,sizeof(output));
   for(int row=0;row<2;row++)for(int col=0;col<2;col++){double expected=0;for(int i=0;i<k;i++)expected+=reference[row*k+i]*bv[col*k+i];float got=output[col*2+row];if(!std::isfinite(got)||std::fabs(got-expected)>.02*(1+std::fabs(expected)))throw std::runtime_error(string("Vulkan ")+ggml_type_name(type)+" matrix self-check failed; unsupported GPU driver; CPU disabled");}
  }
 }
}
struct Model {int kind;parakeet_context* p=nullptr;qwen3_asr_context* q=nullptr;~Model(){if(p)parakeet_free(p);if(q)qwen3_asr_free(q);}};
extern "C" JNIEXPORT jstring JNICALL Java_com_subfabric_android_VulkanAsr_probeNative(JNIEnv* e,jclass){try{auto d=probe();return javaString(e,string("{\"available\":")+(d.compatible?"true":"false")+",\"hardwareAvailable\":true,\"device\":"+quote(d.name)+",\"backend\":\"vulkan\",\"cpuFallback\":false,\"error\":"+quote(d.compatible?"":"当前 WSA 的 Dozen Vulkan 驱动未通过 ASR 数值验证；CPU 识别已禁用")+"}");}catch(const std::exception& x){return javaString(e,"{\"available\":false,\"backend\":\"vulkan\",\"cpuFallback\":false,\"error\":"+quote(x.what())+"}");}}
extern "C" JNIEXPORT jlong JNICALL Java_com_subfabric_android_VulkanAsr_openNative(JNIEnv* e,jclass,jstring path,jint kind,jint threads){try{
 ggml_log_set([](ggml_log_level level,const char* message,void*){__android_log_write(level==GGML_LOG_LEVEL_ERROR?ANDROID_LOG_ERROR:ANDROID_LOG_INFO,"SubFabricASR",message);},nullptr);
 auto d=probe();if(!d.compatible)throw std::runtime_error("This WSA Dozen driver failed ASR numerical validation; CPU inference disabled");
 setenv("GGML_VK_VISIBLE_DEVICES",std::to_string(d.index).c_str(),1);crispasr_set_gpu_backend_pref("vulkan");crispasr_set_gpu_device_pref(0);
 setenv("CRISPASR_QWEN3_ASR_EMBED_FAST","0",1);setenv("CRISPASR_PARAKEET_GGML_DECODE","1",1);setenv("CRISPASR_RNNT_GPU_ENC_PROJ","1",1);
 validateGpu();
 auto m=std::make_unique<Model>();m->kind=kind;string file=utf(e,path);
 if(kind==1){auto p=parakeet_context_default_params();p.use_gpu=true;p.use_flash=false;p.n_threads=std::clamp((int)threads,1,8);m->p=parakeet_init_from_file(file.c_str(),p);if(!m->p||!parakeet_decode_uses_backend(m->p))throw std::runtime_error("Parakeet Vulkan model load failed; no CPU fallback");}
 else if(kind==2||kind==3){auto p=qwen3_asr_context_default_params();p.use_gpu=true;p.flash_attn=false;p.n_threads=std::clamp((int)threads,1,8);m->q=qwen3_asr_init_from_file(file.c_str(),p);if(!m->q)throw std::runtime_error("Qwen Vulkan model load failed; no CPU fallback");if((qwen3_asr_lm_head_dim(m->q)==5000)!=(kind==3))throw std::runtime_error("Wrong Qwen model type");}
 else throw std::runtime_error("Unknown model type");return reinterpret_cast<jlong>(m.release());
 }catch(const std::exception& x){fail(e,x.what());return 0;}}
extern "C" JNIEXPORT void JNICALL Java_com_subfabric_android_VulkanAsr_closeNative(JNIEnv*,jclass,jlong handle){delete reinterpret_cast<Model*>(handle);}
template<class T>using Heap=std::unique_ptr<T,decltype(&std::free)>;
static string decodeBytes(const string& s){string out;const auto& map=core_bpe::byte_encoder();for(size_t i=0;i<s.size();){unsigned char first=s[i++];uint32_t cp=first;int more=0;if(first>=0xf0){cp=first&7;more=3;}else if(first>=0xe0){cp=first&15;more=2;}else if(first>=0xc0){cp=first&31;more=1;}while(more--&&i<s.size())cp=(cp<<6)|(s[i++]&63);auto it=std::find(map.begin(),map.end(),int(cp));if(it==map.end())throw std::runtime_error("Invalid Qwen token encoding");out+=char(it-map.begin());}return out;}
static bool validScores(const float* scores,int n){if(!scores||n<1)return false;for(int i=0;i<n;i++)if(!std::isfinite(scores[i]))return false;return true;}
static string qwen(Model* m,const std::vector<float>& pcm){
 int nm=0,tm=0,nenc=0,dim=0;Heap<float> mel(qwen3_asr_compute_mel(m->q,pcm.data(),pcm.size(),&nm,&tm),std::free);if(!mel)throw std::runtime_error("Qwen mel failed");
 Heap<float> audio(qwen3_asr_run_encoder(m->q,mel.get(),nm,tm,&nenc,&dim),std::free);if(!audio)throw std::runtime_error("Qwen Vulkan encoder failed");
 string prompt=core_qwen3_prompt::build(nenc,"","","","","");int nt=0,npad=0;
 Heap<int32_t> ids(qwen3_asr_tokenize(m->q,prompt.c_str(),&nt),std::free),pad(qwen3_asr_tokenize(m->q,"<|audio_pad|>",&npad),std::free);
 if(!ids||!pad||npad!=1)throw std::runtime_error("Qwen tokenizer failed");Heap<float> embeds(qwen3_asr_embed_tokens(m->q,ids.get(),nt),std::free);if(!embeds)throw std::runtime_error("Qwen embeddings failed");
 int copied=0;for(int i=0;i<nt;i++)if(ids.get()[i]==pad.get()[0]&&copied<nenc){memcpy(embeds.get()+size_t(i)*dim,audio.get()+size_t(copied++)*dim,dim*sizeof(float));}if(copied!=nenc)throw std::runtime_error("Qwen audio prompt mismatch");
 if(!qwen3_asr_kv_init(m->q,std::max(2048,nt+528)))throw std::runtime_error("Insufficient Vulkan memory for Qwen KV cache");qwen3_asr_kv_reset(m->q);int out=0,vocab=0;
 Heap<float> logits(qwen3_asr_run_llm_kv(m->q,embeds.get(),nt,0,&out,&vocab),std::free);if(!logits||out<1||vocab<1)throw std::runtime_error("Qwen Vulkan prefill failed");int neos=0;Heap<int32_t> eos(qwen3_asr_tokenize(m->q,"<|im_end|>",&neos),std::free);if(!eos||neos!=1)throw std::runtime_error("Qwen EOS missing");
 auto row=logits.get()+size_t(out-1)*vocab;if(!validScores(row,vocab))throw std::runtime_error("Vulkan returned non-finite Qwen scores; CPU disabled");int first=core_greedy_decode::argmax(row,vocab);core_greedy_decode::Config cfg;cfg.max_new_tokens=512;cfg.eos_id=eos.get()[0];cfg.vocab_size=vocab;
 bool invalid=false;auto forward=[&](qwen3_asr_context* ctx,const float* input,int count,int past,int* outTokens,int* outVocab){float* output=qwen3_asr_run_llm_kv(ctx,input,count,past,outTokens,outVocab);if(output&&!validScores(output,vocab)){std::free(output);invalid=true;return (float*)nullptr;}return output;};
 auto dec=core_greedy_decode::run_with_probs(m->q,first,1,nt,qwen3_asr_embed_tokens,forward,cfg);
 if(invalid)throw std::runtime_error("Vulkan returned non-finite Qwen scores; CPU disabled");
 if(dec.tokens.empty()||dec.tokens.back()!=cfg.eos_id){__android_log_print(ANDROID_LOG_ERROR,"SubFabricASR","Incomplete Qwen decode: count=%zu first=%d last=%d eos=%d",dec.tokens.size(),dec.tokens.empty()?-1:dec.tokens.front(),dec.tokens.empty()?-1:dec.tokens.back(),cfg.eos_id);throw std::runtime_error("Qwen decode incomplete; original subtitles retained");}
 string raw;for(auto token:dec.tokens){if(token==cfg.eos_id)break;const char* p=qwen3_asr_token_text(m->q,token);if(p)raw+=p;}
 raw=decodeBytes(raw);auto at=raw.find("<asr_text>");if(at!=string::npos)raw=raw.substr(at+10);
 if(raw.find("<non_speech>")!=string::npos)return "";for(size_t pos;(pos=raw.find('<'))!=string::npos;){auto end=raw.find('>',pos);if(end==string::npos)break;raw.erase(pos,end-pos+1);}
 return core_ngram::fix_loops(raw);
}
extern "C" JNIEXPORT jstring JNICALL Java_com_subfabric_android_VulkanAsr_recognizeNative(JNIEnv* e,jclass,jlong handle,jfloatArray samples,jdouble offset){try{
 auto* m=reinterpret_cast<Model*>(handle);int n=e->GetArrayLength(samples);if(!m||n<=0||n>16000*30)throw std::runtime_error("Invalid model audio window");std::vector<float> pcm(n);e->GetFloatArrayRegion(samples,0,n,pcm.data());std::ostringstream json;json.precision(12);
 if(m->kind==1){auto* r=parakeet_transcribe_ex(m->p,pcm.data(),n,0);if(!r)throw std::runtime_error("Parakeet Vulkan inference failed");
  json<<"{\"text\":"<<quote(r->text?r->text:"")<<",\"words\":[";for(int i=0;i<r->n_words;i++){if(i)json<<',';json<<"{\"text\":"<<quote(r->words[i].text)<<",\"start\":"<<offset+r->words[i].t0/100.0<<",\"end\":"<<offset+r->words[i].t1/100.0<<'}';}json<<"]}";parakeet_result_free(r);
 }else if(m->kind==2)json<<"{\"text\":"<<quote(qwen(m,pcm))<<",\"words\":[]}";else throw std::runtime_error("ASR model required");return javaString(e,json.str());
 }catch(const std::exception& x){fail(e,x.what());return nullptr;}}
extern "C" JNIEXPORT jlongArray JNICALL Java_com_subfabric_android_VulkanAsr_alignNative(JNIEnv* e,jclass,jlong handle,jfloatArray samples,jobjectArray words){try{
 auto* m=reinterpret_cast<Model*>(handle);int n=e->GetArrayLength(samples),count=e->GetArrayLength(words);if(!m||m->kind!=3||n<=0||n>16000*120||count<1||count>2048)throw std::runtime_error("Invalid alignment window");std::vector<float> pcm(n);e->GetFloatArrayRegion(samples,0,n,pcm.data());std::vector<string> text;for(int i=0;i<count;i++){jstring s=(jstring)e->GetObjectArrayElement(words,i);text.push_back(utf(e,s));e->DeleteLocalRef(s);}std::vector<const char*> ptr;for(auto& s:text)ptr.push_back(s.c_str());std::vector<int64_t> start(count),end(count);
 if(qwen3_asr_align_words(m->q,pcm.data(),n,ptr.data(),count,start.data(),end.data())!=0)throw std::runtime_error("Qwen Vulkan alignment failed; no partial result accepted");
 std::vector<jlong> times;int64_t previous=0;for(int i=0;i<count;i++){if(start[i]<previous||start[i]>=n/16||end[i]<=start[i]||end[i]>n/16+80)throw std::runtime_error("Qwen alignment incomplete or invalid; original subtitles retained");times.push_back(start[i]);times.push_back(std::min(end[i],int64_t(n/16)));previous=end[i];}jlongArray result=e->NewLongArray(times.size());e->SetLongArrayRegion(result,0,times.size(),times.data());return result;
 }catch(const std::exception& x){fail(e,x.what());return nullptr;}}
