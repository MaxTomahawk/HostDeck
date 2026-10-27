import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { DocumentAdapter, checkOfficeArchive } from '../documents.js';
import { requireSafeOfficeXml } from '../office-xml.js';
import { pizzipPackage } from '../../utils/files/docx.js';
import { exceljsPackage } from '../../utils/files/excel.js';
import type { DocumentCoverage, FullTextBudgets, FullTextFormat } from './types.js';

const textFormats = new Set<FullTextFormat>(['.txt','.md','.csv','.json']);
const fullTextFormats = new Set<FullTextFormat>(['.txt','.md','.csv','.json','.docx','.xlsx','.pdf']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCUMENT_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOCX_TARGETS: Record<string,{file:RegExp;root:string}> = {
  header: {file:/^header[1-9][0-9]*\.xml$/,root:'hdr'},
  footer: {file:/^footer[1-9][0-9]*\.xml$/,root:'ftr'},
  footnotes: {file:/^footnotes\.xml$/,root:'footnotes'},
  endnotes: {file:/^endnotes\.xml$/,root:'endnotes'},
  comments: {file:/^comments\.xml$/,root:'comments'},
};

export interface ExtractedDocument {
  status: DocumentCoverage;
  format: FullTextFormat;
  bytes: number;
  sha256: string;
  /** Only content actually qualified by the local extractors. */
  text?: string;
  /** 'indexed' is not a declaration of complete Office/visual recall. */
  coverage?: 'partial';
  /** Specific known gaps, not inferred model or OCR quality. */
  limitations?: string[];
}

function checkedText(value: string, budgets: FullTextBudgets): string {
  if (value.length > budgets.maxTextCharacters) throw new Error('FULLTEXT_TEXT_LIMIT');
  if (!value.trim()) throw new Error('FULLTEXT_OCR_REQUIRED');
  if (value.includes('\0')) throw new Error('FULLTEXT_BINARY_TEXT');
  return value.normalize('NFC');
}

class BoundedText {
  private readonly fragments:string[]=[];
  private length=0;
  constructor(private readonly maximum:number){}
  append(value:string):void {
    this.length += value.length;
    if (this.length>this.maximum) throw new Error('FULLTEXT_TEXT_LIMIT');
    this.fragments.push(value);
  }
  value():string{return this.fragments.join('');}
}

interface XmlPart { path:string;root:string; }
function assertNoExternalXml(xml:string):void {
  // Explicitly reject entities/DTD even when an Office parser would ignore them.
  requireSafeOfficeXml(xml);
}
function extractWordText(xml:string,expectedRoot:string,out:BoundedText,gaps:Set<string>):void {
  assertNoExternalXml(xml);
  const parser=new SaxesParser<{xmlns:true}>({xmlns:true});
  const stack:Array<{uri:string;local:string}>=[];
  let paragraphDepth=0, seenRoot=false;
  const deleted=new Set(['del','moveFrom','delText']);
  function suppressed():boolean {
    return stack.some(t=>t.uri===WORD_NS && deleted.has(t.local)) ||
      stack.some(t=>t.local==='AlternateContent' && t.uri==='http://schemas.openxmlformats.org/markup-compatibility/2006');
  }
  parser.on('doctype',()=>{throw new Error('DOCUMENT_UNSAFE_XML');});
  parser.on('processinginstruction',tag=>{
    if(tag.target.toLowerCase()!=='xml')throw new Error('DOCUMENT_UNSAFE_XML');
  });
  parser.on('error',()=>{throw new Error('FULLTEXT_INVALID_WORD_XML');});
  parser.on('opentag',tag=>{
    const current={uri:tag.uri,local:tag.local};
    if(!stack.length){
      if(seenRoot || tag.uri!==WORD_NS || tag.local!==expectedRoot)throw new Error('FULLTEXT_UNQUALIFIED_WORD_PART');
      seenRoot=true;
    }
    if(tag.prefix==='w' && tag.uri!==WORD_NS)throw new Error('FULLTEXT_UNQUALIFIED_WORD_NAMESPACE');
    if(tag.uri===WORD_NS){
      if(tag.local==='p')paragraphDepth++;
      if(['drawing','pict','object','fldChar','fldSimple','instrText'].includes(tag.local))
        gaps.add('docx_drawings_or_field_values_unqualified');
      if(['hyperlink','sdt'].includes(tag.local))
        gaps.add('docx_layout_and_field_rendering_not_verified');
      if(paragraphDepth && !suppressed() && (tag.local==='tab'||tag.local==='br'||tag.local==='cr'))
        out.append(tag.local==='tab'?'\t':'\n');
    } else if(tag.local==='AlternateContent'){
      gaps.add('docx_alternate_content_not_covered');
    }
    stack.push(current);
  });
  parser.on('text',value=>{
    const top=stack[stack.length-1];
    if(paragraphDepth>0 && top?.uri===WORD_NS && top.local==='t' && !suppressed())out.append(value);
  });
  parser.on('closetag',tag=>{
    if(tag.uri===WORD_NS && tag.local==='p'){
      if(paragraphDepth<1)throw new Error('FULLTEXT_INVALID_WORD_XML');
      paragraphDepth--;
      out.append('\n');
    }
    stack.pop();
  });
  parser.write(xml).close();
  if(!seenRoot || stack.length || paragraphDepth)throw new Error('FULLTEXT_INVALID_WORD_XML');
}

function relatedWordParts(zip:InstanceType<ReturnType<typeof pizzipPackage.load>>, gaps:Set<string>):XmlPart[] {
  const relations=zip.file('word/_rels/document.xml.rels');
  const selected=new Map<string,string>();
  if(relations){
    const xml=relations.asText();
    assertNoExternalXml(xml);
    const parser=new SaxesParser<{xmlns:true}>({xmlns:true});
    let rootSeen=false,depth=0;
    parser.on('doctype',()=>{throw new Error('DOCUMENT_UNSAFE_XML');});
    parser.on('error',()=>{throw new Error('FULLTEXT_INVALID_RELATIONSHIPS');});
    parser.on('opentag',tag=>{
      if(depth++===0){
        if(rootSeen || tag.uri!==PACKAGE_REL_NS || tag.local!=='Relationships')
          throw new Error('FULLTEXT_INVALID_RELATIONSHIPS');
        rootSeen=true;
      }
      if(tag.uri!==PACKAGE_REL_NS || tag.local!=='Relationship')return;
      const type=tag.attributes.Type?.value;
      if(typeof type!=='string'||!type.startsWith(DOCUMENT_REL_NS+'/'))return;
      const kind=type.slice(DOCUMENT_REL_NS.length+1);
      const allowed=DOCX_TARGETS[kind];
      if(!allowed)return; // images/styles/hyperlinks are not text part relationships
      const target=tag.attributes.Target?.value;
      const mode=tag.attributes.TargetMode?.value;
      if(mode && mode!=='Internal'){gaps.add('docx_external_related_parts_not_indexed');return;}
      if(typeof target!=='string' || !allowed.file.test(target)){
        gaps.add('docx_unqualified_relationship_target');return;
      }
      selected.set('word/'+target,allowed.root);
    });
    parser.on('closetag',()=>{depth--;});
    parser.write(xml).close();
    if(!rootSeen||depth)throw new Error('FULLTEXT_INVALID_RELATIONSHIPS');
  }
  const found:XmlPart[]=[];
  for(const [name,root] of selected){
    if(!zip.file(name))throw new Error('FULLTEXT_MISSING_RELATED_WORD_PART');
    found.push({path:name,root});
  }
  // Orphaned text-bearing parts must not be indexed as if referenced/visible.
  // A strict coverage note is preferable to including unrelated content.
  for(const name of Object.keys(zip.files)){
    if(/^word\/(?:header[0-9]+|footer[0-9]+|footnotes|endnotes|comments)\.xml$/.test(name) &&
       !selected.has(name))gaps.add('docx_unlinked_text_parts_not_indexed');
  }
  return found.sort((a,b)=>a.path.localeCompare(b.path));
}

function parseDocx(input:Buffer,budgets:FullTextBudgets):{text:string;limitations:string[]} {
  // checkOfficeArchive already validated ZIP central directory, expansion
  // limits, every .xml/.rels byte count and all DTD/entity declarations.
  const zip=new (pizzipPackage.load())(input);
  const gaps=new Set<string>(['docx_nontext_or_unqualified_parts_not_covered']);
  const out=new BoundedText(budgets.maxTextCharacters);
  const body=zip.file('word/document.xml');
  if(!body)throw new Error('FULLTEXT_UNQUALIFIED_WORD_PART');
  extractWordText(body.asText(),'document',out,gaps);
  for(const selected of relatedWordParts(zip,gaps)){
    out.append('\n[Word part: '+selected.path+']\n');
    extractWordText(zip.file(selected.path)!.asText(),selected.root,out,gaps);
  }
  return {text:out.value(),limitations:[...gaps].sort()};
}

function safePrimitive(value:unknown):string|undefined {
  if(typeof value==='string'||typeof value==='boolean')return String(value);
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  return undefined;
}
function textOfNote(note:unknown):string|undefined {
  if(typeof note==='string')return note;
  if(!note || typeof note!=='object')return undefined;
  const fragments=(note as {texts?:unknown}).texts;
  if(!Array.isArray(fragments) || fragments.length>10000)return undefined;
  const pieces:string[]=[];
  for(const value of fragments){
    const text=(value as {text?:unknown}|null)?.text;
    if(typeof text!=='string')return undefined;
    pieces.push(text);
  }
  return pieces.join('');
}
function cellStrings(value:unknown,gaps:Set<string>):string[] {
  const primitive=safePrimitive(value);
  if(primitive!==undefined)return [primitive];
  if(value===null||value===undefined)return [];
  if(value instanceof Date){
    if(!Number.isFinite(value.getTime())){gaps.add('xlsx_date_invalid');return [];}
    gaps.add('xlsx_date_is_parsed_iso_not_display_format');
    return ['Parsed date (ExcelJS ISO, not display format): '+value.toISOString()];
  }
  if(typeof value!=='object'){gaps.add('xlsx_unsupported_cell_value');return [];}
  const v=value as {formula?:unknown;sharedFormula?:unknown;result?:unknown;
    richText?:unknown;text?:unknown;hyperlink?:unknown};
  if(v.formula!==undefined || v.sharedFormula!==undefined){
    const result:string[]=[];
    if(typeof v.formula==='string'&&v.formula.length<=4096)
      result.push('Formula source: ='+v.formula);
    else if(typeof v.sharedFormula==='string'&&v.sharedFormula.length<=128){
      result.push('Shared formula reference (not expanded): '+v.sharedFormula);
      gaps.add('xlsx_shared_formula_source_not_resolved');
    } else gaps.add('xlsx_formula_source_unsupported');
    const cache=safePrimitive(v.result);
    if(cache!==undefined){
      result.push('Cached result (not calculated): '+cache);
      gaps.add('xlsx_cached_formula_freshness_unverified');
    } else gaps.add('formula_cache_missing');
    return result;
  }
  if(Array.isArray(v.richText)){
    if(v.richText.length>10000 || v.richText.some(item=>typeof item!=='object'||item===null||
      typeof (item as {text?:unknown}).text!=='string')){
      gaps.add('xlsx_richtext_unqualified');return [];
    }
    gaps.add('xlsx_richtext_styling_not_indexed');
    return [v.richText.map(item=>(item as {text:string}).text).join('')];
  }
  if(v.text!==undefined || v.hyperlink!==undefined){
    const result:string[]=[];
    if(typeof v.text==='string')result.push('Hyperlink label: '+v.text);
    else gaps.add('xlsx_hyperlink_label_missing');
    if(typeof v.hyperlink==='string'&&v.hyperlink.length<=4096)
      result.push('Hyperlink URL (not visited): '+v.hyperlink);
    else if(v.hyperlink!==undefined)gaps.add('xlsx_hyperlink_target_unqualified');
    gaps.add('xlsx_hyperlink_not_resolved');
    return result;
  }
  gaps.add('xlsx_unsupported_cell_value');
  return [];
}

async function parseXlsx(input:Buffer,budgets:FullTextBudgets):Promise<{text:string;limitations:string[];cells:number}>{
  // The shared Office validator checked ZIP traversal/expansion limits.
  // Additional XML checks below are read-only and scoped to fulltext, not edits.
  const zip=new (pizzipPackage.load())(input);
  let xmlTotal=0;
  for(const [name,entry] of Object.entries(zip.files)){
    if(entry.dir || !/\.(?:xml|rels)$/i.test(name))continue;
    const xml=entry.asText();
    xmlTotal+=Buffer.byteLength(xml);
    if(xmlTotal>24*1024*1024)throw new Error('DOCUMENT_ARCHIVE_EXPANSION_LIMIT');
    assertNoExternalXml(xml);
  }
  const workbook=new (exceljsPackage.load().Workbook)();
  await workbook.xlsx.load(Uint8Array.from(input).buffer);
  const out=new BoundedText(budgets.maxTextCharacters);
  const gaps=new Set<string>(['xlsx_display_and_noncell_parts_not_verified']);
  let cells=0,seen=0;
  for(const sheet of workbook.worksheets){
    seen++;
    if(seen>64)throw new Error('FULLTEXT_TEXT_LIMIT');
    out.append('Sheet: '+sheet.name+'\n');
    sheet.eachRow({includeEmpty:false},row=>{
      row.eachCell({includeEmpty:false},cell=>{
        cells++;
        if(cells>50000)throw new Error('FULLTEXT_TEXT_LIMIT');
        const values=cellStrings(cell.value,gaps);
        const note=cell.note;
        if(note!==undefined&&note!==null){
          const comment=textOfNote(note);
          if(comment===undefined)gaps.add('xlsx_comment_unqualified');
          else {values.push('Comment text: '+comment);gaps.add('xlsx_comment_author_and_layout_unverified');}
        }
        if(values.length)out.append(cell.address+': '+values.join(' | ')+'\n');
      });
    });
  }
  return {text:out.value(),limitations:[...gaps].sort(),cells};
}

/**
 * Bounded, source-backed extraction. Full-text indexes qualified text layers,
 * never inferred Office visual content, formula calculations or PDF OCR.
 */
export async function extractDocument(file:string,root:string,budgets:FullTextBudgets):Promise<ExtractedDocument>{
  const format=path.extname(file).toLowerCase() as FullTextFormat;
  if(!fullTextFormats.has(format))throw new Error('FULLTEXT_FORMAT_UNSUPPORTED');
  const stat=await fs.stat(file);
  if(!stat.isFile())throw new Error('FULLTEXT_NOT_FILE');
  if(stat.size>budgets.maxFileBytes)return {status:'size_limit',format,bytes:stat.size,sha256:''};
  const input=await fs.readFile(file);
  if(input.length>budgets.maxFileBytes)throw new Error('FULLTEXT_SOURCE_SIZE_CHANGED');
  const sha256=createHash('sha256').update(input).digest('hex');
  const base={format,bytes:input.length,sha256};
  let text:string,limitations:string[]|undefined;
  try{
    if(textFormats.has(format)){
      try{text=utf8.decode(input);}
      catch{return {...base,status:'invalid_utf8'};}
    }else if(format==='.docx'||format==='.xlsx'){
      const verified=await checkOfficeArchive(file,format);
      if(!verified.equals(input))throw new Error('FULLTEXT_SOURCE_CHANGED');
      if(format==='.docx'){
        const found=parseDocx(verified,budgets);
        text=found.text;limitations=found.limitations;
      }else{
        const found=await parseXlsx(verified,budgets);
        text=found.text;limitations=found.limitations;
        if(found.cells===0)return {...base,status:'unsupported_office_value',coverage:'partial',limitations};
      }
    }else{
      const document=await DocumentAdapter.create({workspace:root});
      const response=await document.handle('hostdeck_read_document',{path:file}) as {
        content?:unknown;metadata?:Record<string,unknown>;
      };
      if(!Array.isArray(response.content) || response.content.some(
        part=>!part||typeof part!=='object'||typeof (part as {text?:unknown}).text!=='string'))
        throw new Error('FULLTEXT_UNQUALIFIED_PDF_RESULT');
      text=(response.content as Array<{text:string}>).map(part=>part.text).join('\n');
      if(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(text))
        return {...base,status:'pdf_rtl_unqualified'};
      if(!text.trim())return {...base,status:'ocr_required'};
    }
    text=checkedText(text,budgets);
    const current=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if(current!==sha256)throw new Error('FULLTEXT_SOURCE_CHANGED');
    return {...base,status:'indexed',text,
      ...((format==='.docx'||format==='.xlsx')?{coverage:'partial' as const,limitations}: {})};
  }catch(error){
    const code=error instanceof Error?error.message:'';
    if(code==='FULLTEXT_SOURCE_CHANGED')throw error;
    if(code==='FULLTEXT_TEXT_LIMIT')return {...base,status:'text_limit'};
    if(code==='FULLTEXT_OCR_REQUIRED')return {...base,status:'ocr_required'};
    if(code==='FULLTEXT_UNSUPPORTED_OFFICE_VALUE'||code==='FULLTEXT_UNQUALIFIED_OFFICE_RESULT')
      return {...base,status:'unsupported_office_value'};
    return {...base,status:'extraction_failed'};
  }
}
