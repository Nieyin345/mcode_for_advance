import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
import {localPathToFileUrl} from '../../src/renderer/lib/browserUrl.js';
import {OCCLUDER_UNMEASURED,setBrowserStageRect,registerOccluder,updateOccluder,unregisterOccluder,shouldSuppressBrowserView,subscribeOcclusion,getOcclusionVersion} from '../../src/renderer/lib/browserOcclusion.js';
const dir=process.env.MAINT_M12_DIR, desktop=process.env.MAINT_M12_DESKTOP;
assert.ok(dir && desktop,'Isolated fixture paths required');
const results:Array<{name:string;status:string;error?:string}>=[];
function test(name:string,fn:()=>void){try{fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.error('FAIL '+name+' '+String(e));}}
const cases:Array<{name:string;path:string;windows:boolean}>=[
 {name:'Windows slash and Unicode',path:'C:/docs/中文 report.html',windows:true},
 {name:'Windows backslashes',path:String.raw`C:\docs\中文 report.html`,windows:true},
 {name:'Windows hash is filename, not fragment',path:String.raw`C:\docs\report#draft.html`,windows:true},
 {name:'Unix hash is filename, not fragment',path:'/tmp/report#draft.html',windows:false},
 {name:'Unix question mark is filename, not query',path:'/tmp/report?draft.html',windows:false},
 {name:'combined delimiters and literal percent encoding',path:'/tmp/a%23?#汉字.html',windows:false},
 {name:'percent sequences must not be decoded as input URLs',path:'/tmp/100%25.html',windows:false},
 {name:'Unix root',path:'/',windows:false},
];
for(const c of cases)test(c.name,()=>{
 const actual=localPathToFileUrl(c.path),expected=c.path==='/'?'file:///':pathToFileURL(c.path,{windows:c.windows}).href;
 assert.equal(actual,expected);const u=new URL(actual);assert.equal(u.hash,'');assert.equal(u.search,'');
});
test('file URL roundtrip opens the actual hash-named temporary file',()=>{
 const p=join(dir,'中文#draft%23.html');writeFileSync(p,'fixture exact bytes');
 const u=new URL(localPathToFileUrl(p));assert.equal(fileURLToPath(u),p);assert.equal(readFileSync(u,'utf8'),'fixture exact bytes');
});
// Extract the real production arrow function by AST, not a rewritten copy.
const source=ts.createSourceFile('BrowserPanel.tsx',readFileSync(join(desktop,'src/renderer/components/browser/BrowserPanel.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const initializers:ts.Expression[]=[];
function visit(n:ts.Node):void{if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='normalizeUrl'&&n.initializer)initializers.push(n.initializer);ts.forEachChild(n,visit);}
visit(source);assert.equal(initializers.length,1,'unique production normalizeUrl required');
const js=ts.transpileModule('const normalizeUrl = '+initializers[0].getText(source)+'; normalizeUrl;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const normalize=runInNewContext(js,{localPathToFileUrl,encodeURIComponent}) as (s:string)=>string;
test('production address-bar normalization preserves local hash paths',()=>{
 assert.equal(normalize(String.raw`C:\docs\report#draft.html`),pathToFileURL(String.raw`C:\docs\report#draft.html`,{windows:true}).href);
 assert.equal(normalize('/tmp/report?draft.html'),pathToFileURL('/tmp/report?draft.html',{windows:false}).href);
});
test('explicit web URL query and fragment stay intact',()=>assert.equal(normalize('https://example.test/page?q=1#part'),'https://example.test/page?q=1#part'));
test('blank, bare domain and search behavior is unchanged',()=>{
 assert.equal(normalize('  '),'about:blank');assert.equal(normalize('example.com'),'https://example.com');assert.equal(normalize('search words'),'https://www.google.com/search?q=search%20words');
});
test('occlusion overlap and non-overlap update correctly',()=>{
 setBrowserStageRect({left:100,top:100,right:300,bottom:300});
 const id=registerOccluder({left:0,top:0,right:50,bottom:50});
 try{assert.equal(shouldSuppressBrowserView(),false);updateOccluder(id,{left:200,top:200,right:400,bottom:400});assert.equal(shouldSuppressBrowserView(),true);}finally{unregisterOccluder(id);}
});
test('unmeasured portal never overlaps a stage crossing viewport origin',()=>{
 setBrowserStageRect({left:-10,top:-10,right:300,bottom:300});const id=registerOccluder(OCCLUDER_UNMEASURED);
 try{assert.equal(shouldSuppressBrowserView(),false,'invisible unmeasured portal must not hide browser');}finally{unregisterOccluder(id);}
});
test('unknown modal geometry remains conservatively suppressing',()=>{
 setBrowserStageRect({left:-10,top:-10,right:300,bottom:300});const id=registerOccluder(null);
 try{assert.equal(shouldSuppressBrowserView(),true);}finally{unregisterOccluder(id);}
});
test('real overlap still suppresses alongside an unmeasured portal',()=>{
 setBrowserStageRect({left:0,top:0,right:300,bottom:300});const a=registerOccluder(OCCLUDER_UNMEASURED),b=registerOccluder({left:10,top:10,right:20,bottom:20});
 try{assert.equal(shouldSuppressBrowserView(),true);}finally{unregisterOccluder(a);unregisterOccluder(b);}
});
test('occlusion subscription cleanup and no-op update do not notify twice',()=>{
 let calls=0;const stop=subscribeOcclusion(()=>calls++);const rect={left:20,top:20,right:40,bottom:40};const id=registerOccluder(rect);
 try{const v=getOcclusionVersion();updateOccluder(id,{...rect});assert.equal(getOcclusionVersion(),v);assert.equal(calls,1);stop();updateOccluder(id,{...rect,right:50});assert.equal(calls,1);}finally{stop();unregisterOccluder(id);setBrowserStageRect(null);}
});
writeFileSync(join(dir,'checks.json'),JSON.stringify(results,null,2));console.log(`${results.filter(r=>r.status==='PASS').length} passed; ${results.filter(r=>r.status==='FAIL').length} failed`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
