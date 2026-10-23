import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSamples } from '../scripts/evaluate.js';

test('evaluation reports the classifier mode actually used for each sample and labels mixed runs',async()=>{
 const corpus={dataset_id:'mode-regression',provenance:'synthetic test',samples:[
  {id:'local',category:'benign',label:'benign',text:'ordinary sample one'},
  {id:'fallback',category:'benign',label:'benign',text:'ordinary sample two'},
  {id:'partial',category:'benign',label:'benign',text:'ordinary sample three'},
 ]};
 const results=[
  {status:'available',mode:'local_classifier',findings:[]},
  {status:'unavailable',mode:'rules_only_fallback',reason:'synthetic model initialization failure',findings:[]},
  {status:'partial',mode:'local_classifier_partial',reason:'synthetic inference failure after one batch',findings:[]},
 ];
 const result=await evaluateSamples(corpus,{classify:async()=>results.shift()});
 assert.equal(result.detector_mode,'mixed');
 assert.deepEqual(result.detector_mode_counts,{local_classifier:1,rules_only_fallback:1,local_classifier_partial:1});
 assert.deepEqual(result.sample_modes.map(x=>[x.sample_id,x.mode,x.status]),[
  ['local','local_classifier','available'],['fallback','rules_only_fallback','unavailable'],['partial','local_classifier_partial','partial'],
 ]);
 assert.match(result.sample_modes[1].reason,/initialization failure/);
 assert.match(result.sample_modes[2].reason,/inference failure/);
});

test('evaluation reports one consistent observed mode without inferring from files',async()=>{
 const corpus={dataset_id:'mode-regression',provenance:'synthetic test',samples:[{id:'one',category:'benign',label:'benign',text:'ordinary'}]};
 const result=await evaluateSamples(corpus,{classify:async()=>({status:'unavailable',mode:'rules_only_fallback',reason:'model unavailable',findings:[]})});
 assert.equal(result.detector_mode,'rules_only_fallback');assert.deepEqual(result.detector_mode_counts,{rules_only_fallback:1});assert.equal(result.sample_modes[0].reason,'model unavailable');
});
