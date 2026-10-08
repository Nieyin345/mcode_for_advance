import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {EventEmitter} from 'node:events';
import {writeFileSync,readFileSync,mkdtempSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {listenOnDialablePort,isBlockedPort} from '../../src/main/lib/loopbackPort.js';
const dir=process.env.MAINT_M11_DIR;assert.ok(dir,'Isolated evidence directory required');
const results:Array<{name:string;status:string;error?:string}>=[];
async function test(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.error('FAIL '+name+' '+String(e));}}
const close=(server:Server)=>new Promise<void>(resolve=>{if(server.listening)server.close(()=>resolve());else resolve();});
class ScriptedServer extends EventEmitter {
 bound=false;closes=0;attempts=0;trace:string[]=[];
 constructor(readonly ports:number[],public mode:'ok'|'sync-error'|'async-error'='ok'){super();}
 listen(port:number,host:string,cb:()=>void):this{
  assert.equal(port,0);assert.equal(host,'127.0.0.1');this.attempts++;this.trace.push('listen');
  this.once('listening',cb);
  if(this.mode==='sync-error')throw new Error('scripted sync listen failure');
  queueMicrotask(()=>{if(this.mode==='async-error')this.emit('error',new Error('scripted async listen failure'));else{this.bound=true;this.emit('listening');}});
  return this;
 }
 address(){return this.bound?{port:this.ports[this.attempts-1],address:'127.0.0.1',family:'IPv4'}:null;}
 close(cb:()=>void):this{this.closes++;this.trace.push('close');queueMicrotask(()=>{this.bound=false;this.trace.push('closed');cb();});return this;}
 asServer():Server{return this as unknown as Server;}
}
await test('real onBind exception rejects with original error and releases owned socket',async()=>{
 const server=createServer((_q,r)=>r.end('fixture'));const original=new Error('bookkeeping failed');
 try{await assert.rejects(listenOnDialablePort(server,()=>{throw original;}),e=>e===original);assert.equal(server.listening,false,'rejected bind leaked its listening socket');assert.equal(server.address(),null);}finally{await close(server);}
});
await test('onBind abort of blocked allocation closes once without further attempts',async()=>{
 const server=new ScriptedServer([6667,55001]);const original=new Error('abort blocked callback');
 await assert.rejects(listenOnDialablePort(server.asServer(),()=>{throw original;}),e=>e===original);
 assert.equal(server.closes,1);assert.equal(server.bound,false);assert.equal(server.attempts,1);
});
await test('synchronous listen failure removes only this attempts listeners',async()=>{
 const server=new ScriptedServer([], 'sync-error');const outsideError=()=>{};const outsideListening=()=>{};
 server.on('error',outsideError);server.on('listening',outsideListening);
 await assert.rejects(listenOnDialablePort(server.asServer()),/scripted sync/);
 assert.deepEqual(server.listeners('error'),[outsideError]);assert.deepEqual(server.listeners('listening'),[outsideListening]);assert.equal(server.closes,0);
});
await test('asynchronous listen failure removes stale success callback',async()=>{
 const server=new ScriptedServer([], 'async-error');const outsideListening=()=>{};server.on('listening',outsideListening);
 await assert.rejects(listenOnDialablePort(server.asServer()),/scripted async/);
 assert.equal(server.listenerCount('error'),0);assert.deepEqual(server.listeners('listening'),[outsideListening]);assert.equal(server.closes,0);
});
await test('pre-existing real listener is preserved on ERR_SERVER_ALREADY_LISTEN',async()=>{
 const server=createServer((_q,r)=>r.end('existing'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();const count=server.listenerCount('error');
 try{await assert.rejects(listenOnDialablePort(server),{code:'ERR_SERVER_ALREADY_LISTEN'});assert.equal(server.listening,true);assert.deepEqual(server.address(),address);assert.equal(server.listenerCount('error'),count);}finally{await close(server);}
});
await test('successful real bind retains the socket and is HTTP dialable',async()=>{
 const server=createServer((_q,r)=>r.end('fixture-ok'));const binds:number[]=[];
 try{const port=await listenOnDialablePort(server,p=>binds.push(p));assert.equal(isBlockedPort(port),false);assert.equal(server.listening,true);assert.equal(binds.at(-1),port);const r=await fetch('http://127.0.0.1:'+port);assert.equal(await r.text(),'fixture-ok');}finally{await close(server);}
});
await test('blocked retry awaits close and preserves callback attempt order',async()=>{
 const server=new ScriptedServer([6667,6697,55001]);const seen:Array<[number,number]>=[];
 assert.equal(await listenOnDialablePort(server.asServer(),(p,a)=>seen.push([p,a])),55001);
 assert.deepEqual(seen,[[6667,0],[6697,1],[55001,2]]);assert.deepEqual(server.trace,['listen','close','closed','listen','close','closed','listen']);assert.equal(server.bound,true);
});
await test('exhausted blocked allocation leaves no bound socket',async()=>{
 const server=new ScriptedServer([6667,6668,6669,6697,6000]);await assert.rejects(listenOnDialablePort(server.asServer()),/5.*6000/);
 assert.equal(server.closes,5);assert.equal(server.bound,false);assert.equal(server.listenerCount('error'),0);assert.equal(server.listenerCount('listening'),0);
});
await test('server can be reused after asynchronous bind failure without stale callbacks',async()=>{
 const server=new ScriptedServer([55001,55002],'async-error');let calls=0;
 await assert.rejects(listenOnDialablePort(server.asServer(),()=>calls++),/scripted async/);server.mode='ok';
 assert.equal(await listenOnDialablePort(server.asServer(),()=>calls++),55002);assert.equal(calls,1);assert.equal(server.listenerCount('error'),0);assert.equal(server.listenerCount('listening'),0);
});
// ── 下载落点去重(browserPure.uniqueDownloadPath,原 BrowserManager 私有)──
// Chromium 传输期间目标文件并不存在(写的是 .crdownload,完成时才 rename),所以只查磁盘
// 的去重挡不住**并发**的同名下载:两个 will-download 都拿到 report.pdf,后到的把先到的覆盖。
// 生产函数是模块私有的、且模块顶层 import electron,这里用 TypeScript AST 按声明边界取出
// 该函数原文、转译后以真实 join/statSync 执行 —— 不手抄算法。
const desktopRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const purePath=join(desktopRoot,'src/main/browser/browserPure.ts');
const bmPath=join(desktopRoot,'src/main/browser/BrowserManager.ts');
const pureSource=ts.createSourceFile('browserPure.ts',readFileSync(purePath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const bmSource=ts.createSourceFile('BrowserManager.ts',readFileSync(bmPath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const fnDecls:ts.FunctionDeclaration[]=[];const callArgCounts:number[]=[];
function visitPure(n:ts.Node):void{
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='uniqueDownloadPath')fnDecls.push(n);
 ts.forEachChild(n,visitPure);
}
function visitCalls(n:ts.Node):void{
 if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='uniqueDownloadPath')callArgCounts.push(n.arguments.length);
 ts.forEachChild(n,visitCalls);
}
visitPure(pureSource);assert.equal(fnDecls.length,1,'unique production uniqueDownloadPath required (browserPure.ts)');
visitCalls(bmSource);
const udpSrc=fnDecls[0].getText(pureSource).replace(/^export\s+/,'');const udpJs=ts.transpileModule(udpSrc+'\nreturn uniqueDownloadPath;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const uniqueDownloadPath=new Function('join','statSync',udpJs)(join,statSync) as (dir:string,filename:string,reserved?:ReadonlySet<string>)=>string;
const dlDir=mkdtempSync(join(dir,'downloads-'));
await test('download path: free name is taken as-is (control)',async()=>{
 assert.equal(uniqueDownloadPath(dlDir,'report.pdf'),join(dlDir,'report.pdf'));
});
await test('download path: existing file on disk still dedupes to -1 (old behavior kept)',async()=>{
 writeFileSync(join(dlDir,'report.pdf'),'x');
 assert.equal(uniqueDownloadPath(dlDir,'report.pdf'),join(dlDir,'report-1.pdf'));
});
await test('download path: an in-flight download reserves its name even before the file exists',async()=>{
 const fresh=mkdtempSync(join(dir,'downloads-inflight-'));
 const first=uniqueDownloadPath(fresh,'paper.pdf');
 assert.equal(first,join(fresh,'paper.pdf'));
 // 第一份还在传(磁盘上没有文件),第二份同名到达 —— 不能再分到同一个落点。
 const second=uniqueDownloadPath(fresh,'paper.pdf',new Set([first]));
 assert.notEqual(second,first,'concurrent same-name download was assigned the same save path');
 assert.equal(second,join(fresh,'paper-1.pdf'));
});
await test('download path: reservation and on-disk collision compose (-2)',async()=>{
 const fresh=mkdtempSync(join(dir,'downloads-compose-'));
 writeFileSync(join(fresh,'paper-1.pdf'),'x');
 assert.equal(uniqueDownloadPath(fresh,'paper.pdf',new Set([join(fresh,'paper.pdf')])),join(fresh,'paper-2.pdf'));
});
await test('download path: will-download call site passes the in-flight reservation set',async()=>{
 assert.equal(callArgCounts.length,1,'exactly one production call site expected');
 assert.equal(callArgCounts[0],3,'call site must pass in-flight download paths as the third argument');
});
writeFileSync(join(dir,'checks.json'),JSON.stringify(results,null,2));console.log(results.filter(r=>r.status==='PASS').length+' passed; '+results.filter(r=>r.status==='FAIL').length+' failed');process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
