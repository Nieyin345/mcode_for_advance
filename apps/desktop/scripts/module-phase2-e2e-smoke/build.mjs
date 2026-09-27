import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const suite=dirname(fileURLToPath(import.meta.url));
if(process.argv.length>2)throw Error('Unknown test option');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));
if(!pkg)throw Error('Installed esbuild required (no install/network fallback)');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/p2-06-e2e-'));
console.log('P2-06 evidence: '+dir);
const stages=[];
function runStage(name,script,args,label,proofFile){
 const run=spawnSync(process.execPath,[script,...args],{cwd:desktop,encoding:'utf8',timeout:235000,maxBuffer:16*1024*1024});
 const output=(run.stdout??'')+(run.stderr??'');writeFileSync(join(dir,name+'.log'),output);process.stdout.write(output);
 const evidence=output.split(/\r?\n/).filter(line=>line.startsWith(label)).at(-1)?.slice(label.length).trim();
 let proof;try{proof=JSON.parse(readFileSync(join(evidence??'',proofFile),'utf8'));}catch{}
 const stage={name,exitCode:run.status,signal:run.signal,error:run.error?.message,evidence,proof};stages.push(stage);return stage;
}
const native=runStage('native-window',join(suite,'native-build.mjs'),[],'P2 native evidence: ','result.json');
const workflow=runStage('production-workflow',join(suite,'../module-workflow-smoke/build.mjs'),[],'Module workflow evidence: ','result.json');
const save=runStage('shared-save-guard',join(suite,'../module-workflow-smoke/build.mjs'),['--save-guard'],'Module workflow evidence: ','result.json');
const browser=runStage('catalog-browser',join(suite,'../module-catalog-ui-smoke/build.mjs'),[],'Module catalog UI artifacts: ','results.json');
// References are fresh mkdtemp artifacts from these exact child executions.
const completion={schemaVersion:1,stages};
writeFileSync(join(dir,'integration-receipt.json'),JSON.stringify(completion,null,2));
const hashes={};
const result=await build({entryPoints:[join(suite,'main.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),tsconfig:join(desktop,'tsconfig.json'),metafile:true,
 alias:{'@main/lib/dataRoot.js':join(suite,'../module-phase2-security-smoke/stubs/environment.ts'),'@main/lib/pathGuard.js':join(suite,'../module-phase2-security-smoke/stubs/environment.ts')},
 banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
for(const path of Object.keys(result.metafile.inputs)){try{hashes[path]=createHash('sha256').update(readFileSync(resolve(path))).digest('hex');}catch{hashes[path]='unavailable';}}
writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const run=spawnSync(process.execPath,[join(dir,'test.mjs')],{cwd:desktop,encoding:'utf8',timeout:90000,env:{...process.env,P2_TEST_DIR:dir}});
const log=(run.stdout??'')+(run.stderr??'');writeFileSync(join(dir,'output.log'),log);
const exitCode=run.status===0&&stages.every(stage=>stage.exitCode===0)?0:1;
writeFileSync(join(dir,'result.json'),JSON.stringify({exitCode,segmentExitCode:run.status,stages:stages.map(({proof,...stage})=>stage),signal:run.signal,error:run.error?.message},null,2));
process.stdout.write(log);console.log('P2-06 evidence: '+dir);
if(run.error)throw run.error;process.exitCode=exitCode;
