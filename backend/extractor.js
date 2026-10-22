import { inflateRawSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorker as createOcrWorker } from 'tesseract.js';
import sharp from 'sharp';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { scanText, extractText as extractPlain } from './scanner.js';

const LIMITS = Object.freeze({entries:256,expandedBytes:32*1024*1024,ratio:100,pdfPages:100,imagePixels:20_000_000});
const fail=(message,status=422,code='invalid_document')=>Object.assign(new Error(message),{status,code});
function formatFor(buffer,filename,mime){
 if(buffer.length>=5&&buffer.subarray(0,5).toString('ascii')==='%PDF-') return 'pdf';
 if(buffer.length>=4&&buffer.readUInt32LE(0)===0x04034b50) return 'zip';
 if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
 if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255) return 'jpeg';
 if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP') return 'webp';
 const ext=filename.toLowerCase().split('.').pop();
 if(['txt','md','markdown','csv','json','html','xml','eml'].includes(ext)&&!buffer.includes(0))return ext;
 if(mime==='text/plain'&&!buffer.includes(0))return 'txt';
 throw fail('File content does not match a supported format.',415,'unsupported_type');
}
function unzipBounded(buffer){
 const min=Math.max(0,buffer.length-65557);let eocd=-1;
 for(let i=buffer.length-22;i>=min;i--){if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw fail('Malformed ZIP-based document: central directory is missing.');
 if(buffer.readUInt16LE(eocd+4)!==0||buffer.readUInt16LE(eocd+6)!==0)throw fail('Multi-disk ZIP archives are not supported.');
 const count=buffer.readUInt16LE(eocd+10),cdSize=buffer.readUInt32LE(eocd+12),cdOffset=buffer.readUInt32LE(eocd+16);
 if(count===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff||count>LIMITS.entries||cdOffset+cdSize>eocd)throw fail('ZIP archive exceeds supported structure limits.');
 const records=[];let off=cdOffset,total=0;
 for(let i=0;i<count;i++){
  if(off+46>buffer.length||buffer.readUInt32LE(off)!==0x02014b50)throw fail('Malformed ZIP central directory.');
  const flags=buffer.readUInt16LE(off+8),method=buffer.readUInt16LE(off+10),compressed=buffer.readUInt32LE(off+20),expanded=buffer.readUInt32LE(off+24),nameLen=buffer.readUInt16LE(off+28),extraLen=buffer.readUInt16LE(off+30),commentLen=buffer.readUInt16LE(off+32),local=buffer.readUInt32LE(off+42);
  if(flags&1)throw fail('Encrypted documents are not supported.');
  if(method!==0&&method!==8)throw fail('ZIP compression method is not supported.');
  if(compressed===0xffffffff||expanded===0xffffffff||local===0xffffffff)throw fail('ZIP64 archives are not supported.');
  if(off+46+nameLen+extraLen+commentLen>buffer.length)throw fail('Malformed ZIP entry metadata.');
  const name=buffer.toString('utf8',off+46,off+46+nameLen).replace(/\\/g,'/');
  if(name.startsWith('/')||name.split('/').some(part=>part==='..')||name.includes('\0'))throw fail('Unsafe archive path rejected.');
  if(expanded>0&&expanded/Math.max(compressed,1)>LIMITS.ratio)throw fail('ZIP entry compression ratio exceeds the safety limit.',413,'archive_limit');
  total+=expanded;if(total>LIMITS.expandedBytes)throw fail('ZIP expanded size exceeds the safety limit.',413,'archive_limit');
  records.push({name,compressed,expanded,method,local});off+=46+nameLen+extraLen+commentLen;
 }
 if(off!==cdOffset+cdSize)throw fail('ZIP central directory size is inconsistent.');
 const files=new Map();let actualTotal=0;
 for(const rec of records){
  if(rec.name.endsWith('/'))continue;
  if(rec.local+30>cdOffset||buffer.readUInt32LE(rec.local)!==0x04034b50)throw fail('Malformed ZIP local file header.');
  const nameLen=buffer.readUInt16LE(rec.local+26),extraLen=buffer.readUInt16LE(rec.local+28),start=rec.local+30+nameLen+extraLen,end=start+rec.compressed;
  if(start>cdOffset||end>cdOffset)throw fail('Malformed ZIP entry bounds.');
  const source=buffer.subarray(start,end);let data;
  try{data=rec.method===0?Buffer.from(source):inflateRawSync(source,{maxOutputLength:Math.max(1,Math.min(LIMITS.expandedBytes-actualTotal,rec.expanded+1))});}
  catch{throw fail('Malformed or oversized compressed document content.',413,'archive_limit');}
  if(data.length!==rec.expanded)throw fail('ZIP entry length does not match declared size.');
  actualTotal+=data.length;if(actualTotal>LIMITS.expandedBytes)throw fail('ZIP expanded size exceeds the safety limit.',413,'archive_limit');
  files.set(rec.name,data);
 }
 return files;
}
function xmlText(s){return s.replace(/<[^>]*>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function xmlRuns(xml,tag='w:t'){
 const items=[];const re=new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'g');let m;while((m=re.exec(xml)))items.push({text:xmlText(m[1]),offset:m.index});return items;
}
async function parseDocx(buffer){
 const files=unzipBounded(buffer),main=files.get('word/document.xml');if(!main)throw fail('DOCX is missing word/document.xml.');
 let text='';const segments=[],evidence=[];const xml=main.toString('utf8');const paragraphs=xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)||[];
 for(let i=0;i<paragraphs.length;i++){
  const p=paragraphs[i],value=xmlRuns(p).map(x=>x.text).join(''),hidden=/<w:vanish\b|<w:webHidden\b/i.test(p),tiny=/<w:sz\b[^>]*w:val=["'](?:[1-9]|1[0-9])["']/i.test(p);
  const start=text.length;text+=value;if(value)segments.push({start,end:text.length,location:{paragraph:i+1}});
  if(value.trim()&&(hidden||tiny))evidence.push({kind:hidden?'hidden_text':'tiny_text',text:value,location:{paragraph:i+1,start,end:start+value.length}});text+='\n';
 }
 // Include comments, footnotes and endnotes in the scanned payload as separate mapped passages.
 for(const [name,data] of files){if(/^word\/(?:comments|footnotes|endnotes)\.xml$/.test(name)){const value=xmlRuns(data.toString('utf8')).map(x=>x.text).join(' ');if(value){const start=text.length;text+=value+'\n';segments.push({start,end:start+value.length,location:{part:name}});evidence.push({kind:'embedded_text',text:value,location:{part:name,start,end:start+value.length}});}}}
 const raw=await mammoth.extractRawText({buffer});
 if(raw.value.trim()&&!text.trim())text=raw.value;
 return {text,format:'docx',segments,structuralEvidence:evidence,limitations:['DOCX visible paragraphs plus comments, footnotes, endnotes, hidden runs, and tiny runs are inspected; tracked-change, embedded-object, and all style/color semantics are not fully interpreted.']};
}
async function parsePdf(buffer){
 let doc,loadingTask;const diagnostics=[],limitations=['PDF.js supplies text spans, page geometry, basic paint operators, annotations, URI links, Info and accessible XMP metadata. PDF transparency/blending and visual occlusion under later drawings are not reliably established; embedded files and JavaScript actions are not executed. Scanned-page OCR is unavailable.'];
 try{
  loadingTask=pdfjs.getDocument({data:new Uint8Array(buffer),isEvalSupported:false,stopAtErrors:true,maxImageSize:20_000_000,verbosity:0});doc=await loadingTask.promise;
  if(doc.numPages>LIMITS.pdfPages)throw fail('PDF page count exceeds the configured limit.',413,'page_limit');
  let text='',segments=[],analysisRegions=[],spans=[],evidence=[];const pageRegions=new Map();let textItems=0,operatorItems=0,paintedItems=0,annotations=0,metadataFieldCount=0;const stageErrors={page_text:[],paint:[],annotations:[],metadata:[]};
  const pushValue=(value,location,partLabel)=>{if(!value)return null;const label=`[PDF ${partLabel}] `;text+=label;const start=text.length;text+=value+'\n';const end=start+value.length;const loc={...location,start,end};segments.push({start,end,location:loc});spans.push({text:value,start,end,location:loc});analysisRegions.push({start,end,location});return {start,end,location};};
  const normalized=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const getMatrix=value=>{if(Array.isArray(value)||ArrayBuffer.isView(value))return Array.from(value).slice(0,6);if(value&&typeof value==='object')return Object.keys(value).sort((a,b)=>Number(a)-Number(b)).map(k=>value[k]).slice(0,6);return null;};
  const contrast=rgb=>{const lum=rgb.map(v=>{v=v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;return v;}).reduce((a,v,i)=>a+v*[0.2126,0.7152,0.0722][i],0);return 1.05/(lum+0.05);};
  for(let n=1;n<=doc.numPages;n++){
   let page;try{page=await doc.getPage(n);const content=await page.getTextContent({includeMarkedContent:true}),viewport=page.getViewport({scale:1}),pageStart=text.length,items=[],regionStart=analysisRegions.length;let row=null;
    for(const item of content.items){if(typeof item.str!=='string'||!item.str)continue;const start=text.length;text+=item.str+(item.hasEOL?'\n':' ');const fs=Math.abs(item.transform?.[3]||0),x=item.transform?.[4]||0,y=item.transform?.[5]||0,loc={page:n,x:Math.round(x),y:Math.round(y),font_size_pt:fs,bbox:{x,y,width:item.width||0,height:item.height||fs},start,end:start+item.str.length};const span={text:item.str,start,end:start+item.str.length,location:loc,font_name:item.fontName};segments.push({start,end:start+item.str.length,location:loc});spans.push(span);items.push(span);textItems++;
     if(!row||Math.abs(y-row.y)>1){if(row)analysisRegions.push({start:row.start,end:row.end,location:{page:n,y:row.y}});row={start,end:start+item.str.length,y};}else row.end=start+item.str.length;
     if(fs>0&&fs<=7)evidence.push({kind:'tiny_text',text:item.str,location:{...loc}});
     if(x<0||y<0||x+Math.max(0,item.width||0)>viewport.width||y+Math.max(0,item.height||fs)>viewport.height)evidence.push({kind:'off_page_text',text:item.str,location:{...loc,page_width:viewport.width,page_height:viewport.height}});
    }
    if(row)analysisRegions.push({start:row.start,end:row.end,location:{page:n,y:row.y}});
    pageRegions.set(n,analysisRegions.slice(regionStart));

    try{
     const ops=await page.getOperatorList(),names=new Map(Object.entries(pdfjs.OPS).filter(([,v])=>typeof v==='number').map(([k,v])=>[v,k]));let fill=[0,0,0],alpha=1,fontSize=0,textMatrix=null,itemCursor=0;const operatorItemsForPage=[],shapes=[];
     for(let i=0;i<ops.fnArray.length;i++){
      const name=names.get(ops.fnArray[i]),args=ops.argsArray[i]||[];
      if(name==='setFillRGBColor'&&typeof args[0]==='string'){const m=args[0].match(/^#([0-9a-f]{6})$/i);if(m)fill=[0,2,4].map(k=>parseInt(m[1].slice(k,k+2),16)/255);}
      else if(name==='setFillGray'&&Number.isFinite(args[0]))fill=[args[0],args[0],args[0]];
      else if(name==='setFillAlpha'&&Number.isFinite(args[0]))alpha=args[0];
      else if(name==='setFont'&&Number.isFinite(args[1]))fontSize=Math.abs(args[1]);
      else if(name==='setTextMatrix')textMatrix=getMatrix(args[0]);
      if(name==='constructPath'&&[pdfjs.OPS.fill,pdfjs.OPS.eoFill,pdfjs.OPS.fillStroke,pdfjs.OPS.eoFillStroke,pdfjs.OPS.closeFillStroke,pdfjs.OPS.closeEOFillStroke].includes(args[0])){const box=Array.isArray(args[2])||ArrayBuffer.isView(args[2])?Array.from(args[2]):[];if(box.length===4)shapes.push({operator_index:i,bbox:{x:box[0],y:box[1],width:box[2]-box[0],height:box[3]-box[1]},fill_rgb:fill.map(v=>Math.round(v*255)),opacity:alpha});}
      if(!/^(showText|showSpacedText|nextLineShowText|nextLineShowTextWithSpacing)$/.test(name||''))continue;
      const chars=[...args].reverse().find(Array.isArray);if(!chars)continue;const shown=chars.map(c=>typeof c==='object'?(c.unicode||''):String(c)).join('');if(!shown.trim())continue;
      const key=normalized(shown);let matched=null,matchedIndex=-1;
      for(let j=itemCursor;j<items.length;j++){const itemKey=normalized(items[j].text);if(itemKey===key||itemKey.includes(key)||key.includes(itemKey)&&itemKey.length>8){matched=items[j];matchedIndex=j;break;}}
      if(!matched){for(let j=0;j<itemCursor;j++){const itemKey=normalized(items[j].text);if(itemKey===key||itemKey.includes(key)||key.includes(itemKey)&&itemKey.length>8){matched=items[j];matchedIndex=j;break;}}}
      const rgb=fill.map(v=>Math.round(v*255)),loc=matched?.location||{page:n,x:textMatrix?.[4]||0,y:textMatrix?.[5]||0,font_size_pt:fontSize,operator_index:i};
      if(matched){itemCursor=Math.max(itemCursor,matchedIndex);matched.location.fill_rgb=rgb;matched.location.opacity=alpha;matched.location.font_size_pt=fontSize||matched.location.font_size_pt;matched.location.paint_operator=i;paintedItems++;}
      const effectiveFont=fontSize||loc.font_size_pt||0,ratio=contrast(fill);
      if((fill.every(v=>v>=0.94)||alpha<0.95||ratio<4.5)&&matched){const kind=alpha<0.95?'transparent_text':'low_contrast_or_transparent_text';evidence.push({kind,text:matched.text,location:{...matched.location,fill_rgb:rgb,opacity:alpha,contrast_ratio:Number(ratio.toFixed(2))}});}
      if(effectiveFont>0&&effectiveFont<=7&&matched&&!evidence.some(x=>x.kind==='tiny_text'&&x.location.start===matched.start))evidence.push({kind:'tiny_text',text:matched.text,location:{...matched.location,font_size_pt:effectiveFont,fill_rgb:rgb}});
      if(!matched){const x=textMatrix?.[4]||0,y=textMatrix?.[5]||0;const width=chars.reduce((sum,c)=>sum+(Number(c?.width)||0),0)*effectiveFont/1000,operatorLoc={page:n,x,y,font_size_pt:effectiveFont,fill_rgb:rgb,opacity:alpha,operator_index:i,source:'content_operator',bbox:{x,y,width,height:effectiveFont}};const value=pushValue(shown,operatorLoc,`content operator page ${n}`);if(value){operatorItems++;operatorItemsForPage.push({text:shown,location:operatorLoc,start:value.start,end:value.end});if(x<0||y<0||x+width>viewport.width||y+effectiveFont>viewport.height)evidence.push({kind:'off_page_text',text:shown,location:{...operatorLoc,page_width:viewport.width,page_height:viewport.height,start:value.start,end:value.end}});if(effectiveFont>0&&effectiveFont<=7)evidence.push({kind:'tiny_text',text:shown,location:{...operatorLoc,start:value.start,end:value.end}});if(fill.every(v=>v>=0.94)||alpha<0.95||ratio<4.5)evidence.push({kind:alpha<0.95?'transparent_text':'low_contrast_or_transparent_text',text:shown,location:{...operatorLoc,contrast_ratio:Number(ratio.toFixed(2)),start:value.start,end:value.end}});}}
     }
     for(const span of spans.filter(x=>x.location.page===n&&Number.isFinite(x.location.paint_operator))){const b=span.location.bbox;if(!b)continue;const area=Math.max(1,b.width*b.height);for(const shape of shapes){if(shape.operator_index<=span.location.paint_operator||shape.opacity<0.95||!shape.fill_rgb.every(v=>v>=242))continue;const ix=Math.max(0,Math.min(b.x+b.width,shape.bbox.x+shape.bbox.width)-Math.max(b.x,shape.bbox.x)),iy=Math.max(0,Math.min(b.y+b.height,shape.bbox.y+shape.bbox.height)-Math.max(b.y,shape.bbox.y)),coverage=ix*iy/area;if(coverage>=0.8)evidence.push({kind:'occluded_by_later_shape',text:span.text,location:{...span.location,occluder:shape.bbox,occluder_fill_rgb:shape.fill_rgb,occluder_operator:shape.operator_index,paint_order:'shape_after_text',covered_fraction:Number(coverage.toFixed(2))}});}}
     diagnostics.push({stage:'pdf.paint_and_geometry',status:'completed',reason:null,features_inspected:['text paint color','font size','text matrix','span bounding boxes','page bounds','operator-order text recovery','axis-aligned opaque rectangle coverage'],extracted_items:operatorItemsForPage.length,findings:evidence.filter(x=>x.location.page===n).length,errors:[],unsupported_operations:['Non-rectangular paths, complex transforms, blend modes, and partial transparency are not fully analyzed.']});
    }catch(e){stageErrors.paint.push({page:n,message:String(e?.message||e)});diagnostics.push({stage:'pdf.paint_and_geometry',status:'failed',reason:'PDF text paint operator inspection failed for this page; page text extraction and other stages continue.',features_inspected:[],extracted_items:0,findings:0,errors:[String(e?.message||e)],unsupported_operations:[]});}

    try{
     const annots=await page.getAnnotations({intent:'display'});let extracted=0;
     for(const a of annots){annotations++;const base={page:n,annotation_id:a.id,subtype:a.subtype,rect:a.rect||null,flags:a.annotationFlags??null};const candidates=[['contents',a.contentsObj?.str],['title',a.titleObj?.str],['uri',a.unsafeUrl||a.url],['field_value',a.fieldValue],['alternative_text',a.alternativeText]];
      if(a.action!==undefined)candidates.push(['action',typeof a.action==='string'?a.action:JSON.stringify(a.action)]);
      for(const [field,value] of candidates){if(typeof value!=='string'||!value.trim())continue;pushValue(value,{...base,field},`annotation ${a.subtype} ${field} page ${n}`);extracted++;}
     }
     diagnostics.push({stage:'pdf.annotations_and_links',status:'completed',reason:null,features_inspected:['annotation subtype','contents','title','rectangle','flags','URI/unsafe URI','field value','alternative text',...(annots.some(a=>a.action!==undefined)?['exposed action value']:[])],extracted_items:extracted,findings:0,errors:[],unsupported_operations:['Raw PDF action dictionaries not exposed by the selected PDF.js public API are not independently parsed; no action is executed.']});
    }catch(e){stageErrors.annotations.push({page:n,message:String(e?.message||e)});diagnostics.push({stage:'pdf.annotations_and_links',status:'failed',reason:'Annotation extraction failed for this page; other pages and detectors continue.',features_inspected:[],extracted_items:0,findings:0,errors:[String(e?.message||e)],unsupported_operations:[]});}
    page.cleanup();
   }catch(e){stageErrors.page_text.push({page:n,message:String(e?.message||e)});diagnostics.push({stage:'pdf.page_text',status:'failed',reason:'Page text extraction failed; remaining pages continue.',features_inspected:[],extracted_items:0,findings:0,errors:[String(e?.message||e)],unsupported_operations:[]});try{page?.cleanup();}catch{}}
  }
  const mergedRegions=[];for(const region of analysisRegions){const last=mergedRegions.at(-1);if(last&&last.location.page===region.location.page&&Math.abs(last.location.y-region.location.y)<=12.5){last.end=Math.max(last.end,region.end);}else mergedRegions.push({...region,location:{...region.location}});}analysisRegions=mergedRegions;
  // Add a contextual classifier region across each page boundary without removing the
  // original page-local regions or changing source offsets.
  const crossPageRegions=[];for(let n=1;n<doc.numPages;n++){const left=pageRegions.get(n)||[],right=pageRegions.get(n+1)||[];if(left.length&&right.length){const a=left.at(-1),b=right[0];if(b.start>=a.end&&b.start-a.end<4)crossPageRegions.push({start:a.start,end:b.end,location:{pages:[n,n+1],cross_page_context:true}});}}
  analysisRegions.push(...crossPageRegions);
  const info={...(doc._pdfInfo?.info||{})};let metadataObj=null;try{metadataObj=await doc.getMetadata();Object.assign(info,metadataObj.info||{});}catch(e){stageErrors.metadata.push({message:String(e?.message||e)});}
  const fields={};for(const [k,v] of Object.entries(info)){if(k==='Custom')continue;fields[k]=v;}
  const custom=info.Custom;if(custom instanceof Map){for(const [k,v] of custom)fields[k]=v;}else if(custom&&typeof custom==='object'){for(const [k,v] of Object.entries(custom))fields[k]=v;}
  let xmpFields={},xmpAvailable=false;try{const raw=metadataObj?.metadata?.getAll?.();if(raw instanceof Map){xmpFields=Object.fromEntries(raw);xmpAvailable=true;}else if(raw&&typeof raw==='object'){xmpFields=raw;xmpAvailable=true;}}catch(e){stageErrors.metadata.push({message:String(e?.message||e)});}
  for(const [k,v] of Object.entries(xmpFields))fields[`XMP:${k}`]=v;
  const metadataFieldList=[];for(const [field,value] of Object.entries(fields).slice(0,128)){const val=typeof value==='string'?value:typeof value==='number'||typeof value==='boolean'?String(value):'';if(!val.trim())continue;const bounded=val.slice(0,4096);pushValue(bounded,{part:'pdf_metadata',field},`metadata ${field}`);metadataFieldList.push(field);metadataFieldCount++;}
  const metadataStatus=stageErrors.metadata.length?'partial':'completed';diagnostics.push({stage:'pdf.metadata',status:metadataStatus,reason:xmpAvailable?null:'No XMP packet was exposed by PDF.js for this file; Info dictionary inspected.',features_inspected:['all PDF.js Info fields including custom Info Map entries',...(xmpAvailable?['accessible XMP properties']:[])],extracted_items:metadataFieldCount,findings:0,errors:stageErrors.metadata.map(x=>x.message),unsupported_operations:['Encrypted or compressed metadata objects not exposed through PDF.js are not independently decoded.']});
  const textStatus=stageErrors.page_text.length?'partial':'completed';diagnostics.unshift({stage:'pdf.page_text',status:textStatus,reason:stageErrors.page_text.length?'One or more page text extractions failed.':null,features_inspected:['PDF.js text items','page number','text coordinates','font size','width/height geometry','headers and footers retained','table text spans'],extracted_items:textItems,findings:0,errors:stageErrors.page_text.map(x=>`page ${x.page}: ${x.message}`),unsupported_operations:[]});
  if(stageErrors.paint.length||stageErrors.annotations.length)diagnostics.push({stage:'pdf.optional_extraction',status:'partial',reason:'One or more optional page extraction paths failed; successful paths remain available.',features_inspected:[],extracted_items:0,findings:0,errors:[...stageErrors.paint,...stageErrors.annotations].map(x=>`page ${x.page}: ${x.message}`),unsupported_operations:[]});
  const pageEnds=[...pageRegions.entries()].map(([page,regions])=>({page,regions}));for(const evidenceItem of evidence){const seg=segments.find(s=>s.start<=Number(evidenceItem.location.start)&&s.end>=Number(evidenceItem.location.end));if(seg)evidenceItem.location={...seg.location,...evidenceItem.location};}
  const stagesStatus=diagnostics.some(x=>x.status==='failed'||x.status==='partial')?'partial':'completed';
  return {text,format:'pdf',segments,spans,analysisRegions,structuralEvidence:evidence,metadata:{fields:metadataFieldList,info_keys:Object.keys(info).filter(k=>k!=='Custom'),custom_keys:custom instanceof Map?[...custom.keys()]:Object.keys(custom||{}),xmp_available:xmpAvailable},diagnostics,analysis_status:stagesStatus,limitations};
 }catch(e){if(e.status)throw e;throw fail(e?.name==='PasswordException'?'Password-protected PDF files are not supported.':'PDF is malformed, encrypted, or could not be parsed.');}
 finally{if(loadingTask)await loadingTask.destroy().catch(()=>{});}
}
async function parseXlsx(buffer){
 const files=unzipBounded(buffer);if(!files.has('xl/workbook.xml'))throw fail('XLSX workbook structure is missing.');
 const wb=new ExcelJS.Workbook();try{await wb.xlsx.load(buffer,{ignoreNodes:['drawing','picture','table']});}catch{throw fail('XLSX is malformed or uses unsupported features.');}
 let text='',segments=[],evidence=[];
 for(const sheet of wb.worksheets){for(let ri=1;ri<=sheet.rowCount;ri++){const row=sheet.getRow(ri);for(let ci=1;ci<=row.cellCount;ci++){const cell=row.getCell(ci);let v=cell.value;if(v&&typeof v==='object'){if('formula'in v)v=v.formula?`=${v.formula}`:'';else if('text'in v)v=v.text;else if('richText'in v)v=v.richText.map(x=>x.text).join('');else if('result'in v)v=v.result;else v='';}if(v===null||v===undefined||String(v)==='')continue;const s=String(v),start=text.length;text+=s+'\n';const location={sheet:sheet.name,row:ri,column:ci,address:cell.address};segments.push({start,end:start+s.length,location});if(sheet.state!=='visible'||row.hidden||sheet.getColumn(ci).hidden)evidence.push({kind:'hidden_content',text:s,location:{...location,start,end:start+s.length}});}}
 }
 return {text,format:'xlsx',segments,structuralEvidence:evidence,limitations:['Cell values, formulas as text, sheet visibility, and hidden rows/columns are inspected; macros and embedded drawings are not executed or fully inspected.']};
}
function pptxText(buffer){
 const files=unzipBounded(buffer),names=[...files.keys()].filter(n=>/^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(n)).sort();if(!files.has('ppt/presentation.xml'))throw fail('PPTX presentation structure is missing.');
 let text='',segments=[],evidence=[];
 for(const name of names){const xml=files.get(name).toString('utf8'),slide=Number(name.match(/(?:slide|notesSlide)(\d+)/)?.[1]||0);let para=0;
  for(const p of (xml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)||[])){para++;const s=xmlRuns(p,'a:t').map(x=>x.text).join('');if(!s)continue;const start=text.length;text+=s+'\n';const location={slide,paragraph:para,part:name,start,end:start+s.length};segments.push({start,end:start+s.length,location});
   if(/<a:alpha\b[^>]*val=["'](?:0|[1-9]\d{0,3})["']/i.test(p)||/<a:srgbClr\b[^>]*val=["'](?:FFFFFF|FEFEFE|FDFDFD)["']/i.test(p))evidence.push({kind:'low_contrast_or_transparent_text',text:s,location});
   if(/<a:(?:rPr|defRPr)\b[^>]*sz=["'](?:[1-9]\d{0,2}|1000)["']/i.test(p))evidence.push({kind:'tiny_text',text:s,location});
  }
 }
 return {text,format:'pptx',segments,structuralEvidence:evidence,limitations:['Slide and speaker-note text plus simple transparency, white text, and tiny-run indicators are inspected; rendering/layout and all embedded objects are not.']};
}
async function parseImage(buffer,format){
 let image;try{image=sharp(buffer,{limitInputPixels:LIMITS.imagePixels,failOn:'error'});const meta=await image.metadata();if(!meta.width||!meta.height||meta.width*meta.height>LIMITS.imagePixels)throw fail('Image dimensions are invalid or exceed the pixel limit.',413,'image_limit');image=await image.rotate().png().toBuffer();}catch(e){if(e.status)throw e;throw fail('Image data is malformed or exceeds the pixel-processing limit.',422,'invalid_image');}
 const info=await sharp(image,{limitInputPixels:LIMITS.imagePixels}).metadata(),dimensions={width:info.width,height:info.height},dir=process.env.TESSERACT_LANG_PATH||resolve('models/tessdata'),lang=process.env.TESSERACT_LANG||'eng';
 if(!dir||!existsSync(`${dir}/${lang}.traineddata`))throw fail('OCR language data is not configured locally. Set TESSERACT_LANG_PATH and TESSERACT_LANG; no OCR result was produced.',503,'ocr_unavailable');
 let worker;try{worker=await createOcrWorker(lang,1,{langPath:dir,gzip:false,cacheMethod:'none',logger:()=>{}});const {data}=await worker.recognize(image,{}, {blocks:true});const text=data.text||'',segments=[];let cursor=0;for(const block of data.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[])for(const word of line.words||[]){const wordText=word.text||'';const start=text.indexOf(wordText,cursor);if(start>=0){segments.push({start,end:start+wordText.length,location:{bbox:word.bbox,confidence:word.confidence}});cursor=start+wordText.length;}}
  return {text,format,segments,structuralEvidence:[],limitations:['OCR uses the configured local Tesseract language model. Text recognition may miss content and confidence is not calibrated for injection detection.'],ocr:{engine:'tesseract.js',language:lang,width:dimensions.width,height:dimensions.height,mean_confidence:data.confidence}};
 }catch(e){if(e.status)throw e;throw fail('Image OCR failed; no clean scan result was created.',503,'ocr_failed');}finally{if(worker)await worker.terminate().catch(()=>{});}
}
export async function parseDocument(buffer,filename='upload.bin',mime='application/octet-stream'){
 if(!Buffer.isBuffer(buffer))buffer=Buffer.from(buffer);const format=formatFor(buffer,filename,mime);
 if(format==='pdf')return parsePdf(buffer);
 if(format==='zip'){
  const files=unzipBounded(buffer);
  if(files.has('word/document.xml'))return parseDocx(buffer);
  if(files.has('xl/workbook.xml'))return parseXlsx(buffer);
  if(files.has('ppt/presentation.xml'))return pptxText(buffer);
  throw fail('ZIP file is not a supported Office document. Archive inspection is disabled.');
 }
 if(['png','jpeg','webp'].includes(format))return parseImage(buffer,format);
 const ext=format==='markdown'?'md':format;const parsed=extractPlain(buffer,`upload.${ext}`,mime);
 return {...parsed,segments:[],structuralEvidence:[],limitations:[]};
}
export { LIMITS as PARSER_LIMITS };
