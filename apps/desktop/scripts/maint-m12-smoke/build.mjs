import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));if(!pkg)throw Error('Installed esbuild required');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/maint-m12-'));
const r=await build({entryPoints:[join(desktop,'scripts/maint-m12-smoke/main.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'main.mjs'),tsconfig:join(desktop,'tsconfig.json'),metafile:true,
 banner:{js:"import {createRequire as __m12cr} from 'node:module';import {fileURLToPath as __m12fp} from 'node:url';import {dirname as __m12dn} from 'node:path';const require=__m12cr(import.meta.url);const __filename=__m12fp(import.meta.url);const __dirname=__m12dn(__filename);"}});
const hashes={};for(const p of [...Object.keys(r.metafile.inputs),join(desktop,'src/renderer/components/browser/BrowserPanel.tsx')])hashes[p]=createHash('sha256').update(readFileSync(resolve(p))).digest('hex');writeFileSync(join(dir,'inputs.json'),JSON.stringify(hashes,null,2));
const run=spawnSync(process.execPath,[join(dir,'main.mjs')],{encoding:'utf8',timeout:30000,env:{...process.env,MAINT_M12_DIR:dir,MAINT_M12_DESKTOP:desktop}});
const text=(run.stdout??'')+(run.stderr??'');writeFileSync(join(dir,'output.log'),text);writeFileSync(join(dir,'result.json'),JSON.stringify({exitCode:run.status,signal:run.signal,error:run.error?.message},null,2));process.stdout.write(text);console.log('M12 evidence: '+dir);if(run.error)throw run.error;process.exitCode=run.status??1;
