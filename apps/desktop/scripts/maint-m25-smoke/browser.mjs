// Self-contained copy of the ui-interaction-smoke CDP harness (via MAINT M22).
// Own browser binary lookup, own temp profile, random port; never attaches to an existing browser.
// Audit-only CDP driver. Own browser/profile/port, never attaches to an existing browser.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export async function withAuditPage(dir, fn) {
  if (process.env.MCODE_TEST_BROWSER && !existsSync(process.env.MCODE_TEST_BROWSER)) throw new Error("MCODE_TEST_BROWSER does not exist");
  const browser = [
    process.env.MCODE_TEST_BROWSER,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find(p => p && existsSync(p));
  if (!browser) throw new Error('No installed Chromium browser; not installing one.');
  const allowed = new Map([['/index.html','text/html; charset=utf-8'],['/bundle.js','text/javascript; charset=utf-8'],['/app.css','text/css; charset=utf-8']]);
  const server = createServer((req,res) => {
    const path = new URL(req.url ?? '/', 'http://audit.invalid').pathname;
    const type = allowed.get(path);
    if (!type) {res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self';script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self' data:;connect-src 'none';worker-src 'none'"});
    res.end(readFileSync(join(dir,path.slice(1))));
  });
  // **端口要能被 fetch 拨通。** `listen(0)` 让 OS 随便给一个,但它会给到 fetch spec 的
  // 黑名单端口(IRC 6665-6669/6679/6697、SIP 5060-5061、X11 6000…),那种端口 undici 在
  // 发包前就抛 `bad port` —— 整套崩。与 `src/main/lib/loopbackPort.ts` 同一件事,这里内联
  // 一份最小实现(本文件拷到临时目录后直接 import,不打包,引不到那个 TS 模块)。
  const AUDIT_BAD_PORTS = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,138,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
  let auditPort = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const p = server.address().port;
    if (!AUDIT_BAD_PORTS.has(p)) { auditPort = p; break; }
    await new Promise(resolve => server.close(() => resolve()));
  }
  if (!auditPort) throw new Error('failed to bind a fetch-dialable audit port after 5 attempts');
  const base = `http://127.0.0.1:${auditPort}/index.html`;
  const profile = mkdtempSync(join(dir,'.audit-browser-'));
  const child = spawn(browser,[
    ...(process.platform==='linux' && process.getuid?.()===0 ? ['--no-sandbox'] : []),
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars',
    '--disable-extensions','--disable-sync','--disable-background-networking','--disable-component-update',
    `--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','about:blank',
  ],{stdio:'ignore',detached:process.platform!=='win32'});
  let spawnError;child.on('error',e=>{spawnError=e;});
  let ws;let cleaned=false;
  const cleanup=()=>{
    if(cleaned)return;cleaned=true;
    ws?.close();
    if(child.pid && child.exitCode===null && child.signalCode===null){
      if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
      else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    }
    server.close();
    try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(e){console.log('Owned profile cleanup deferred: '+e.message);}
  };
  const interrupt=()=>{cleanup();process.exit(130);};
  process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  const hard=setTimeout(()=>{console.error('Audit browser hard timeout');cleanup();process.exit(1);},180000);
  try{
    const deadline=Date.now()+25000;
    const activePort=join(profile,'DevToolsActivePort');
    // Windows: the browser may still hold the file exclusively right after
    // creating it (EBUSY) — poll the READ, not just existence.
    let portText='';
    for(;;){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null)throw new Error('Owned browser exited before publishing its port');
      if(Date.now()>deadline)throw new Error('Owned browser did not publish DevToolsActivePort');
      if(existsSync(activePort)){
        try{portText=readFileSync(activePort,'utf8');}catch{portText='';}
        if(portText.trim())break;
      }
      await sleep(100);
    }
    const [port]=portText.trim().split(/\r?\n/);
    if(!/^\d+$/.test(port))throw new Error('Invalid owned browser port');
    const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target=targets.find(x=>x.type==='page');
    if(!target)throw new Error('Owned browser has no page');
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let seq=0;const pending=new Map();const exceptions=[];
    ws.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data));
      if(message.id && pending.has(message.id)){
        const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);
        if(message.error)p.reject(new Error(JSON.stringify(message.error)));else p.resolve(message.result);
      }else if(message.method==='Runtime.exceptionThrown'){
        const d=message.params.exceptionDetails;exceptions.push(d.exception?.description ?? d.text);
      }
    });
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
    });
    await send('Runtime.enable');await send('Page.enable');
    const page={
      exceptions,send,sleep,
      async eval(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);return r.result?.value;},
      async waitFor(expression,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await page.eval(`!!(${expression})`))return true;await sleep(100);}throw new Error('UI wait timeout: '+expression+'; exceptions='+exceptions.join('\n'));},
      async size(width,height){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(200);},
      async goto(params='',ready='window.__ready && document.querySelector("[role=tablist]")'){await page.eval('window.__ready=false');exceptions.length=0;await send('Page.navigate',{url:base+(params?'?'+params:'')});await page.waitFor(ready);await sleep(250);},
      async screenshot(name){const r=await send('Page.captureScreenshot',{format:'png'});if(!r.data)throw new Error('Missing screenshot');writeFileSync(join(dir,name),Buffer.from(r.data,'base64'));},
    };
    await page.size(1440,900);
    await fn(page);
  }finally{clearTimeout(hard);cleanup();process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);}
}

