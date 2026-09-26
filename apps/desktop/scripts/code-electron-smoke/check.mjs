// Isolated Electron host regression; no application entry, windows, models or user DB.
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,mkdirSync,mkdtempSync,copyFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
const source=dirname(fileURLToPath(import.meta.url));const desktop=resolve(source,'../..');
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp','workflow-electron-'));
console.log('Electron workflow artifacts: '+dir);
const pnpm=join(desktop,'../../node_modules/.pnpm');const name=readdirSync(pnpm).filter(n=>n.startsWith('esbuild@')).sort().at(-1);
if(!name)throw new Error('Existing esbuild dependency required.');
const esbuild=await import(pathToFileURL(join(pnpm,name,'node_modules/esbuild/lib/main.js')).href);
await esbuild.build({entryPoints:[join(source,'probe.ts')],bundle:true,platform:'node',format:'esm',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,outfile:join(dir,'code-native-probe.mjs'),logLevel:'error'});
copyFileSync(join(source,'host.cjs'),join(dir,'host.cjs'));
const probe=await import(pathToFileURL(join(dir,'code-native-probe.mjs')).href);
if(!await probe.runProbe('node',dir))throw new Error('Node control failed.');
const require=createRequire(join(desktop,'package.json'));
const electron=require('electron');
if(typeof electron!=='string'||!existsSync(electron))throw new Error('Installed Electron executable not present; no download attempted.');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const flags=process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox']:[];
let command=electron,args=[...flags,join(dir,'host.cjs')];
if(process.platform==='linux'&&!env.DISPLAY){command='xvfb-run';args=['-a',electron,...args];}
let child;
const kill=()=>{
 if(!child?.pid||child.exitCode!==null)return;
 if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
 else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
};
const interrupt=()=>{kill();process.exit(130);};
process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
const timeout=setTimeout(()=>{console.error('Owned Electron host timed out');kill();},25000);
try{
 child=spawn(command,args,{cwd:dir,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',x=>process.stderr.write(x));
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 if(code!==0)throw new Error('Electron-hosted Node code failed: '+code);
 console.log('PASS: real Electron code runner naturally exits in Node mode.');
}finally{clearTimeout(timeout);kill();process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);}
