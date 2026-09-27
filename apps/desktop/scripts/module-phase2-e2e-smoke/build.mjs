import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const suite=dirname(fileURLToPath(import.meta.url));
const mutation=false;
if(process.argv.length>2)throw Error('Unknown test option');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));
if(!pkg)throw Error('Installed esbuild required (no install/network fallback)');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/p2-06-e2e-'));
const hashes={};
const result=await build({entryPoints:[join(suite,'main.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),tsconfig:join(desktop,'tsconfig.json'),metafile:true,
 alias:{'@main/lib/dataRoot.js':join(suite,'../module-phase2-security-smoke/stubs/environment.ts'),'@main/lib/pathGuard.js':join(suite,'../module-phase2-security-smoke/stubs/environment.ts')},
 banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
for(const path of Object.keys(result.metafile.inputs)){try{hashes[path]=createHash('sha256').update(readFileSync(resolve(path))).digest('hex');}catch{hashes[path]='unavailable';}}
writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const run=spawnSync(process.execPath,[join(dir,'test.mjs')],{encoding:'utf8',timeout:90000,env:{...process.env,P2_TEST_DIR:dir,P2_SECURITY_MUTATION:mutation?'workflow-auth':''}});
const log=(run.stdout??'')+(run.stderr??'');writeFileSync(join(dir,'output.log'),log);
writeFileSync(join(dir,'result.json'),JSON.stringify({mutation,exitCode:run.status,signal:run.signal,error:run.error?.message},null,2));
process.stdout.write(log);console.log('P2-06 evidence: '+dir);
if(run.error)throw run.error;process.exitCode=run.status??1;
