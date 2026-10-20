/** Five separate real no-network extension executions, targeting only local loopback. */
import { createServer } from "node:net";
import { runPermissionedProcess } from "../../src/main/modules/permissionedProcessRunner.js";
const server = createServer(socket => { socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"); });
await new Promise<void>((resolve, reject) => {server.once("error", reject);server.listen(0, "127.0.0.1", resolve);});
const address = server.address();
if (!address || typeof address === "string") throw Error("No loopback port");
const port = address.port;
const bodies: readonly [string, string][] = [
  ["net.connect", `const net=require("node:net"); const result=await new Promise((done)=>{const s=net.connect({host:"127.0.0.1",port:${port}});s.once("connect",()=>{s.destroy();done("connected")});s.once("error",e=>done("error:"+e.code));});return {text:result};`],
  ["dns.lookup", `const dns=require("node:dns");const result=await new Promise(done=>dns.lookup("localhost",(e,ip)=>done(e?"error:"+e.code:"resolved-local:"+ip)));return {text:result};`],
  ["worker_threads", `const {Worker}=require("node:worker_threads");const worker=new Worker(` + JSON.stringify(`const {parentPort}=require("node:worker_threads");const net=require("node:net");const s=net.connect({host:"127.0.0.1",port:${port}});s.once("connect",()=>{parentPort.postMessage("connected");s.destroy()});s.once("error",e=>parentPort.postMessage("error:"+e.code));`) + `,{eval:true});const result=await new Promise(done=>{worker.once("message",done);worker.once("error",e=>done("error:"+e.code));setTimeout(()=>done("error:timeout"),600)});await worker.terminate();return {text:result};`],
  ["process.binding(tcp_wrap)", `const wrap=process.binding("tcp_wrap");const tcp=new wrap.TCP(wrap.constants.SOCKET);const req=new wrap.TCPConnectWrap();const result=await new Promise(done=>{req.oncomplete=(status)=>done(status===0?"connected":"error:tcp:"+status);const code=tcp.connect(req,"127.0.0.1",${port});if(code!==0)done("error:tcp:"+code);setTimeout(()=>done("error:timeout"),500)});tcp.close();return {text:result};`],
  ["fetch", `const response=await fetch("http://127.0.0.1:${port}/", {signal:AbortSignal.timeout(650)});return {text:response.ok?"connected":"error:http:"+response.status};`],
];
let blocked = 0, notBlocked = 0, failed = 0;
try {
  for (const [method, body] of bodies) {
    const source = "({ inspect: async () => { try { " + body + " } catch(e) { const m=String(e&&e.message||e); return {text:/network_access_denied|ERR_ACCESS_DENIED|operation not permitted|EPERM|EACCES/.test(m)?\"blocked\":\"error:\"+(e.code||m).slice(0,100)} } } })";
    let result: string;
    try {
      const answer = await runPermissionedProcess({ source, capability:"inspect", allowWrite:false,
        resource:{projectPath:".",path:"mc035-virtual-resource"}, timeoutMs:3500,
        signal:new AbortController().signal });
      result = String(answer.text || "error:no-result");
    } catch (e) {
      const m=String(e);
      result = /egress_isolation_unavailable|network_guard_setup_failed|network_guard_integrity_failed/.test(m) ? "blocked" : "error:"+m.slice(0,115);
    }
    if (result === "blocked") blocked++; else if (result === "connected" || result.startsWith("resolved-local:")) notBlocked++; else failed++;
    console.log("method="+method+" result="+result);
  }
} finally {server.close();}
console.log("mc035-egress-probe: blocked="+blocked+" connected-or-local="+notBlocked+" error="+failed+" total="+bodies.length);
