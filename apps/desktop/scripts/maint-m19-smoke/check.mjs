import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const repo=resolve(desktop,'../..');
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/maint-m19-check-'));
const jobs=[['typecheck',process.execPath,[join(desktop,'node_modules/typescript/bin/tsc'),'--noEmit','-p',join(desktop,'scripts/maint-m19-smoke/tsconfig.json'),'--pretty','false']],
 ['diff-check','git',['diff','--check','--','apps/desktop/src/main/notifications/NotificationManager.ts','apps/desktop/scripts/maint-m19-smoke','docs/parallel-maintenance/reports/M19.md']]];
const results=[];
for(const [name,cmd,args] of jobs){const r=spawnSync(cmd,args,{cwd:repo,encoding:'utf8',timeout:120000});
 const text=(r.stdout??'')+(r.stderr??'');writeFileSync(join(dir,name+'.log'),text);
 results.push({name,command:[cmd,...args],exitCode:r.status,error:r.error?.message});console.log(name+': exit '+r.status+' '+text);}
writeFileSync(join(dir,'results.json'),JSON.stringify(results,null,2));console.log('M19 check evidence: '+dir);
process.exitCode=results.some(r=>r.exitCode!==0)?1:0;
