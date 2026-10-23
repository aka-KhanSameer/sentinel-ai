import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanText } from '../backend/scanner.js';
import { classifyInWorker, shutdownClassifierWorker } from '../backend/classifier-service.js';

export async function evaluateSamples(corpus,{classify=classifyInWorker}={}){
 let tp=0,fp=0,tn=0,fn=0;const categories={},sampleModes=[];
 for(const [index,sample] of corpus.samples.entries()){
  const expected=sample.label==='attack';
  const classifier=await classify(sample.text);
  const structuralEvidence=sample.structural_kind?[{kind:sample.structural_kind,text:sample.text,location:{source:'synthetic evaluation fixture'}}]:[];
  const report=scanText(sample.text,{structuralEvidence,mlFindings:classifier.findings,classifier});
  const detected=report.findings.length>0;
  if(expected&&detected)tp++;else if(expected)fn++;else if(detected)fp++;else tn++;
  const stats=categories[sample.category]??={samples:0,positive:0,detected:0,tp:0,fp:0,tn:0,fn:0};stats.samples++;if(expected)stats.positive++;if(detected)stats.detected++;
  if(expected&&detected)stats.tp++;else if(expected)stats.fn++;else if(detected)stats.fp++;else stats.tn++;
  const actual=report.summary.classifier||{},mode=actual.mode||classifier.mode||'unknown';
  sampleModes.push({sample_id:sample.id||String(index+1),mode,status:actual.status||classifier.status||'unknown',...(actual.reason||classifier.reason?{reason:actual.reason||classifier.reason}:{})});
 }
 const precision=tp/(tp+fp)||0,recall=tp/(tp+fn)||0,modeCounts={};for(const sample of sampleModes)modeCounts[sample.mode]=(modeCounts[sample.mode]||0)+1;
 const modes=Object.keys(modeCounts);
 return {dataset_id:corpus.dataset_id,provenance:corpus.provenance,samples:corpus.samples.length,detector_mode:modes.length===1?modes[0]:modes.length?'mixed':'unknown',detector_mode_counts:modeCounts,sample_modes:sampleModes,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0,false_positive_rate:fp/(fp+tn)||0,false_negative_rate:fn/(fn+tp)||0,confusion:{tp,fp,tn,fn},per_category:categories,warning:'Measured only on this small synthetic held-out corpus. Scores do not estimate real-world performance.'};
}

async function main(){
 const corpus=JSON.parse(await readFile(new URL('../datasets/evaluation.json',import.meta.url),'utf8'));
 try{console.log(JSON.stringify(await evaluateSamples(corpus),null,2));}
 finally{await shutdownClassifierWorker();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
