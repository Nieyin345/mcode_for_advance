// Isolated installed-Electron proof: no production app, logins, or network.
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.MCODE_T73_DIR;
if (!dir || !path.isAbsolute(dir)) throw Error('MCODE_T73_DIR must be an absolute fixture path');
for (const key of ['userData','sessionData','logs','home']) {
  const p = path.join(dir, key); fs.mkdirSync(p, {recursive:true}); app.setPath(key, p);
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('T73 ELECTRON TIMEOUT'); app.exit(91); }, 45000);
const assert = require('node:assert/strict');
async function run() {
  await app.whenReady();
  const root = process.env.MCODE_T73_DESKTOP;
  const preload = path.join(root, 'out/preload/browserPicker.cjs');
  assert.ok(fs.existsSync(preload), 'missing CJS preload from real build');
  const win = new BrowserWindow({show:false,width:640,height:480,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const ses = session.fromPartition('t73-isolated-memory', {cache:false});
  const prefs = {preload,session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false};
  const view = new WebContentsView({webPreferences:prefs});
  win.contentView.addChildView(view);
  view.setBounds({x:0,y:0,width:640,height:480});
  const received = [];
  ipcMain.on('__mcode_pick_result__', (event, data) => {
    if (event.sender !== view.webContents) throw Error('picker wrong sender');
    assert.equal(event.senderFrame,event.sender.mainFrame,'picker must originate from top frame');
    received.push(data);
  });
  const page = "<!doctype html><html><head><meta charset='utf-8'></head><body style='margin:0'><button id='pick' style='position:absolute;left:10px;top:10px;width:250px;height:100px'>TEST PICK</button></body></html>";
  await view.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
  const bridge = await view.webContents.executeJavaScript("({bridge:typeof window.mcodeBridge?.pickElement,require:typeof require,process:typeof process,ipc:typeof window.ipcRenderer})");
  assert.equal(bridge.bridge,'function', 'actual sandboxed preload was not injected');
  assert.equal(bridge.require,'undefined', 'page sees require');
  assert.equal(bridge.process,'undefined', 'page sees process');
  assert.equal(bridge.ipc,'undefined', 'page sees raw IPC');
  await view.webContents.executeJavaScript("window.mcodeBridge.pickElement({selector:'#pick',outerHTML:'forged'})");
  assert.equal(received.length,0, 'direct forged picker call accepted');
  await view.webContents.executeJavaScript("document.querySelector('#pick').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  assert.equal(received.length,0, 'synthetic click accepted');
  const pickerCode = fs.readFileSync(path.join(dir, 'picker-injection.txt'),'utf8');
  await view.webContents.executeJavaScript(pickerCode);
  // Chromium mouse event is trusted; no production origin/session or real credential.
  view.webContents.focus();
  view.webContents.sendInputEvent({type:'mouseMove',x:40,y:40});
  view.webContents.sendInputEvent({type:'mouseDown',x:40,y:40,button:'left',clickCount:1});
  view.webContents.sendInputEvent({type:'mouseUp',x:40,y:40,button:'left',clickCount:1});
  for(let i=0;i<50 && !received.length;i++) await new Promise(r=>setTimeout(r,80));
  assert.equal(received.length,1,'trusted WebContentsView click did not reach real picker preload');
  assert.equal(received[0].selector,'#pick');
  assert.match(received[0].outerHTML, /TEST PICK/);
  assert.equal(received[0].url,view.webContents.getURL());
  assert.equal(view.webContents.getLastWebPreferences().sandbox,true);
  console.log('PASS installed Electron sandboxed WebContentsView, context bridge, spoof rejects, real picked element and IPC sender');
  win.destroy();
}
run().then(()=>{clearTimeout(watchdog);app.exit(0);}).catch(e=>{console.error('FAIL T73 ELECTRON: '+(e.stack||e));clearTimeout(watchdog);app.exit(1);});
