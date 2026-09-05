'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const vm = require('vm');
const F = require('./fixtures.js');
const results = [];
async function check(name, fn, confirmedDefect = false) {
  try { results.push({name, status:confirmedDefect ? 'BUG_REPRODUCED':'PASS', details:await fn() ?? null}); }
  catch(e) { results.push({name, status:'FAIL', error:e.stack}); }
}
function mcpFixture() {
  const prefs = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(F.root,'prefs.js'),'utf8'),{pref:(k,v)=>prefs.set(k,v)});
  const items = new Map(), saveLog = [];
  let approved = true, promptCalls = 0;
  const c = F.context({
    MAX_SIMILAR_QUERY_CHUNKS:20, WIKI_EVIDENCE_MIN_EXCERPT_CHARS:24, DEFAULT_DOCUMENT_CHUNKS_PER_PAGE:8,
    MAX_DOCUMENT_CHUNKS_PER_PAGE:20,MAX_SEARCH_INDEX_BUILD_ITEMS:100,MAX_HYBRID_KEYWORDS:16,MAX_SUPPLIED_KEYWORDS:16,
    DEFAULT_ATTACHMENT_TEXT_WINDOW:4000,MAX_ATTACHMENT_TEXT_WINDOW:20000,
    config:{addonVersion:'3.1.0'}, Services:{prompt:{confirm(){promptCalls++;return approved;}}},
    Zotero:{debug(){},logError(){},getMainWindow:()=>({}),DataDirectory:{dir:'/test-data'},
      Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},Libraries:{userLibraryID:1},
      CreatorTypes:{getName:()=> 'author'},
      Items:{getByLibraryAndKeyAsync:async(lib,key)=>items.get(`${lib}:${key}`) || false}}
  });
  for (const mod of ['src/modules/requestCancellation.ts','src/modules/hybridSearchPages.ts','src/modules/mcpTransport.ts','src/utils/privacy.ts','src/modules/wiki/wikiSettings.ts','src/modules/toolCatalog.ts']) F.run(c,F.section(mod));
  const start=F.source.indexOf('  // src/modules/streamableMCPServer.ts');
  F.run(c,F.source.slice(start,F.source.indexOf('\n  // node_modules/',start)));
  F.run(c,'init_streamableMCPServer();');
  const s = new c.StreamableMCPServer();
  function makeItem(key='PAPER001') {
    const item={key,libraryID:1,itemType:'journalArticle',fields:{title:'Original title'},tags:['existing'],creators:[],persisted:{title:'Original title'},
      isRegularItem:()=>true,isNote:()=>false,isAttachment:()=>false,
      getField(n) { if (!['title','abstractNote','date'].includes(n)) throw Error(`Invalid field '${n}'`); return this.fields[n] || ''; },
      setField(n,v) { if (!['title','abstractNote','date'].includes(n)) throw Error(`Invalid field '${n}'`); this.fields[n]=v; },
      getCreators(){return this.creators;},setCreators(v){this.creators=v;},
      getTags(){return this.tags.map(tag=>({tag}));},addTag(v){if(!this.tags.includes(v))this.tags.push(v);},removeTag(v){this.tags=this.tags.filter(t=>t!==v);},
      async saveTx(){this.persisted={...this.fields};saveLog.push({fields:{...this.fields},tags:[...this.tags]});}
    };
    items.set(`1:${key}`,item);return item;
  }
  async function rpc(name,args) {
    const response = await s.handleMCPRequest(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));
    const body=JSON.parse(response.body);return body;
  }
  return {c,s,prefs,items,saveLog,makeItem,rpc,setApproval:v=>approved=v,get promptCalls(){return promptCalls;},enableWrites(){prefs.set('extensions.zotero.zotero-lit-synapse.write.enabled',true);}};
}
(async()=>{
  await check('Metadata: valid approved write changes requested title once',async()=>{
    const f=mcpFixture();f.enableWrites();const i=f.makeItem();const r=await f.rpc('write_metadata',{itemKey:i.key,fields:{title:'New title'}});
    assert.ok(!r.result.isError,JSON.stringify(r));assert.equal(i.persisted.title,'New title');assert.equal(f.saveLog.length,1);
  });
  await check('Metadata: write disabled prevents even in-memory changes',async()=>{
    const f=mcpFixture(),i=f.makeItem();const r=await f.rpc('write_metadata',{itemKey:i.key,fields:{title:'New title'}});
    assert.equal(r.result.isError,true);assert.equal(i.fields.title,'Original title');assert.equal(f.saveLog.length,0);
  });
  await check('Metadata: refusal prevents even in-memory changes',async()=>{
    const f=mcpFixture();f.enableWrites();f.setApproval(false);const i=f.makeItem();const r=await f.rpc('write_metadata',{itemKey:i.key,fields:{title:'New title'}});
    assert.equal(r.result.isError,true);assert.equal(i.fields.title,'Original title');assert.equal(f.saveLog.length,0);
  });
  await check('Metadata: non-string values are rejected before changes',async()=>{
    const f=mcpFixture();f.enableWrites();const i=f.makeItem();const r=await f.rpc('write_metadata',{itemKey:i.key,fields:{title:'New title',date:2026}});
    assert.equal(r.result.isError,true);assert.equal(i.fields.title,'Original title');assert.equal(f.saveLog.length,0);
  });
  await check('D1: rejected multi-field metadata write contaminates cached item and later tag save persists it',async()=>{
    const f=mcpFixture();f.enableWrites();const i=f.makeItem();const r=await f.rpc('write_metadata',{itemKey:i.key,fields:{title:'Uncommitted title',notARealField:'bad'}});
    assert.equal(r.result.isError,true);assert.equal(f.saveLog.length,0);assert.equal(i.persisted.title,'Original title');assert.equal(i.fields.title,'Uncommitted title');
    const r2=await f.rpc('write_tag',{action:'add',itemKey:i.key,tags:['reviewed']});
    assert.ok(!r2.result.isError,JSON.stringify(r2));assert.equal(i.persisted.title,'Uncommitted title');
    return {metadataCallReportedError:true,immediateDatabaseWrite:false,cachedTitleAfterError:'Uncommitted title',laterAction:'add tag only',persistedTitleAfterTag:i.persisted.title,saveCount:f.saveLog.length};
  },true);
  await check('Tags: malformed tag string is rejected without removing old tags',async()=>{
    const f=mcpFixture();f.enableWrites();const i=f.makeItem();const r=await f.rpc('write_tag',{action:'set',itemKey:i.key,tags:'reviewed'});
    assert.equal(r.result.isError,true);assert.deepEqual(i.tags,['existing']);assert.equal(f.saveLog.length,0);
  });
  await check('File import: disabled file-import gate refuses an approved write',async()=>{
    const f=mcpFixture();f.enableWrites();const r=await f.rpc('write_item',{action:'import',filePath:'/tmp/example.pdf',parentItemKey:'PAPER001'});
    assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/import.*disabled|allowFileImport/i);
  });
  await check('MinerU: sequential suppression state updates preserve both identities',async()=>{
    const f=F.minerFixture();await f.s.suppressAutomaticMarkdown(1,'SOURCE01');await f.s.suppressAutomaticMarkdown(1,'SOURCE02');
    const state=JSON.parse(f.disk.get(f.s.getAttachmentStatePath()));assert.ok(state.suppressed['1:SOURCE01']);assert.ok(state.suppressed['1:SOURCE02']);
  });
  await check('D2a: one transient state-file write error prevents all subsequent state writes in same service',async()=>{
    const f=F.minerFixture(),original=f.c.IOUtils.writeUTF8;let calls=0;
    f.c.IOUtils.writeUTF8=async(p,s)=>{calls++;if(calls===1)throw Error('SIMULATED_TRANSIENT_IO_ERROR');return original(p,s);};
    await assert.rejects(()=>f.s.suppressAutomaticMarkdown(1,'SOURCE01'),/SIMULATED_TRANSIENT_IO_ERROR/);
    await assert.rejects(()=>f.s.suppressAutomaticMarkdown(1,'SOURCE02'),/SIMULATED_TRANSIENT_IO_ERROR/);
    await assert.rejects(()=>f.s.allowAutomaticMarkdown(1,'SOURCE01'),/SIMULATED_TRANSIENT_IO_ERROR/);
    assert.equal(calls,1);assert.equal(f.disk.has(f.s.getAttachmentStatePath()),false);
    const g=F.minerFixture(),originalG=g.c.IOUtils.writeUTF8;let totalIO=0;
    g.c.IOUtils.writeUTF8=async(p,s)=>{totalIO++;if(totalIO===1)throw Error('SIMULATED_TRANSIENT_IO_ERROR');return originalG(p,s);};
    await assert.rejects(()=>g.s.suppressAutomaticMarkdown(1,g.a.key),/SIMULATED_TRANSIENT_IO_ERROR/);
    await assert.rejects(()=>g.s.getMarkdownForAttachment(g.a,{force:true,allowParse:true,userInitiated:true}),/SIMULATED_TRANSIENT_IO_ERROR/);
    assert.equal(g.imports.length,1);assert.match(g.imports[0].markdown,/Paper A/);
    const meta=await g.s.readMeta(g.a.key);assert.match(meta.error,/SIMULATED_TRANSIENT_IO_ERROR/);
    return {injectedIOFailures:1,totalLaterStateOperations:2,actualStateWriteAttempts:calls,stateFilePersisted:false,ioWouldSucceedOnRetry:true,publicParseCase:{markdownCreated:true,parseReportedError:true,failureCacheWritten:true,totalWriteCalls:totalIO}};
  },true);
  await check('D2b: concurrent reads of missing Markdown on a fresh service lose one same-library suppression',async()=>{
    const f=F.minerFixture();f.b.key='OTHERKEY';f.b.libraryID=1;
    const secondParent=await f.c.Zotero.Items.getAsync(f.b.parentItemID);secondParent.libraryID=1;
    await f.s.getMarkdownForAttachment(f.a,{force:true,allowParse:true,userInitiated:true});
    await f.s.getMarkdownForAttachment(f.b,{force:true,allowParse:true,userInitiated:true});
    (await f.c.Zotero.Items.getAsync(11)).children=[];secondParent.children=[];
    const fresh=new f.c.MinerUService();
    const outputs=await Promise.all([fresh.getMarkdownForAttachment(f.a,{allowParse:false}),fresh.getMarkdownForAttachment(f.b,{allowParse:false})]);
    assert.deepEqual(outputs,[null,null]);
    const state=JSON.parse(f.disk.get(fresh.getAttachmentStatePath()));
    assert.equal(Object.keys(state.suppressed).length,1);assert.equal(Boolean(state.suppressed['1:SAMEKEY1']),false);assert.ok(state.suppressed['1:OTHERKEY']);
    return {publicEntryPoint:'getMarkdownForAttachment',requestedSuppressions:['1:SAMEKEY1','1:OTHERKEY'],persistedSuppressions:Object.keys(state.suppressed),sameLibrary:true,differentAttachmentKeys:true,noIOError:true};
  },true);
  await check('MinerU: preloaded shared state preserves concurrent suppression updates',async()=>{
    const f=F.minerFixture();await f.s.readAttachmentState();
    await Promise.all([f.s.suppressAutomaticMarkdown(1,'SOURCE01'),f.s.suppressAutomaticMarkdown(1,'SOURCE02')]);
    const state=JSON.parse(f.disk.get(f.s.getAttachmentStatePath()));assert.equal(Object.keys(state.suppressed).length,2);
  });
  await check('MinerU: first parse generates readable attached Markdown',async()=>{
    const f=F.minerFixture();const r=await f.s.getMarkdownForAttachment(f.a,{force:true,allowParse:true,userInitiated:true});
    assert.match(r,/Paper A/);assert.equal(f.imports.length,1);
  });
  await check('MinerU: replacing Markdown keeps old attachment if importing replacement fails',async()=>{
    const f=F.minerFixture();await f.s.getMarkdownForAttachment(f.a,{force:true,allowParse:true,userInitiated:true});
    const parent=await f.c.Zotero.Items.getAsync(11),oldId=parent.children[0];
    f.c.Zotero.Attachments.importFromFile=async()=>{throw Error('IMPORT_UNAVAILABLE');};
    const r=await f.s.syncMarkdownAttachment(f.a,'new contents','paper-a.pdf',{replaceExisting:true});
    assert.equal(r,null);assert.ok(await f.c.Zotero.Items.getAsync(oldId));assert.deepEqual(parent.children,[oldId]);
  });
  await check('MinerU: unreadable replacement is cleaned up, existing attachment retained',async()=>{
    const f=F.minerFixture();await f.s.getMarkdownForAttachment(f.a,{force:true,allowParse:true,userInitiated:true});
    const parent=await f.c.Zotero.Items.getAsync(11),oldId=parent.children[0],original=f.c.Zotero.Attachments.importFromFile;
    f.c.Zotero.Attachments.importFromFile=async o=>{const item=await original(o);f.disk.set(await item.getFilePathAsync(),'');return item;};
    const r=await f.s.syncMarkdownAttachment(f.a,'new contents','paper-a.pdf',{replaceExisting:true});
    assert.equal(r,null);assert.ok(await f.c.Zotero.Items.getAsync(oldId));assert.deepEqual(parent.children,[oldId]);
  });
  await check('Wiki reading-note file write requests atomic temp-path replacement',async()=>{
    const f=F.minerFixture();F.run(f.c,F.section('src/modules/wiki/wikiReadingNote.ts'));F.run(f.c,'init_wikiReadingNote();');
    const store=new f.c.WikiReadingNoteStore(),calls=[];f.c.IOUtils.writeUTF8=async(...args)=>calls.push(args);
    const attachment={key:'NOTE0001',getFilePathAsync:async()=>'/storage/note.md'};
    await store.write(attachment,'new note');assert.equal(calls.length,1);assert.equal(calls[0][2].tmpPath,'/storage/note.md.tmp');
  });
  const out=process.env.AUDIT_RESULTS || path.join(__dirname,'../results');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'additional-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
  if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
