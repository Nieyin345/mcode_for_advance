import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const suite=dirname(fileURLToPath(import.meta.url)), desktop=resolve(suite,'../..');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));if(!pkg)throw Error('Installed esbuild required; never install');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/maint-m19-'));
const alias=Object.fromEntries(['electron','@main/lib/logger.js','@main/window.js','@main/store/repositories.js','@main/claude/RuntimeManager.js'].map(n=>[n,join(suite,'stubs/environment.ts')]));
const built=await build({entryPoints:[join(suite,'main.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'main.mjs'),tsconfig:join(desktop,'tsconfig.json'),alias,metafile:true,
 banner:{js:"import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {dirname} from 'node:path';const require=createRequire(import.meta.url);const __dirname=dirname(fileURLToPath(import.meta.url));"}});
const hashes={};for(const p of Object.keys(built.metafile.inputs))hashes[p]=createHash('sha256').update(readFileSync(resolve(p))).digest('hex');
writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const run=spawnSync(process.execPath,[join(dir,'main.mjs')],{encoding:'utf8',timeout:30000,env:{...process.env,MAINT_M19_DIR:dir}});
const text=(run.stdout??'')+(run.stderr??'');process.stdout.write(text);writeFileSync(join(dir,'output.log'),text);
writeFileSync(join(dir,'result.json'),JSON.stringify({exitCode:run.status,signal:run.signal,error:run.error?.message},null,2));
console.log('M19 evidence: '+dir);if(run.error)throw run.error;process.exitCode=run.status??1;
