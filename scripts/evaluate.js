import { readFile } from 'node:fs/promises';
import { scanText } from '../backend/scanner.js';
import { classifyInWorker, shutdownClassifierWorker } from '../backend/classifier-service.js';
import { getClassifierStatus } from '../backend/classifier.js';

const corpus=JSON.parse(await readFile(new URL('../datasets/evaluation.json',import.meta.url),'utf8'));
let tp=0,fp=0,tn=0,fn=0;const categories={};
for(const sample of corpus.samples){
 const expected=sample.label==='attack';
 const classifier=await classifyInWorker(sample.text);
 const structuralEvidence=sample.structural_kind?[{kind:sample.structural_kind,text:sample.text,location:{source:'synthetic evaluation fixture'}}]:[];
 const report=scanText(sample.text,{structuralEvidence,mlFindings:classifier.findings,classifier});
 const detected=report.findings.length>0;
 if(expected&&detected)tp++;else if(expected)fn++;else if(detected)fp++;else tn++;
 const stats=categories[sample.category]??={samples:0,positive:0,detected:0,tp:0,fp:0,tn:0,fn:0};stats.samples++;if(expected)stats.positive++;if(detected)stats.detected++;
 if(expected&&detected)stats.tp++;else if(expected)stats.fn++;else if(detected)stats.fp++;else stats.tn++;
}
const precision=tp/(tp+fp)||0,recall=tp/(tp+fn)||0;
console.log(JSON.stringify({dataset_id:corpus.dataset_id,provenance:corpus.provenance,samples:corpus.samples.length,detector_mode:getClassifierStatus().missing.length?'rules_only_fallback':'local_classifier',precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0,false_positive_rate:fp/(fp+tn)||0,false_negative_rate:fn/(fn+tp)||0,confusion:{tp,fp,tn,fn},per_category:categories,warning:'Measured only on this small synthetic held-out corpus. Scores do not estimate real-world performance.'},null,2));
await shutdownClassifierWorker();

