// Negative controls: require the intended behavioral failure, not just exit 1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const suite=dirname(fileURLToPath(import.meta.url)),desktop=resolve(suite,'../..');
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/p2-06-native-controls-'));
const checks=[];
for(const flag of ['--mutation-save','--mutation-early-exit']){
 const child=spawnSync(process.execPath,[join(suite,'native-build.mjs'),flag],{cwd:desktop,encoding:'utf8',timeout:235000,maxBuffer:12*1024*1024});
 const log=(child.stdout??'')+(child.stderr??'');writeFileSync(join(dir,flag.slice(2)+'.log'),log);process.stdout.write(log);
 const path=log.split(/\r?\n/).filter(line=>line.startsWith('P2 native evidence: ')).at(-1)?.slice('P2 native evidence: '.length);
 assert.ok(path,'Native control must publish its fresh artifact directory');
 const result=JSON.parse(readFileSync(join(path,'result.json'),'utf8'));
 assert.equal(child.status,1);assert.equal(result.exitCode,1);assert.equal(result.mutation,true);
 if(flag==='--mutation-save'){
  const cases=JSON.parse(readFileSync(join(path,'create-checks.json'),'utf8'));
  assert.ok(cases.some(c=>c.status==='FAIL'&&c.name.startsWith('real save/import IPC')&&c.error.includes('native save accepted forbidden parameters')),'Must fail on actual native unsafe save acceptance');
  assert.equal(JSON.parse(readFileSync(join(path,'mutation.json'),'utf8')).kind,'remove-shared-strict-save-guard');
 }else{
  assert.match(log,/SIMULATED_NATIVE_EARLY_EXIT/);
  assert.equal(result.phases[0].exitCode,0);assert.equal(result.phases[0].complete,false);assert.equal(result.phases[0].checks,0);
 }
 checks.push({flag,expectedChildExit:1,actualChildExit:child.status,evidence:path,ok:true});
}
writeFileSync(join(dir,'results.json'),JSON.stringify(checks,null,2));
console.log('Native negative controls: 2/2; '+dir);
