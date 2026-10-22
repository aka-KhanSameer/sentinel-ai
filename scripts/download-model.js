import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repo='protectai/deberta-v3-base-prompt-injection-v2';
const revision='90c9989b1a342275dd0d1a95aad283c04e075671';
const files=['LICENSE','config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','added_tokens.json','spm.model','onnx/config.json','onnx/model.onnx'];
const dest=resolve(process.env.SENTINEL_MODEL_DIR||'models/sentinel-deberta-v3-prompt-injection-v2');
const api=`https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`;
async function hashExisting(file,info){const lfsSha=info.lfs?.sha256||info.lfs?.oid?.replace(/^sha256:/,'');const hash=lfsSha?createHash('sha256'):createHash('sha1');if(!lfsSha)hash.update(`blob ${info.size}\0`);for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

const metadataResponse=await fetch(api);if(!metadataResponse.ok)throw Error(`Unable to read pinned model metadata (${metadataResponse.status}).`);
const metadata=await metadataResponse.json();const siblings=new Map(metadata.siblings.map(x=>[x.rfilename,x]));
await mkdir(dest,{recursive:true});
for(const name of files){
 const info=siblings.get(name);if(!info)throw Error(`Pinned repository is missing ${name}.`);
 const target=resolve(dest,name),rel=relative(dest,target);if(rel==='..'||rel.startsWith(`..${sep}`))throw Error('Unsafe model file path.');
 const lfsSha=info.lfs?.sha256||info.lfs?.oid?.replace(/^sha256:/,'');const expected=lfsSha||info.blobId;
 try{if((await stat(target)).size===info.size&&(await hashExisting(target,info))===expected)continue;}catch{}
 await mkdir(dirname(target),{recursive:true});const temp=`${target}.part`;await rm(temp,{force:true});
 const response=await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${name}?download=true`);if(!response.ok||!response.body)throw Error(`Download failed for ${name} (${response.status}).`);
 const sha256=createHash('sha256'),sha1=createHash('sha1').update(`blob ${info.size}\0`);
 const meter=new Transform({transform(chunk,encoding,callback){sha256.update(chunk);sha1.update(chunk);callback(null,chunk);}});
 try{await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(temp,{flags:'wx'}));}catch(error){await rm(temp,{force:true});throw error;}
 const actual=lfsSha?sha256.digest('hex'):sha1.digest('hex');
 if(!expected||actual!==expected){await rm(temp,{force:true});throw Error(`Checksum verification failed for ${name}.`);}
 await (await import('node:fs/promises')).rename(temp,target);
 console.log(`verified ${name} (${info.size} bytes)`);
}
console.log(`Installed ${repo}@${revision} in ${dest}. Model license: Apache-2.0.`);
