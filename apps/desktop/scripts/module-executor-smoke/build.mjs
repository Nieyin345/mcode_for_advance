import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const executor=join(desktop,'src/main/orchestration/moduleCapabilityExecutor.ts');
assert.ok(existsSync(executor),'module capability executor must exist (feature is not implemented yet)');
assert.ok(existsSync(join(desktop,'src/main/modules/ModuleHost.ts')),'module capability host must exist');

// 突变只作用在**临时打包产物**上,生产源码不动。每个突变都必须让对应断言真的红。
const MUTATIONS={
  'no-precancel':{
    find:'// 预取消：一次宿主调用都不发（interface-v2 §6）。\n    if (signal.aborted) return cancelledOutcome();',
    replace:'// 预取消：一次宿主调用都不发（interface-v2 §6）。',
  },
  'raw-progress':{
    find:'const percent = Math.min(100, Math.max(0, task.progress * 100));',
    replace:'const percent = Math.min(100, Math.max(0, task.progress));',
  },
  'no-late-cancel':{
    find:'if (signal.aborted) {\n        this.safeCancel(host, ref);\n        return cancelledOutcome();\n      }\n      return await this.awaitTask(',
    replace:'return await this.awaitTask(',
  },
  'no-cancel-on-abort':{
    find:'if (signal.aborted) {\n        this.safeCancel(host, ref);\n        return cancelledOutcome();\n      }\n      const remaining = deadline - Date.now();',
    replace:'if (signal.aborted) {\n        return cancelledOutcome();\n      }\n      const remaining = deadline - Date.now();',
  },
};
const mutation=process.env.MODULE_EXECUTOR_MUTATION;
if(mutation!==undefined&&!(mutation in MUTATIONS))throw Error('Unknown MODULE_EXECUTOR_MUTATION: '+mutation+' (expected one of '+Object.keys(MUTATIONS).join(', ')+')');

const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));if(!pkg)throw Error('Installed esbuild required');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/module-executor-'));
await build({
  entryPoints:[join(desktop,'scripts/module-executor-smoke/main.ts')],
  bundle:true,platform:'node',format:'esm',
  outfile:join(dir,'test.mjs'),
  tsconfig:join(desktop,'tsconfig.json'),
  plugins:mutation===undefined?[]:[{name:'mutation-proof',setup(b){
    const {find,replace}=MUTATIONS[mutation];
    b.onLoad({filter:/moduleCapabilityExecutor\.ts$/},args=>{
      const source=readFileSync(args.path,'utf8');
      if(!source.includes(find))throw Error('mutation target missing: '+mutation);
      return {contents:source.replace(find,replace),loader:'ts'};
    });
  }}],
  banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},
});
const result=spawnSync(process.execPath,[join(dir,'test.mjs')],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
