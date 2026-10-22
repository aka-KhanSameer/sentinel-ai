import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MODEL_ID = 'protectai/deberta-v3-base-prompt-injection-v2';
const MODEL_REVISION = '90c9989b1a342275dd0d1a95aad283c04e075671';
const MODEL_DIR = () => resolve(process.env.SENTINEL_MODEL_DIR || 'models/sentinel-deberta-v3-prompt-injection-v2');
const REQUIRED = ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','spm.model','onnx/config.json','onnx/model.onnx'];
let pipelinePromise;

export function getClassifierStatus(){
 const dir=MODEL_DIR(),missing=REQUIRED.filter(file=>!existsSync(resolve(dir,file)));
 let modelBytes=0;if(!missing.length){try{modelBytes=statSync(resolve(dir,'onnx/model.onnx')).size;}catch{missing.push('onnx/model.onnx');}}
 if(modelBytes<100_000_000&&!missing.includes('onnx/model.onnx'))missing.push('onnx/model.onnx (unexpectedly small)');
 return {id:MODEL_ID,revision:MODEL_REVISION,license:'Apache-2.0',status:missing.length?'unavailable':'configured_not_loaded',model_dir:dir,missing};
}

async function loadPipeline(){
 if(!pipelinePromise){pipelinePromise=(async()=>{
  const status=getClassifierStatus();if(status.missing.length)throw new Error('Local classifier model files are incomplete.');
  const {pipeline,env}=await import('@huggingface/transformers');env.allowRemoteModels=false;
  return pipeline('text-classification',status.model_dir,{local_files_only:true,device:'cpu',dtype:'fp32',session_options:{intraOpNumThreads:2}});
 })().catch(error=>{pipelinePromise=undefined;throw error;});}
 return pipelinePromise;
}

function splitByTokenizer(text,tokenizer,{maxTokens=480,maxChunks=256,overlapChars=64,regions:providedRegions}={}){
 const chunks=[],regions=Array.isArray(providedRegions)?providedRegions.filter(r=>Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=text.length).map(r=>({start:r.start,end:r.end})):[];let lineStart=0;
 if(!Array.isArray(providedRegions)){for(let i=0;i<=text.length;i++)if(i===text.length||text[i]==='\n'){if(i>lineStart)regions.push({start:lineStart,end:i});lineStart=i+1;}if(!regions.length&&text.length)regions.push({start:0,end:text.length});}
 let truncated=false;
 for(const region of regions){let start=region.start,end=region.end;
  while(start<end&&chunks.length<maxChunks){
   let lo=start+1,hi=Math.min(end,start+8192),best=start;
   while(lo<=hi){let mid=(lo+hi)>>1;if(mid<end&&mid>start&&text.charCodeAt(mid-1)>=0xD800&&text.charCodeAt(mid-1)<=0xDBFF)mid--;
    const count=tokenizer.encode(text.slice(start,mid),{add_special_tokens:true}).length;
    if(count<=maxTokens){best=mid;lo=mid+1;}else hi=mid-1;
   }
   if(best<=start)best=Math.min(end,start+1);
   const content=text.slice(start,best);chunks.push({text:content,start,end:best,token_count:tokenizer.encode(content,{add_special_tokens:true}).length});
   if(best>=end)break;
   let next=Math.max(start+1,best-overlapChars);if(text.charCodeAt(next)>=0xDC00&&text.charCodeAt(next)<=0xDFFF)next++;
   start=next;
  }
  if(chunks.length>=maxChunks&&region.end<(regions.at(-1)?.end||0)){truncated=true;break;}
 }
 if(chunks.length>=maxChunks&&chunks.at(-1)?.end<text.length)truncated=true;
 return {chunks,truncated};
}

export async function analyzeWithClassifier(text,{threshold=Number(process.env.SENTINEL_ML_THRESHOLD||0.5),maxChunks=Number(process.env.SENTINEL_ML_MAX_CHUNKS||256),regions}={}){
 const status=getClassifierStatus();if(status.missing.length)return {status:'unavailable',mode:'rules_only_fallback',model:status.id,revision:status.revision,reason:'Local classifier model is not installed; deterministic and structural detectors remain active.',findings:[],assessments:[],coverage:{characters:0,total_characters:text.length,ratio:0}};
 let classifier;try{classifier=await loadPipeline();}catch{return {status:'unavailable',mode:'rules_only_fallback',model:MODEL_ID,revision:MODEL_REVISION,reason:'Local classifier could not initialize; deterministic and structural detectors remain active.',findings:[],assessments:[],coverage:{characters:0,total_characters:text.length,ratio:0}};}
 const cut=splitByTokenizer(text,classifier.tokenizer,{maxChunks,regions});const results=[];
 try{
  for(let i=0;i<cut.chunks.length;i+=4){
   const batch=cut.chunks.slice(i,i+4),output=await classifier(batch.map(c=>c.text),{top_k:null});
   for(let j=0;j<batch.length;j++){const labels=Array.isArray(output[j])?output[j]:[output[j]];const positive=labels.find(x=>String(x.label).toUpperCase().includes('INJECTION'));const score=Number(positive?.score)||0;const chunk=batch[j];
    results.push({start:chunk.start,end:chunk.end,injection_score:score,decision_threshold:threshold,label:score>=threshold?'INJECTION':'SAFE',token_count:chunk.token_count});
   }
  }
 }catch{return {status:'unavailable',mode:'rules_only_fallback',model:MODEL_ID,revision:MODEL_REVISION,reason:'Local classifier inference failed; deterministic and structural detectors remain active.',findings:[],assessments:[],coverage:{characters:0,total_characters:text.length,ratio:0}};}
 const findings=results.filter(x=>x.injection_score>=threshold).map(x=>({rule_id:'classifier_prompt_injection',severity:'high',confidence:x.injection_score,confidence_note:'Raw DeBERTa softmax score; it is not a calibrated probability.',evidence:text.slice(x.start,Math.min(x.end,x.start+240)),location:{start:x.start,end:x.end},explanation:'The local prompt-injection classifier scored this chunk above the configured threshold.',detector:'local-ml-classifier',model:MODEL_ID,model_revision:MODEL_REVISION,raw_score:x.injection_score,decision_threshold:threshold}));
 const scanned=results.at(-1)?.end||0;
 return {status:cut.truncated?'partial':'available',mode:cut.truncated?'local_classifier_partial':'local_classifier',model:MODEL_ID,revision:MODEL_REVISION,threshold,findings,assessments:results.slice(0,32),coverage:{characters:scanned,total_characters:text.length,ratio:text.length?scanned/text.length:1},limitations:['Classifier is English-focused; assess multilingual inputs separately.','Softmax scores and default threshold are model outputs, not calibrated probabilities.']};
}

export const classifierInternals={splitByTokenizer};
