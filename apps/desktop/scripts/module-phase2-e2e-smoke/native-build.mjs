import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const suite=dirname(fileURLToPath(import.meta.url)),desktop=resolve(suite,'../..');
const earlyExit=process.argv.includes('--mutation-early-exit');
const mutation=process.argv.includes('--mutation-save');
if(process.argv.slice(2).some(a=>!['--mutation-save','--mutation-early-exit'].includes(a)))throw Error('Unknown native test option');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const name=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!name)throw Error('Installed dependency required (no install): '+prefix);return join(pnpm,name,'node_modules',sub);};
const {build}=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/p2-06-native-'));
console.log('P2 native evidence: '+dir);
const hashes={};
function record(result){for(const path of Object.keys(result.metafile.inputs)){try{hashes[path]=createHash('sha256').update(readFileSync(resolve(desktop,path))).digest('hex');}catch{hashes[path]='unavailable';}}}
const base={bundle:true,loader:{'.md':'text'},absWorkingDir:desktop,tsconfig:join(desktop,'tsconfig.json'),metafile:true,logLevel:'warning'};
const ports=join(suite,'native-ports.ts');
const mainPlugins=[{name:'no-provider-or-user-main-window',setup(b){
 b.onResolve({filter:/(?:^|\/)RuntimeManager\.js$/},()=>({path:ports}));
 b.onResolve({filter:/providers\/registry\.js$/},()=>({path:ports}));
 b.onResolve({filter:/^(?:@main\/window\.js|\.\.\/window\.js|\.\/window\.js)$/},()=>({path:ports}));
}}];
if(mutation){
 const tsModule=await import(pathToFileURL(pkg('typescript@','typescript/lib/typescript.js')).href),ts=tsModule.default??tsModule;
 mainPlugins.push({name:'temporary-missing-shared-save-guard',setup(b){b.onLoad({filter:/[\\/]contracts[\\/]src[\\/]nodeType\.ts$/},args=>{
  const source=readFileSync(args.path,'utf8'),ast=ts.createSourceFile(args.path,source,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='validateNodeParams');
  const guard=fn?.body?.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(ast).includes('MODULE_CAPABILITY_RUNNER_KIND'));
  if(!guard)throw Error('Shared guard mutation boundary is missing');
  writeFileSync(join(dir,'mutation.json'),JSON.stringify({kind:'remove-shared-strict-save-guard',source:args.path,start:guard.getStart(ast),end:guard.end}));
  return {contents:source.slice(0,guard.getStart(ast))+source.slice(guard.end),loader:'ts',resolveDir:dirname(args.path)};
 });}});
}
record(await build({...base,entryPoints:[join(suite,'native-main.ts')],platform:'node',format:'cjs',external:['electron'],outfile:join(dir,'native-main.cjs'),plugins:mainPlugins}));
record(await build({...base,entryPoints:[join(desktop,'src/preload/index.ts')],platform:'node',format:'cjs',external:['electron'],outfile:join(dir,'preload.cjs')}));
record(await build({...base,entryPoints:[join(suite,'native-renderer.jsx')],platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty','.png':'dataurl','.svg':'dataurl','.woff2':'empty','.woff':'empty','.ttf':'empty'},outfile:join(dir,'renderer.js'),plugins:[{name:'unused-workers',setup(b){
 b.onResolve({filter:/\?worker$/},args=>({path:args.path,namespace:'forbidden-worker'}));
 b.onLoad({filter:/.*/,namespace:'forbidden-worker'},()=>({loader:'js',contents:'export default class ForbiddenWorker {constructor(){throw Error("Unrelated editor worker used in module feature test")}}'}));
}}]}));
const css=spawnSync(process.execPath,[pkg('tailwindcss@','tailwindcss/lib/cli.js'),'-c','tailwind.config.js','-i','src/renderer/styles.css','-o',join(dir,'app.css')],{cwd:desktop,encoding:'utf8',timeout:30000});
writeFileSync(join(dir,'css.log'),(css.stdout??'')+(css.stderr??''));
if(css.status!==0)throw Error('Native CSS build failed: '+css.stderr);
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'none\'"><title>P2 isolated module feature acceptance</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
copyFileSync(join(suite,'electron-host.cjs'),join(dir,'electron-host.cjs'));
writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const require=createRequire(join(desktop,'package.json'));
const electron=require('electron');
if(typeof electron!=='string'||!existsSync(electron))throw Error('Existing installed Electron binary required; no download allowed');
const home=join(dir,'home'),temp=join(dir,'temp');mkdirSync(home,{recursive:true});mkdirSync(temp,{recursive:true});
const env={...process.env,P2_NATIVE_DIR:dir,HOME:home,USERPROFILE:home,APPDATA:join(dir,'userData'),LOCALAPPDATA:join(dir,'localAppData'),TEMP:temp,TMP:temp};
delete env.ELECTRON_RUN_AS_NODE;
const phases=[];
for(const phase of ['create','reopen']){
 const run=spawnSync(electron,[join(dir,'electron-host.cjs')],{cwd:desktop,env:{...env,P2_NATIVE_PHASE:phase,P2_NATIVE_EARLY_EXIT:earlyExit?'1':''},encoding:'utf8',timeout:110000,maxBuffer:10*1024*1024});
 const output=(run.stdout??'')+(run.stderr??'');writeFileSync(join(dir,phase+'.log'),output);process.stdout.write(output);
 let checks=[];try{checks=JSON.parse(readFileSync(join(dir,phase+'-checks.json'),'utf8'));}catch{}
 const complete=checks.length>=(phase==='create'?12:7)&&checks.every(c=>c.status==='PASS')&&checks.at(-1)?.name==='no real provider/model call, page exception or remote page request occurred';
 phases.push({phase,exitCode:run.status,complete,checks:checks.length,signal:run.signal,error:run.error?.message});
 if(run.status!==0||!complete){console.error('NATIVE FAILURE: process exit and complete assertion receipt are BOTH required');break;}
}
const result={mutation:mutation||earlyExit,dir,phases,exitCode:phases.length===2&&phases.every(p=>p.exitCode===0&&p.complete)?0:1};
writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
console.log('P2 native evidence: '+dir);
process.exitCode=result.exitCode;
