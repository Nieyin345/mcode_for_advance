import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
assert.ok(existsSync(join(desktop,'src/main/modules/ModuleHost.ts')), 'module capability host must exist (feature is not implemented yet)');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=readdirSync(pnpm).find(n=>n.startsWith('esbuild@'));if(!pkg)throw Error('Installed esbuild required');
const {build}=await import(pathToFileURL(join(pnpm,pkg,'node_modules/esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/module-platform-'));
await build({entryPoints:[join(desktop,'scripts/module-platform-smoke/main.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),tsconfig:join(desktop,'tsconfig.json'),alias:{'@main/modules/service.js':join(desktop,'scripts/module-platform-smoke/stubs/service.ts')},plugins:process.env.MODULE_MUTATION==='no-auth'?[{name:'mutation-proof',setup(b){b.onLoad({filter:/ModuleHost\.ts$/},args=>{const source=readFileSync(args.path,'utf8');if(!source.includes('await this.options.authorize(resource);'))throw Error('mutation target missing');return {contents:source.replace('await this.options.authorize(resource);',''),loader:'ts'};});}}]:[],banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
const result=spawnSync(process.execPath,[join(dir,'test.mjs')],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;
