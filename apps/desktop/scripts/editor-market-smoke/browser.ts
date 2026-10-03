import { app, BrowserWindow, ipcMain, session } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { desktopCsp } from "@main/lib/desktopCsp.js";
const data=mkdtempSync(join(tmpdir(),'mcode-csp-fixture-'));
app.setPath('userData',data);app.disableHardwareAcceleration();
let server:http.Server;
const timer=setTimeout(()=>finish(1,'Fixture timeout'),30000);
function finish(code:number,message?:string){if(message)console.log(message);clearTimeout(timer);server?.close();app.exit(code);}
process.on('exit',()=>{try{rmSync(data,{recursive:true,force:true});}catch{/* Chromium locks may outlive exit; temp data only. */}});
app.whenReady().then(async()=>{
  server=http.createServer((_,response)=>{response.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'"});response.end("<!doctype html><script>parent.postMessage('editor-ready','*')</script>");});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const entry=pathToFileURL(join(__dirname,'index.html')).href;
  session.defaultSession.webRequest.onHeadersReceived((details,callback)=>{
    const csp=desktopCsp(details.url,entry,origin);
    if(!csp){callback({});return;}
    const headers={...details.responseHeaders};
    for(const name of Object.keys(headers))if(name.toLowerCase()==='content-security-policy')delete headers[name];
    callback({responseHeaders:{...headers,'Content-Security-Policy':[csp]}});
  });
  const win=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  ipcMain.on('fixture:result',(event,result)=>{
    if(event.sender!==win.webContents||event.senderFrame?.parent)return;
    for(const label of result.results??[])console.log('PASS '+label);
    finish(result.ok?0:1,result.ok?'PASS Electron CSP/progress fixture':result.error);
  });
  await win.loadURL(entry+'?office='+encodeURIComponent(origin));
}).catch(error=>finish(1,String(error)));
