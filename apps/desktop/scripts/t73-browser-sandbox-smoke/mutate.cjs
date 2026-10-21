// T73 mutation gate: bytes backed up in memory, restored in finally, hashed.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const cases=[
  {file:'src/main/browser/BrowserManager.ts',old:'sandbox: true,',replacement:'sandbox: false,',name:'sandbox'},
  {file:'src/preload/browserPicker.ts',old:'ipcRenderer.send("__mcode_pick_result__", {',replacement:'ipcRenderer.send("__mcode_pick_mutated__", {',name:'picker'}
];
for(const item of cases){
 const filename=path.join(root,item.file),original=fs.readFileSync(filename);
 const prior=original.toString('utf8');
 const matches=prior.split(item.old).length-1;
 if(matches!==1)throw Error(item.name+' must match exactly once, matched '+matches);
 let result;
 try {
   fs.writeFileSync(filename,prior.replace(item.old,item.replacement));
   if(sha(fs.readFileSync(filename))===sha(original))throw Error(item.name+' mutation not applied');
   result=spawnSync(process.execPath,[path.join(__dirname,'run.cjs')],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
   if(result.status===0 || !result.stderr?.includes('FAIL'))throw Error(item.name+' mutant did not turn check RED: '+(result.stderr||result.stdout||result.error));
   console.log('PASS mutation '+item.name+' -> RED (exit '+result.status+')');
 } finally {
   fs.writeFileSync(filename,original);
   if(sha(fs.readFileSync(filename))!==sha(original))throw Error('restore SHA mismatch for '+item.file);
   console.log('PASS restored byte-for-byte '+item.file+' SHA256 '+sha(original));
 }
}
