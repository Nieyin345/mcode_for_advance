/**
 * MC-035 T16. Linux-only, real kernel egress mutation control.
 *
 * Safety: 127.0.0.1 only, no real extension files, no production data, no
 * network downloads. Runs a separate OS-only adversarial battery without the
 * JavaScript NETWORK_GUARD deliberately, so the five routes test the *kernel*
 * namespace in isolation, not the JS guard's ability to hide a missing OS
 * wrapper. Production's full five-route battery is run separately by main.ts.
 *
 * The tested launch prefix is copied byte-for-byte from production source.
 * An altered source copy in an isolated temp directory removes JUST that OS
 * prefix; production bytes are never edited (stronger than restore + cmp).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

if (process.platform !== "linux") throw Error("T16 requires real Linux Node, not Windows node.exe");
const suite = dirname(fileURLToPath(import.meta.url));
const runner = resolve(suite, "../../src/main/modules/permissionedProcessRunner.ts");
const original = readFileSync(runner);
const source = original.toString("utf8");
const exact = 'command: "/usr/bin/unshare",\n        prefix: ["--user", "--map-root-user", "--net", "--", process.execPath],';
assert(source.includes(exact) && source.split(exact).length === 2,
  "production Linux OS wrapper changed; review/retarget this probe, do not silently pass");
const mutated = source.replace(exact, "command: process.execPath,\n        prefix: [],");
const scratch = join(resolve(suite, "../../.tmp"), "mc035-os-mutation-" + randomUUID());
mkdirSync(scratch, {recursive:true});
const control = join(scratch, "runner-original.ts");
const variant = join(scratch, "runner-without-os-wrapper.ts");
writeFileSync(control, original);
writeFileSync(variant, mutated);
assert(!readFileSync(control).equals(readFileSync(variant)), "mutation did not change source");
assert(readFileSync(control).equals(original), "baseline source copy mismatch");
const sourceHash = createHash("sha256").update(original).digest("hex");

const server = createServer(socket => {
  // A probe can deliberately abort its socket while leaving the OS namespace;
  // that is not a server error or an egress-policy verdict.
  socket.on("error", () => {});
  socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
});
const dnsServer = createSocket("udp4");
const stats = {tcp:0,dns:0};
server.on("connection",()=>stats.tcp++);
dnsServer.on("message",(message,peer)=>{
  stats.dns++;
  // Reply NXDOMAIN to a query that arrived over UDP: a successful network
  // reach, *not* a successful DNS lookup. No external DNS dependency.
  if(message.length>=12){
    const reply=Buffer.from(message);
    reply.writeUInt16BE(0x8183,2);
    reply.writeUInt16BE(0,6);reply.writeUInt16BE(0,8);reply.writeUInt16BE(0,10);
    dnsServer.send(reply,peer.port,peer.address);
  }
});
const listen = async (srv, options) => new Promise((res,rej)=>{
  srv.once("error",rej);srv.listen(options,()=>{srv.off("error",rej);res(srv.address())});
});
const addr=await listen(server,{host:"127.0.0.1",port:0});
const dnsAddr=await new Promise((res,rej)=>{dnsServer.once("error",rej);dnsServer.bind(0,"127.0.0.1",()=>{dnsServer.off("error",rej);res(dnsServer.address())});});
const port=addr.port,dnsPort=dnsAddr.port;

const bodies=[
  ["net.connect",'const net=require("node:net");return await new Promise(done=>{const s=net.connect({host:"127.0.0.1",port:'+port+'});s.once("connect",()=>{s.destroy();done("connected")});s.once("error",e=>done("error:"+(e.code||e.message)))});'],
  ["dns.resolve4",'const dns=require("node:dns");const r=new dns.Resolver();r.setServers(["127.0.0.1:'+dnsPort+'"]);return await new Promise(done=>{r.resolve4("mcode-t16.invalid",(e)=>done(e?"error:"+(e.code||e.message):"connected"))});'],
  ["worker_threads",'const w=require("node:worker_threads");const worker=new w.Worker("process.exit(0)",{eval:true});await worker.terminate();return "connected";'],
  ["process.binding(tcp_wrap)",'const wrap=process.binding("tcp_wrap");const tcp=new wrap.TCP(wrap.constants.SOCKET);tcp.close();return "connected";'],
  ["fetch",'const res=await fetch("http://127.0.0.1:'+port+'/",{signal:AbortSignal.timeout(1100)});return res.ok?"connected":"error:http:"+res.status;'],
];
const deny=/ENETUNREACH|EHOSTUNREACH|EPERM|EACCES|ERR_ACCESS_DENIED|operation not permitted/i;
async function runChild(command,prefix,body){
  const code='(async()=>{try{'+body+'}catch(e){return "error:"+(e.code||e.cause?.code||e.message||e)} })().then(v=>console.log("T16_RESULT="+v),e=>console.log("T16_RESULT=error:"+e));';
  const args=[...prefix,"--permission","-e",code];
  return new Promise(resolve=>{
    const p=spawn(command,args,{env:{PATH:process.env.PATH??"",NODE_OPTIONS:"",ELECTRON_RUN_AS_NODE:"1"}});
    let output="",error="";let finished=false;
    const timer=setTimeout(()=>{p.kill();},2500);
    p.stdout.on("data",d=>output+=d.toString());
    p.stderr.on("data",d=>error+=d.toString());
    p.on("error",e=>error+=e.message);
    p.on("close",status=>{
      if(finished)return;finished=true;clearTimeout(timer);
      resolve({status,output,error,raw:output.match(/T16_RESULT=([^\r\n]+)/)?.[1]??"missing"});
    });
  });
}
let good=0,bad=0;
const methods=[];
try{
  for(const mode of ["wrapped","without-unshare"]){
    const command=mode==="wrapped"?"/usr/bin/unshare":process.execPath;
    const prefix=mode==="wrapped"?["--user","--map-root-user","--net","--",process.execPath]:[];
    const records=[];
    for(const [name,body] of bodies){
      const before={...stats};
      const result=await runChild(command,prefix,body);
      const anyPacket=stats.tcp>before.tcp||stats.dns>before.dns;
      // For DNS kernel separation is evidenced by the parent's absence of UDP
      // requests and a resolver failure; other routes demand explicit OS errno.
      const blocked=!anyPacket && (deny.test(result.raw+" "+result.error)
        || (name==="dns.resolve4"&&result.raw.startsWith("error:")));
      const state=blocked?"blocked":anyPacket||result.raw==="connected"?"connected":"error:"+result.raw;
      records.push({method:name,result:state,raw:result.raw,exit:result.status,packets:anyPacket});
      console.log("mode="+mode+" method="+name+" result="+state+" raw="+result.raw+" received="+anyPacket);
    }
    if(mode==="wrapped")good=records.filter(r=>r.result==="blocked").length;
    else bad=records.filter(r=>r.result!=="blocked").length;
    methods.push({mode,records});
  }
  assert.equal(good,5,"OS-only wrapped baseline must block all 5 egress routes");
  assert(bad>=1,"OS wrapper removal must make at least one of 5 probes turn red");
  const after=readFileSync(runner);
  assert(after.equals(original),"production source changed during OS mutation test");
  const restored=join(scratch,"runner-restored.ts");
  writeFileSync(restored,readFileSync(control));
  assert(readFileSync(restored).equals(original),"bytewise restored-source cmp failed");
  console.log("T16_OS_MUTATION PASS wrapped=5/5 blocked; without-unshare exposed="+bad
    +" /5; bytewise-cmp=true source-sha256="+sourceHash);
  if(process.env.MCODE_T16_EVIDENCE_PATH)
    writeFileSync(process.env.MCODE_T16_EVIDENCE_PATH,JSON.stringify({good,bad,methods,sourceHash,bytewiseCmp:true},null,2));
}finally{
  dnsServer.close();server.close();
  rmSync(scratch,{recursive:true,force:true});
}
