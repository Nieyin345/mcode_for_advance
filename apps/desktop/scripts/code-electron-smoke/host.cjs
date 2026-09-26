// Independent Electron fixture. Does not load MCode's main entry or open a window.
const {app}=require('electron');
const {mkdirSync}=require('node:fs');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const dir=__dirname;
for(const name of ['userData','sessionData','logs','crashDumps']){
  const path=join(dir,'electron-host-data',name);mkdirSync(path,{recursive:true});app.setPath(name,path);
}
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-background-networking');
const timeout=setTimeout(()=>{console.error('Isolated Electron probe host timeout');app.exit(97);},18000);
app.whenReady().then(async()=>{
  try{const probe=await import(pathToFileURL(join(dir,'code-native-probe.mjs')).href);const ok=await probe.runProbe('electron',dir);clearTimeout(timeout);app.exit(ok?0:1);}
  catch(error){console.error(error);clearTimeout(timeout);app.exit(2);}
});
