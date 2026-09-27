// Isolated feature window, not the user's running application or its data root.
const {app}=require('electron');
const {mkdirSync,writeFileSync}=require('node:fs');
const {join,isAbsolute}=require('node:path');
const dir=process.env.P2_NATIVE_DIR;
if(!dir||!isAbsolute(dir))throw Error('An absolute isolated P2_NATIVE_DIR is required');
for(const name of ['userData','sessionData','logs','crashDumps','home']){
 const path=join(dir,name);mkdirSync(path,{recursive:true});app.setPath(name,path);
}
mkdirSync(join(dir,'data'),{recursive:true});
writeFileSync(join(dir,'userData/data-root.json'),JSON.stringify({root:join(dir,'data')}));
// Only the launcher decides success; closing the last feature window must not
// turn an assertion failure into Electron's implicit exit 0.
app.on('window-all-closed',()=>{});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const timeout=setTimeout(()=>{console.error('Isolated feature window timed out');app.exit(97);},100000);
app.whenReady().then(async()=>{
 try{if(process.env.P2_NATIVE_EARLY_EXIT==='1'){console.log('SIMULATED_NATIVE_EARLY_EXIT');clearTimeout(timeout);app.exit(0);return;}const {runNativeProbe}=require(join(dir,'native-main.cjs'));await runNativeProbe(dir,process.env.P2_NATIVE_PHASE||'create');clearTimeout(timeout);app.exit(0);}
 catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
});
