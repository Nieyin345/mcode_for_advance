const {app}=require('electron');
const {join,isAbsolute}=require('node:path');
const {mkdirSync,writeFileSync}=require('node:fs');
const dir=process.env.MCODE_PANE_U1_DIR;
if(!dir||!isAbsolute(dir))throw Error('isolated MCODE_PANE_U1_DIR required');
for(const name of ['userData','sessionData','logs','crashDumps','home']){
  mkdirSync(join(dir,name),{recursive:true});app.setPath(name,join(dir,name));
}
mkdirSync(join(dir,'data'),{recursive:true});
writeFileSync(join(dir,'userData/data-root.json'),JSON.stringify({root:join(dir,'data')}));
app.on('window-all-closed',()=>{});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
const timeout=setTimeout(()=>{console.error('Pane U1 timed out');app.exit(97)},145000);
app.whenReady().then(async()=>{
  try{const {runPaneProbe}=require(join(dir,'probe.cjs'));const ok=await runPaneProbe(dir);
    clearTimeout(timeout);app.exit(ok?0:1);
  }catch(e){console.error(e);clearTimeout(timeout);app.exit(1)}
});
