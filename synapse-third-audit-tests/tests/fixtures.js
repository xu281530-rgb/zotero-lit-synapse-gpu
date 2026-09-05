'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert/strict');
const root=path.resolve(process.env.XPI_SOURCE || path.join(__dirname,'../new'));
const source=fs.readFileSync(path.join(root,'content/scripts/zotero-lit-synapse.js'),'utf8');
const checks=[];
const resultsRoot=path.resolve(process.env.AUDIT_RESULTS || path.join(__dirname,'../results'));fs.mkdirSync(resultsRoot,{recursive:true});
async function check(name,fn,bug=false){if(process.env.AUDIT_FILTER&&!name.includes(process.env.AUDIT_FILTER))return;try{const details=await fn();checks.push({name,status:bug?'BUG_REPRODUCED':'PASS',details:details??null});}catch(e){checks.push({name,status:'FAIL',error:e.stack||String(e)});}}
function section(start,end){const a=source.indexOf('  // '+start),b=end?source.indexOf('  // '+end,a+1):source.indexOf('\n  // ',a+4);if(a<0||b<0)throw Error('Missing section '+start);return source.slice(a,b);}
function context(extra={}){const c={console,TextEncoder,TextDecoder,Uint8Array,AbortController,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,atob,btoa,
 __esm:o=>{let done=false;return()=>{if(!done){done=true;return Object.values(o)[0]();}};},__export:(o,d)=>{for(const[k,v]of Object.entries(d))Object.defineProperty(o,k,{get:v});},ztoolkit:{log(){}},Zotero:{debug(){},logError(){}},...extra};for(const n of new Set(source.match(/\binit_\w+(?=\()/g)))c[n]=()=>{};return vm.createContext(c);}
function run(c,s){return vm.runInContext(s,c,{timeout:5000});}
const ticks=async(n=4)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function memoryIO(){const disk=new Map(),dirs=new Set(),stats=new Map();return {disk,dirs,stats,io:{
 makeDirectory:async p=>{dirs.add(p);},exists:async p=>disk.has(p)||dirs.has(p),
 readUTF8:async p=>{if(!disk.has(p))throw Error('ENOENT '+p);return disk.get(p);},
 writeUTF8:async(p,s)=>{disk.set(p,s);},move:async(a,b)=>{if(!disk.has(a))throw Error('ENOENT '+a);disk.set(b,disk.get(a));disk.delete(a);},
 remove:async(p,o={})=>{disk.delete(p);dirs.delete(p);if(o.recursive){for(const k of disk.keys())if(k.startsWith(p+'/'))disk.delete(k);for(const k of dirs)if(k.startsWith(p+'/'))dirs.delete(k);}},
 stat:async p=>{if(stats.has(p))return stats.get(p);if(disk.has(p))return{size:Buffer.byteLength(disk.get(p)),lastModified:1000};throw Error('ENOENT '+p);},
 getChildren:async p=>[...new Set([...disk.keys(),...dirs])].filter(k=>path.posix.dirname(k)===p)
 }};}
function serverFixture(){const sockets=[],pending=[];let failInit=false;const c=context({
 Cc:{'@mozilla.org/network/server-socket;1':{createInstance(){const s={closed:false,closeCalls:0,init(p){if(failInit)throw Error('bind failed');this.port=p;},asyncListen(l){this.listener=l;},close(){this.closeCalls++;this.closed=true;if(this.listener)pending.push(()=>this.listener.onStopListening(this,0));}};sockets.push(s);return s;}}},
 Ci:{nsIServerSocket:{}},serverPreferences:{isRemoteAccessAllowed:()=>false},StreamableMCPServer:class{}
 });run(c,section('src/modules/httpServer.ts\n  var REQUEST_IDLE_TIMEOUT_MS','src/utils/locale.ts'));return {s:new c.HttpServer(),sockets,pending,fail:v=>failInit=v,flush:()=>pending.splice(0).forEach(f=>f())};}
function readerFixture(){const io=memoryIO();let owners=[];const c=context({process:{env:{ZMR_TEST:'1'}},PathUtils:{join:path.posix.join},IOUtils:io.io,Zotero:{debug(){},logError(){},DataDirectory:{dir:'/test-data'},getMainWindow:()=>({setTimeout,clearTimeout,AbortController}),Prefs:{get(){}},DB:{queryAsync:async()=>owners}}});let text=fs.readFileSync(path.join(root,'mark-reader/content/scripts/zotero-mark-reader.js'),'utf8');text=text.replace('  const testExports =','  globalThis.auditReader={state,getAttachmentDataDir,loadTranslationCache,saveTranslationCache,emptyTranslationCache,attachmentIdentity,loadLegacyTranslationCache};\n  const testExports =');run(c,text);return{...io,c,r:c.auditReader,t:c.ZoteroMarkReader.__test,setOwners:v=>owners=v};}
function hookFixture(){let timerID=0,observer,enabled=true;const timers=new Map(),builds=[],items=new Map();const service={isReady:async()=>true,isBuildActive:()=>false,getStats:async()=>({indexProgress:{status:'idle'}}),buildIndex:async o=>{builds.push(o);return{processed:0,total:0,status:'completed'};}};const c=context({
 setTimeout:(f,ms)=>{const id=++timerID;timers.set(id,{f,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerID,clearInterval(){},refreshSemanticColumn(){},SERVER_LISTENER_PREFS:{},
 semantic_exports:{getSemanticSearchService:()=>service},
 Zotero:{debug(){},logError(){},Prefs:{get:()=>enabled},Items:{get:ids=>ids.map(id=>items.get(id))},Libraries:{userLibraryID:1},Notifier:{registerObserver:o=>{observer=o;return 1;}}}
 });run(c,section('src/modules/libraryScope.ts'));const a=source.indexOf('  // src/hooks.ts\n  var PREF_SEMANTIC_AUTO_UPDATE');run(c,source.slice(a,source.indexOf('\n  // src/addon.ts',a)));c.registerItemNotifier();return{c,timers,builds,items,service,setEnabled:v=>enabled=v,notify:(...args)=>observer.notify(...args),async runImmediate(){const row=[...timers].find(([,v])=>v.ms===0);if(!row)return false;timers.delete(row[0]);await row[1].f();await ticks();return true;}};}
function regular(id,key,libraryID){return{id,key,libraryID,deleted:false,isRegularItem:()=>true,isAnnotation:()=>false,getField:()=>key};}
function minerFixture(){const io=memoryIO(),items=new Map(),imports=[],parseCalls=[];let seq=0,parseImpl;
 const parents=[{id:11,key:'PARENT01',libraryID:1,children:[],getAttachments(){return this.children;},getNotes:()=>[]},{id:77,key:'PARENT07',libraryID:7,children:[],getAttachments(){return this.children;},getNotes:()=>[]}];for(const p of parents)items.set(p.id,p);
 const c=context({PathUtils:{join:path.posix.join,parent:path.posix.dirname},IOUtils:io.io,Zotero:{debug(){},logError(){},DataDirectory:{dir:'/test-data'},Prefs:{get(){}},Libraries:{userLibraryID:1},
 Items:{getAsync:async id=>items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...items.values()].find(v=>v.libraryID===lib&&v.key===key)},
 Attachments:{importFromFile:async o=>{const parent=items.get(o.parentItemID),id=1000+(++seq),key='MD'+String(seq).padStart(6,'0'),p='/storage/'+key+'/full.md';io.disk.set(p,io.disk.get(o.file));const item={id,key,libraryID:parent.libraryID,parentItemID:parent.id,dateModified:'2026-09-05 12:00:00',attachmentContentType:'text/markdown',isAttachment:()=>true,getField:()=>o.title,getFilePathAsync:async()=>p,eraseTx:async()=>{items.delete(id);parent.children=parent.children.filter(i=>i!==id);}};items.set(id,item);parent.children.push(id);imports.push({libraryID:parent.libraryID,parentItemID:parent.id,markdown:io.disk.get(p)});return item;}}
 }});
 run(c,section('src/modules/mineru/structuredDocumentAssembler.ts'));run(c,section('src/modules/mineru/minerUClient.ts'));run(c,section('src/modules/mineru/minerUService.ts'));run(c,'init_minerUService();');
 c.MinerUClient=class{async parseLocalFile(filePath){parseCalls.push(filePath);return await parseImpl(filePath);}};
 function result(text){const files={'content_list.json':JSON.stringify([{type:'text',text,page_idx:0,bbox:[0,0,100,100]}])};return{files,structuredSource:c.selectStructuredSource(files)};}
 parseImpl=async p=>result(p==='/pdf/a.pdf'?'Paper A evidence text.':'Paper B different evidence text.');
 const a={id:101,key:'SAMEKEY1',libraryID:1,parentItemID:11,attachmentFilename:'paper-a.pdf',isPDFAttachment:()=>true,getFilePathAsync:async()=>'/pdf/a.pdf',getField:()=> 'Paper A original'},b={id:107,key:'SAMEKEY1',libraryID:7,parentItemID:77,attachmentFilename:'paper-b.pdf',isPDFAttachment:()=>true,getFilePathAsync:async()=>'/pdf/b.pdf',getField:()=> 'Paper B original'};items.set(a.id,a);items.set(b.id,b);
 io.stats.set('/pdf/a.pdf',{size:1000,lastModified:1000});io.stats.set('/pdf/b.pdf',{size:2000,lastModified:2000});
 return{...io,c,s:new c.MinerUService(),a,b,imports,parseCalls,result,setParse:fn=>parseImpl=fn};
}
module.exports={context,section,run,memoryIO,minerFixture,readerFixture,hookFixture,serverFixture,ticks,deferred,source,root};
