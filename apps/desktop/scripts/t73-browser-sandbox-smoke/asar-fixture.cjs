// Isolated ASAR fixture: prove supplemental post-package gate goes green and red.
// Not a substitute for a real win-unpacked Electron distribution.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const req=createRequire(path.join(root,'package.json'));
const br=createRequire(req.resolve('electron-builder'));
const lr=createRequire(br.resolve('app-builder-lib'));
const asar=lr('@electron/asar');
(async()=>{
  fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});
  const fixture=fs.mkdtempSync(path.join(root,'.tmp','t73-asar-'));
  const source=path.join(fixture,'source','out','preload');
  const unpacked=path.join(fixture,'unpacked');
  fs.mkdirSync(source,{recursive:true});
  fs.mkdirSync(path.join(unpacked,'resources'),{recursive:true});
  for(const name of ['index.mjs','browserPicker.mjs','browserPicker.cjs']){
    fs.copyFileSync(path.join(root,'out','preload',name),path.join(source,name));
  }
  const archive=path.join(unpacked,'resources','app.asar');
  const check=()=>spawnSync(process.execPath,[path.join(__dirname,'verify-package.cjs'),unpacked],{
    cwd:root,encoding:'utf8',timeout:60000});
  await asar.createPackage(path.join(fixture,'source'),archive);
  const good=check();
  assert.equal(good.status,0,good.stderr||good.stdout);
  console.log('PASS packaged CJS gate on isolated ASAR (3 preload assets)');
  fs.unlinkSync(path.join(source,'browserPicker.cjs'));
  await asar.createPackage(path.join(fixture,'source'),archive);
  const bad=check();
  assert.notEqual(bad.status,0,'missing CJS passed packaged asset gate');
  assert.match(bad.stderr,/missing sealed packaged preload/);
  console.log('PASS missing browserPicker.cjs ASAR mutation -> RED');
})().catch(error=>{console.error(error);process.exitCode=1;});
