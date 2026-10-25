import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureGenofficeNativeViews, installGenofficeNativeProtocol } from "@main/document/genofficeViewFactories.js";
import { deliveries, protocol } from "./electron";
import { configs } from "./vendor";
let pass=0,fail=0;
function check(name:string,ok:boolean,detail?:unknown){if(ok)pass++;else fail++;console.log((ok?"  ok   ":"  FAIL ")+name+(ok?"":" "+JSON.stringify(detail)));}
async function main(){
  const tmp=await mkdtemp(join(tmpdir(),"mcode-office-protocol-"));
  try{
    const base=join(tmp,"genoffice");
    for(const kind of ["pdf","markdown","html","sheets","slides"]){
      const src=join(base,"apps",kind,"out");
      await mkdir(join(src,"renderer","assets"),{recursive:true});
      await mkdir(join(src,"preload"),{recursive:true});
      await writeFile(join(src,"renderer","index.html"),"editor");
      await writeFile(join(src,"renderer","assets","chunk.js"),"bundle");
      await writeFile(join(src,"preload","index.js"),"secure preload");
    }
    const cli=join(base,"packages","cli","dist","genoffice.cjs");
    await mkdir(join(base,"packages","cli","dist"),{recursive:true});
    await writeFile(cli,"");
    const sidecar=join(base,"apps","sheets","native","xlsx-engine","target","release",
      process.platform==="win32"?"xlsx-sidecar.exe":"xlsx-sidecar");
    await mkdir(join(sidecar,".."),{recursive:true});
    await writeFile(sidecar,"fake");
    const avail=configureGenofficeNativeViews(cli);
    check("five native editor runtimes configure inside Mcode",Object.values(avail).every(Boolean),avail);
    check("factory configures vendor once",configs.length===1,configs.length);
    installGenofficeNativeProtocol();
    const handler=protocol.handlers.get("genoffice-app");
    check("Electron registered exactly one in-app renderer asset handler",typeof handler==="function",[...protocol.handlers.keys()]);
    if(!handler) return;
    const pending=handler({url:"genoffice-app://pdf/assets/chunk.js"});
    check("asset handler returns Promise immediately, never synchronous fs result",typeof (pending as Promise<Response>).then==="function");
    const successful=await pending;
    check("Mcode native editor asset is delivered via local net.fetch",successful.status===200 &&
      (await successful.text())==="from-mcode-native-office",successful.status);
    check("no separate GenOffice HTTP server needed for chunk",deliveries.length===1 &&
      deliveries[0]!.startsWith("file:"),deliveries);
    for(const url of [
      "genoffice-app://unknown/index.html",
      "https://pdf/index.html",
      "genoffice-app://pdf/missing.js",
      "genoffice-app://pdf/%GG",
      "genoffice-app://pdf/%2e%2e%2fsecret.js",
    ]){
      const res=await handler({url});
      check("host resource protocol refuses "+url,res.status===404,res.status);
    }
    const outside=join(tmp,"private");
    await mkdir(outside,{recursive:true});
    await writeFile(join(outside,"token.js"),"token");
    try{
      await symlink(outside,join(base,"apps","pdf","out","renderer","assets","escape"),"junction");
      const escaped=await handler({url:"genoffice-app://pdf/assets/escape/token.js"});
      check("real protocol refuses symlink/junction escape",escaped.status===404);
    }catch(error){console.log("  note test junction unavailable: "+String(error));}
    const count=deliveries.length;
    const bulk=await Promise.all(Array.from({length:80},()=>handler({url:"genoffice-app://pdf/assets/chunk.js"})));
    check("80 concurrent local editor chunks all resolve without synchronous callback",
      bulk.every(r=>r.status===200) && deliveries.length===count+80);
  }finally{await rm(tmp,{recursive:true,force:true,maxRetries:3,retryDelay:30});}
  console.log("office-perf-protocol-smoke:"+pass+"/"+(pass+fail)+" passed");
  if(fail)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
