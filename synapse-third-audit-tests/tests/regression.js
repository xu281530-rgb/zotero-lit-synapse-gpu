'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const sourceRoot = path.resolve(process.env.XPI_SOURCE || path.join(__dirname, '../new'));
const source = fs.readFileSync(path.join(sourceRoot, 'content/scripts/zotero-lit-synapse.js'), 'utf8');
const checks = [];
const resultsRoot=path.resolve(process.env.AUDIT_RESULTS || path.join(__dirname,'../results'));fs.mkdirSync(resultsRoot,{recursive:true});
async function check(name, fn) {
  try { const details = await fn(); checks.push({ name, status:'PASS', details: details ?? null }); }
  catch (error) { checks.push({name, status:'FAIL', error:String(error.stack || error)}); }
}
function section(start, end) {
 const a = source.indexOf('  // '+start); const b = end ? source.indexOf('  // '+end, a+1) : source.indexOf('\n  // ', a+4);
 if (a < 0 || b < 0) throw new Error('missing source section '+start);
 return source.slice(a,b);
}
function context(extra = {}) {
 const c = {console, TextEncoder,TextDecoder,Uint8Array,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,
  __esm: (obj) => {let done=false; return () => {if(!done){done=true; return Object.values(obj)[0]();}};},
  __export: (obj, defs) => { for(const [k,v] of Object.entries(defs)) Object.defineProperty(obj,k,{get:v}); },
  ztoolkit:{log(){}}, Zotero:{debug(){},logError(){}}, ...extra};
 for (const name of new Set(source.match(/\binit_\w+(?=\()/g))) c[name] = () => {};
 return vm.createContext(c);
}
function run(c, s, name='extracted-source.js'){return vm.runInContext(s, c, {filename:name,timeout:5000});}
(async()=>{
 // These tests execute the archive's original functions against controlled dependencies.
 const framed = context();
 run(framed, section('src/modules/httpFraming.ts'));
 await check('HTTP UTF-8 roundtrip preserves Chinese and emoji',()=>assert.equal(framed.utf8Decode(framed.utf8Encode('\u4e2d\u6587\ud83d\udcd6')), '\u4e2d\u6587\ud83d\udcd6'));
 await check('HTTP Content-Length waits for complete body',()=>assert.equal(framed.analyzeRequest('POST /mcp HTTP/1.1\r\nContent-Length: 5\r\n\r\n123').bodyComplete,false));
 await check('HTTP conflicting Content-Length rejected',()=>assert.match(framed.analyzeRequest('POST /mcp HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n1234').error,/conflicting/));
 await check('HTTP chunked request decoded',()=>{const f=framed.analyzeRequest('POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n');assert.equal(f.bodyComplete,true);assert.equal(f.body,'abcde');});
 await check('HTTP partial response writes retried to completion',async()=>{let out=''; const n=await framed.writeAllBytes({write(s){const t=s.slice(0,3);out+=t;return t.length;}},'abcdefghijk',Date.now()+5000);assert.equal(out,'abcdefghijk');assert.equal(n,11);});

 let remote=false, auth=false, token='a'.repeat(40);
 const access=context({serverPreferences:{isRemoteAccessAllowed:()=>remote,isAuthRequired:()=>auth,getAuthToken:()=>token}});
 run(access,section('src/utils/security.ts'));run(access,section('src/modules/httpAccessControl.ts'));
 await check('Access: non-loopback Origin rejected',()=>assert.equal(access.checkRequestAccess('/mcp',new Map([['origin','https://attacker.example'],['host','127.0.0.1:23120']])).status,403));
 await check('Access: DNS-rebinding Host rejected',()=>assert.equal(access.checkRequestAccess('/mcp',new Map([['host','attacker.example:23120']])).status,403));
 await check('Access: loopback allowed with auth disabled',()=>assert.equal(access.checkRequestAccess('/mcp',new Map([['host','127.0.0.1:23120']])),null));
 await check('Access: missing bearer rejected when auth required',()=>{auth=true;assert.equal(access.checkRequestAccess('/mcp',new Map()).status,401);});
 await check('Access: correct bearer accepted',()=>assert.equal(access.checkRequestAccess('/mcp',new Map([['authorization','Bearer '+token]])),null));
 await check('Access: wrong bearer rejected',()=>assert.equal(access.checkRequestAccess('/mcp',new Map([['authorization','Bearer '+ 'b'.repeat(40)]])).status,403));

 const sockets=[], pending=[];
 const server=context({
  Cc:{'@mozilla.org/network/server-socket;1':{createInstance(){const s={closed:false,init(port){this.port=port;},asyncListen(listener){this.listener=listener;},close(){this.closed=true;pending.push(()=>this.listener.onStopListening(this,0x804b0002));}};sockets.push(s);return s;}}},
  Ci:{nsIServerSocket:{}}, serverPreferences:{isRemoteAccessAllowed:()=>false}, StreamableMCPServer:class{}
 });
 run(server,section('src/modules/httpServer.ts\n  var REQUEST_IDLE_TIMEOUT_MS','src/utils/locale.ts'));
 await check('HTTP initial start and ordinary stop report correct state',()=>{const s=new server.HttpServer();s.start(23001);assert.equal(s.isServerRunning(),true);s.stop();assert.equal(s.isServerRunning(),false);pending.splice(0).forEach(f=>f());assert.equal(sockets.at(-1).closed,true);});
 await check('B1 regression: stale close callback leaves new listener live and stoppable',()=>{
  const s=new server.HttpServer();s.start(23001);s.stop();s.start(23002);const live=s.serverSocket;
  assert.equal(s.isServerRunning(),true);assert.equal(live.closed,false);
  pending.splice(0).forEach(f=>f());
  assert.equal(s.isServerRunning(),true);assert.equal(s.getBoundPort(),23002);assert.equal(live.closed,false);
  s.stop();assert.equal(live.closed,true);assert.equal(s.isServerRunning(),false);
  pending.splice(0).forEach(f=>f());
  return {newListenerSurvivedOldCallback:true,newListenerClosedByStop:true};
 });

 const pages=context();run(pages,section('src/modules/hybridSearchPages.ts'));run(pages,'init_hybridSearchPages();');
 await check('Pagination: correct page continuation',()=>{const s=new pages.HybridSearchPageStore();const id=s.create({query:'one',pageSize:2},[1,2,3,4,5],{});const p=s.read(pages.encodeCursor(id,2),{},2).window;assert.equal(JSON.stringify(p.rows),'[3,4]');assert.equal(p.hasMore,true);});
 await check('Pagination: changed query rejected',()=>{const s=new pages.HybridSearchPageStore();const id=s.create({query:'one',pageSize:2},[1,2,3],{});assert.throws(()=>s.read(pages.encodeCursor(id,2),{query:'two'},2),/query differs/);});
 await check('Pagination: expired cursor rejected',()=>{let t=0;const s=new pages.HybridSearchPageStore(()=>t,100);const id=s.create({query:'one',pageSize:2},[1,2,3],{});t=101;assert.throws(()=>s.read(pages.encodeCursor(id,2),{},2),/expired/);});
 await check('Pagination: cursor from another tool rejected',()=>{const s=new pages.HybridSearchPageStore();assert.throws(()=>s.read('ss1_abcd_2',{},2),/Malformed/);});

 const disk=new Map(), made=[];
 const reader=context({process:{env:{ZMR_TEST:'1'}},PathUtils:{join:path.posix.join},IOUtils:{
   makeDirectory:async p=>{made.push(p);},exists:async p=>disk.has(p),readUTF8:async p=>disk.get(p),writeUTF8:async(p,v)=>{disk.set(p,v);},move:async(a,b)=>{disk.set(b,disk.get(a));disk.delete(a);},remove:async p=>disk.delete(p)
 },Zotero:{debug(){},logError(){},DataDirectory:{dir:'/test-data'},getMainWindow:()=>({setTimeout,clearTimeout,AbortController}),Prefs:{get(){}}}});
 let rsource=fs.readFileSync(path.join(sourceRoot,'mark-reader/content/scripts/zotero-mark-reader.js'),'utf8');
 rsource=rsource.replace('  const testExports =','  globalThis.auditReader = {state, getAttachmentDataDir, loadTranslationCache, saveTranslationCache, emptyTranslationCache, readChatCompletionStream};\n  const testExports =');
 run(reader,rsource,'original-reader-with-test-exports.js');
 const rt=reader.ZoteroMarkReader.__test, ri=reader.auditReader;
 await check('Reader: valid chat response text decoded',()=>assert.equal(rt.parseChatCompletionText('{"choices":[{"message":{"content":"translated"}}]}'),'translated'));
 await check('Reader: source changes invalidate translation fingerprint',()=>{const c={targetLanguage:'zh',provider:'p',model:'m',systemPrompt:'s'};assert.notEqual(rt.translationFingerprint({id:'b',markdown:'one'},c),rt.translationFingerprint({id:'b',markdown:'two'},c));});
 await check('Reader: translation cache writes persist normally',async()=>{const a={key:'NORMAL01',libraryID:1};const cache=ri.emptyTranslationCache(a,{sourceHash:'hash'});cache.entries.x={v:{markdown:'test'}};await ri.saveTranslationCache(a,cache);const p=(await ri.getAttachmentDataDir(a))+'/translation-cache.json';assert.equal(JSON.parse(disk.get(p)).entries.x.v.markdown,'test');});
 await check('B2 regression: same-key attachments in different libraries have independent translation caches',async()=>{
   const a={key:'ABCD2345',libraryID:1},b={key:'ABCD2345',libraryID:7};
   const da=await ri.getAttachmentDataDir(a), db=await ri.getAttachmentDataDir(b);assert.notEqual(da,db);
   const ca=await ri.loadTranslationCache(a,{sourceHash:'paper-a',blocks:[]});ca.glossary.manual.push({source:'alpha',target:'A'});
   const cb=await ri.loadTranslationCache(b,{sourceHash:'paper-b',blocks:[]});assert.notStrictEqual(ca,cb);assert.equal(cb.sourceHash,'paper-b');assert.equal(cb.glossary.manual.length,0);
   await ri.saveTranslationCache(a,ca);await ri.saveTranslationCache(b,cb);
   assert.equal(JSON.parse(disk.get(da+'/translation-cache.json')).libraryID,1);
   assert.equal(JSON.parse(disk.get(db+'/translation-cache.json')).libraryID,7);
   return {directories:[da,db],independentMemoryObjects:true,secondPaperSourceHash:cb.sourceHash};
 });

 // Additional checks run original protocol and write guard implementations.
 const prefs=new Map();
 vm.runInNewContext(fs.readFileSync(path.join(sourceRoot,'prefs.js'),'utf8'),{pref:(k,v)=>prefs.set(k,v)});
 let approved=false, saves=0, promptCalls=0, constructors=0;
 const mc=context({
   ztoolkit:{log:(...v)=>{if(process.env.AUDIT_DEBUG)console.error(...v);}},
   MAX_SIMILAR_QUERY_CHUNKS:20,WIKI_EVIDENCE_MIN_EXCERPT_CHARS:24,DEFAULT_DOCUMENT_CHUNKS_PER_PAGE:8,
   MAX_DOCUMENT_CHUNKS_PER_PAGE:20,MAX_SEARCH_INDEX_BUILD_ITEMS:100,MAX_HYBRID_KEYWORDS:16,MAX_SUPPLIED_KEYWORDS:16,
   DEFAULT_ATTACHMENT_TEXT_WINDOW:4000,MAX_ATTACHMENT_TEXT_WINDOW:20000,
   config:{addonVersion:'3.1.0'},
   Services:{prompt:{confirm(){promptCalls++;return approved;}}},
   Zotero:{debug(){},logError(){},getMainWindow:()=>({}),DataDirectory:{dir:'/test-data'},
     Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},Libraries:{userLibraryID:1},
     Item:class {constructor(type){constructors++;this.itemType=type;this.key='NEWNOTE1';this.dateAdded='2026-09-05';this.tags=[];} setNote(v){this.note=v;} addTag(v){this.tags.push(v);} async saveTx(){saves++;}},
     Items:{getByLibraryAndKeyAsync:async()=>null}}
 });
 for(const mod of ['src/modules/requestCancellation.ts','src/modules/hybridSearchPages.ts','src/modules/mcpTransport.ts','src/utils/privacy.ts','src/modules/wiki/wikiSettings.ts','src/modules/toolCatalog.ts']) run(mc,section(mod));
 const mi=source.indexOf('  // src/modules/streamableMCPServer.ts');
 run(mc,source.slice(mi,source.indexOf('\n  // node_modules/',mi)));
 run(mc,'init_streamableMCPServer();');
 const ms=new mc.StreamableMCPServer();
 async function rpc(method,params,id=42){const r=await ms.handleMCPRequest(JSON.stringify({jsonrpc:'2.0',id,method,params}));return {http:r,json:r.body?JSON.parse(r.body):null};}
 const writePref='extensions.zotero.zotero-lit-synapse.write.enabled';
 await check('MCP: initializes with supported protocol and manifest version',async()=>{const r=await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'audit',version:'1'}});assert.equal(r.http.status,200);assert.equal(r.json.result.protocolVersion,'2025-06-18');assert.equal(r.json.result.serverInfo.version,'3.1.0');});
 await check('MCP: malformed JSON rejected as parse error',async()=>{const r=await ms.handleMCPRequest('{');assert.equal(r.status,400);assert.equal(JSON.parse(r.body).error.code,-32700);});
 await check('MCP: invalid JSON-RPC version rejected',async()=>{const r=await ms.handleMCPRequest('{"jsonrpc":"1.0","method":"ping","id":1}');assert.equal(JSON.parse(r.body).error.code,-32600);});
 await check('MCP: unknown tool rejected as invalid params',async()=>{const r=await rpc('tools/call',{name:'not_a_real_tool',arguments:{}});assert.equal(r.json.error.code,-32602);});
 await check('MCP: write tools not advertised with default write-disabled prefs',async()=>{const r=await rpc('tools/list',{});assert.ok(r.json.result.tools.some(t=>t.name==='hybrid_search'));assert.ok(!r.json.result.tools.some(t=>t.name==='write_note'));return {advertisedTools:r.json.result.tools.length};});
 await check('MCP: explicitly calling disabled write rejected without mutation',async()=>{const r=await rpc('tools/call',{name:'write_note',arguments:{action:'create',content:'test note'}});assert.equal(r.json.result.isError,true);assert.match(r.json.result.content[0].text,/disabled/);assert.equal(constructors,0);assert.equal(saves,0);});
 await check('MCP: user refusal prevents mutation',async()=>{prefs.set(writePref,true);const r=await rpc('tools/call',{name:'write_note',arguments:{action:'create',content:'test note'}});assert.equal(r.json.result.isError,true);assert.match(r.json.result.content[0].text,/declined/);assert.equal(promptCalls,1);assert.equal(constructors,0);assert.equal(saves,0);});
 await check('MCP: approved note create calls simulated save exactly once',async()=>{approved=true;const r=await rpc('tools/call',{name:'write_note',arguments:{action:'create',content:'test note'}});assert.ok(!r.json.result.isError,JSON.stringify(r.json));assert.equal(JSON.parse(r.json.result.content[0].text).success,true);assert.equal(saves,1);});
 await check('MCP: missing target note returns isError rather than fake success',async()=>{const r=await rpc('tools/call',{name:'write_note',arguments:{action:'update',noteKey:'MISSING1',content:'test'}});assert.equal(r.json.result.isError,true);assert.equal(JSON.parse(r.json.result.content[0].text).success,false);assert.equal(saves,1);});
 await check('MCP: empty new note rejected without additional save',async()=>{const r=await rpc('tools/call',{name:'write_note',arguments:{action:'create',content:''}});assert.equal(r.json.result.isError,true);assert.equal(saves,1);});
 await check('Privacy: explicit local path redacted from response payload',()=>{const result=mc.sanitizeForPrivacy({path:'/test-data/storage/paper.pdf',message:'Cannot open /test-data/storage/paper.pdf'});assert.equal(result.path,'');assert.ok(!result.message.includes('/test-data'));});

 let observer, timerID=0, periodicBuilds=[];
 const groupItem={id:99,key:'GROUP123',libraryID:7,deleted:false,isRegularItem:()=>true,isAnnotation:()=>false,getField:()=> 'A newly added group paper'};
 const hc=context({
  setTimeout:()=>++timerID,setInterval:()=>++timerID,clearTimeout(){},clearInterval(){},refreshSemanticColumn(){},SERVER_LISTENER_PREFS:{},
  semantic_exports:{getSemanticSearchService:()=>({isReady:async()=>true,isBuildActive:()=>false,getStats:async()=>({indexProgress:{status:'idle'}}),buildIndex:async options=>{periodicBuilds.push(options.libraryID);return {processed:0,total:0,status:'completed'};}})},
  Zotero:{debug(){},logError(){},Prefs:{get:()=>true},Items:{get:()=>[groupItem]},Libraries:{userLibraryID:1},Notifier:{registerObserver:o=>{observer=o;return 123;}}}
 });
 run(hc,section('src/modules/libraryScope.ts'));
 const hi=source.indexOf('  // src/hooks.ts\n  var PREF_SEMANTIC_AUTO_UPDATE');
 run(hc,source.slice(hi,source.indexOf('\n  // src/addon.ts',hi)));
 hc.registerItemNotifier();
 await check('Index notifier: normal group-library add is queued with library identity',async()=>{await observer.notify('add','item',[99],{});assert.equal(hc.pendingAutoUpdateKeys.get('7:GROUP123'),true);hc.pendingAutoUpdateKeys.clear();});
 await check('B3 regression: group add while indexing is retained and subsequently built',async()=>{
  hc.isAutoIndexing=true;await observer.notify('add','item',[99],{});
  assert.equal(hc.pendingAutoUpdateKeys.get('7:GROUP123'),true);
  hc.isAutoIndexing=false;await hc.processPendingAutoUpdates();
  assert.equal(hc.pendingAutoUpdateKeys.size,0);assert.deepEqual(periodicBuilds,[7]);
  return {queuedDuringBuild:true,builtLibraryIDs:periodicBuilds,queueDrained:true};
 });

 fs.writeFileSync(path.join(resultsRoot,'regression-results.json'),JSON.stringify(checks,null,2));
 console.log(JSON.stringify(checks,null,2));
 if(checks.some(r=>r.status==='FAIL')) process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
