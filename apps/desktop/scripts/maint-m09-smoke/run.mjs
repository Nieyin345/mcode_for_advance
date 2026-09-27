import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(desktop,'package.json'));
const ts=require('typescript');
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/maint-m09-'));
const hashes={};
// Extract declarations by TypeScript AST boundary, not a copied implementation.
// Only pure URI/binding functions execute: no Electron, settings DB or servers.
function load(relative,names,bindings=false){
 const path=join(desktop,relative), source=readFileSync(path,'utf8');
 hashes[relative]=createHash('sha256').update(source).digest('hex');
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
 const nodes=names.map(name=>{const n=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(n,'Missing production function '+name);return n.getText(ast);});
 if(bindings){const n=ast.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)==='modelPathBindings'));assert.ok(n);nodes.unshift(n.getText(ast));}
 const js=ts.transpileModule(nodes.join('\n')+'\n;globalThis.extracted={'+names.join(',')+'};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{}};vm.runInNewContext(js,context,{timeout:1000});return context.extracted;
}
const main=load('src/main/lsp/LspManager.ts',['filePathToUri','dirPathToUri']);
const renderer=load('src/renderer/lib/lspProviders.ts',['filePathToUri','uriToFilePath','decodeURIComponentSafe','bindModelToPath','unbindModel','modelToLspUri'],true);
const checks=[];
function test(name,fn){try{fn();checks.push({name,pass:true});console.log('PASS '+name);}catch(e){checks.push({name,pass:false,error:String(e)});console.log('FAIL '+name+'\n'+e);}}
const fixtures=[
 ['posix plain','/tmp/project/main.ts',false],
 ['windows plain',String.raw`C:\project\main.ts`,true],
 ['posix hash','/tmp/project/a#b.ts',false],
 ['windows hash',String.raw`C:\project\a#b.ts`,true],
 ['literal escape','/tmp/project/a%23b.ts',false],
 ['windows literal escape',String.raw`C:\project\a%23b.ts`,true],
 ['posix query','/tmp/project/a?b.ts',false],
 ['space','/tmp/my project/a b.ts',false],
 ['unicode','/tmp/项目/文件.ts',false],
 ['windows unicode',String.raw`C:\项目\文件.ts`,true],
];
for(const [name,path,windows] of fixtures){
 const expected=pathToFileURL(path,{windows}).href;
 for(const [side,helper] of [['main',main],['renderer',renderer]])test(side+' '+name,()=>{
  const actual=helper.filePathToUri(path);assert.equal(actual,expected);
  assert.equal(new URL(actual).hash,'');assert.equal(new URL(actual).search,'');
  assert.equal(fileURLToPath(actual,{windows}),path);
 });
 test('inverse/parity '+name,()=>{assert.equal(main.filePathToUri(path),renderer.filePathToUri(path));assert.equal(renderer.uriToFilePath(renderer.decodeURIComponentSafe(renderer.filePathToUri(path))),path);});
}
for(const path of ['/tmp/project','/tmp/project/','/'])test('root URI '+path,()=>{
 // Node on Windows may render the POSIX root with four slashes; use the explicit root URI.
 const expected=path==='/'?'file:///':pathToFileURL(path,{windows:false}).href;assert.equal(main.dirPathToUri(path),expected.endsWith('/')?expected:expected+'/');
});
test('diff binding preserves literal percent and fragment filename',()=>{
 const model={uri:{toString:()=> 'inmemory://model/1'}};const path=String.raw`C:\project\a%23#b.ts`;
 renderer.bindModelToPath(model,path);
 try{assert.equal(renderer.modelToLspUri(model),pathToFileURL(path,{windows:true}).href);}finally{renderer.unbindModel(model);}
 assert.equal(renderer.modelToLspUri(model),'inmemory://model/1');
});
test('existing encoded file URI passes through without double encoding',()=>{
 const uri='file:///C:/project/a%2523%23b.ts';assert.equal(renderer.modelToLspUri({uri:{toString:()=>uri}}),uri);
});
writeFileSync(join(dir,'checks.json'),JSON.stringify(checks,null,2));
writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const failed=checks.filter(c=>!c.pass).length;
const summary=`${checks.length-failed} passed; ${failed} failed`;
writeFileSync(join(dir,'result.json'),JSON.stringify({exitCode:failed?1:0,passed:checks.length-failed,failed},null,2));
writeFileSync(join(dir,'output.log'),checks.map(c=>(c.pass?'PASS ':'FAIL ')+c.name+(c.error?'\n'+c.error:'')).join('\n')+'\n'+summary+'\n');
console.log(summary+'\nM09 evidence: '+dir);process.exitCode=failed?1:0;
