import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const revision='87416418657359cb625c412a48b6e1d6d41c29bd';
const sha='bbef4675053b5b468cdb477053e28b1c698ba08e';
const size=4_113_088;
const root=resolve(process.env.TESSERACT_LANG_PATH||'models/tessdata');
const target=resolve(root,'eng.traineddata');
try{if((await stat(target)).size===size){const h=createHash('sha1').update(`blob ${size}\0`);for await(const c of createReadStream(target))h.update(c);if(h.digest('hex')===sha){console.log(`Verified existing English tessdata in ${root}`);process.exit(0);}}}catch{}
await mkdir(dirname(target),{recursive:true});const temp=`${target}.part`;await rm(temp,{force:true});
const response=await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${revision}/eng.traineddata`);if(!response.ok||!response.body)throw Error(`OCR language download failed (${response.status}).`);
const hash=createHash('sha1').update(`blob ${size}\0`),meter=new Transform({transform(chunk,encoding,callback){hash.update(chunk);callback(null,chunk);}});
try{await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(temp,{flags:'wx'}));}catch(error){await rm(temp,{force:true});throw error;}
const actualSize=(await stat(temp)).size;if(actualSize!==size||hash.digest('hex')!==sha){await rm(temp,{force:true});throw Error('OCR language model size or pinned Git blob checksum did not match.');}
await rename(temp,target);console.log(`Installed verified English tessdata (${size} bytes) from tessdata_fast@${revision} in ${root}.`);
