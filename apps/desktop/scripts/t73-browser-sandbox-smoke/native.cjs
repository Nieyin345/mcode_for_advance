// Run after a successful electron-vite build. Isolated local data: never launch Mcode.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname,'../..');
const req = createRequire(path.join(root,'package.json'));
const ts = req('typescript');
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const selector={};
new Function('exports',compile(fs.readFileSync(path.join(root,'src/main/browser/selectorBuilder.ts'),'utf8')))(selector);
const picker={};
new Function('require','exports',compile(fs.readFileSync(path.join(root,'src/main/browser/pickerScript.ts'),'utf8')))(
 name => {if(name==='./selectorBuilder.js')return selector;throw Error('unknown picker dependency '+name);},picker);
const tempRoot=path.join(root,'.tmp');fs.mkdirSync(tempRoot,{recursive:true});
const dir=fs.mkdtempSync(path.join(tempRoot,'t73-electron-'));
fs.writeFileSync(path.join(dir,'picker-injection.txt'),picker.PICKER_INJECT_SCRIPT);
console.log('T73 Electron fixture: '+dir);
const env={...process.env,MCODE_T73_DIR:dir,MCODE_T73_DESKTOP:root,
  HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),APPDATA:path.join(dir,'userData'),
  LOCALAPPDATA:path.join(dir,'localappdata'),TEMP:path.join(dir,'temp'),TMP:path.join(dir,'temp')};
for(const key of ['home','userData','localappdata','temp'])fs.mkdirSync(path.join(dir,key),{recursive:true});
delete env.ELECTRON_RUN_AS_NODE;
const electron=req('electron');
if(typeof electron!=='string'||!fs.existsSync(electron))throw Error('installed Electron binary required');
const result=spawnSync(electron,[path.join(__dirname,'electron-host.cjs')],{
  cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,windowsHide:true});
const log=(result.stdout||'')+'\n'+(result.stderr||'');
fs.writeFileSync(path.join(dir,'host.log'),log);
process.stdout.write(log);
if(result.status!==0)throw Error('Electron isolated check failed '+result.status+': '+(result.error?.message??'see host.log'));
