/**
 * O16 non-UI: perf-sensitive Office-native IPC and geometry.
 * Fake WebContentsView + isolated throwaway asset tree only.
 */
import { mkdtemp, mkdir, writeFile, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DocumentViewHost, type DocumentViewLike, type DocumentViewHostWindow } from "@main/document/documentViewHost.js";

let passed=0, failed=0;
function check(name:string, ok:boolean, detail?:unknown):void {
  if (ok) passed++; else failed++;
  console.log((ok?"  ok   ":"  FAIL ")+name+(ok?"": " — "+JSON.stringify(detail)));
}
async function main() {
  const bounds: Array<{x:number;y:number;width:number;height:number}>=[];
  const window:DocumentViewHostWindow = {
    isDestroyed:()=>false,
    contentView:{addChildView(){},removeChildView(){}},
    on(){},removeListener(){},
  };
  let constructed=0,closed=0;
  const host=new DocumentViewHost({
    getMainWindow:()=>window,
    createView:()=> {
      constructed++;
      return {
        webContents:{
          loadURL:async()=>{},focus(){},close(){closed++;},
          setWindowOpenHandler(){},isDestroyed:()=>false,
        },
        setBounds(rect){bounds.push({...rect});},
      } satisfies DocumentViewLike;
    },
  });
  const initial={x:20,y:40,width:840,height:560};
  check("open initializes one live in-Mcode WebContentsView",
    host.open({docId:"office-perf",url:"file:///test/editor/index.html",bounds:initial,visible:true}).ok
    && constructed===1 && bounds.length===1,bounds);
  for (let i=0;i<100;i++) host.setBounds("office-perf", {...initial});
  check("100 identical layout measurements do NOT trigger 100 native view setBounds",
    bounds.length===1,{calls:bounds.length});
  const moved={x:21,y:43,width:839,height:562};
  host.setBounds("office-perf",moved);
  check("a real geometry change still repositions the WebContentsView once",
    bounds.length===2 && JSON.stringify(bounds.at(-1))===JSON.stringify(moved),bounds);
  for(let i=0;i<100;i++) host.setBounds("office-perf",{...moved});
  check("repeating new bounds after a genuine change is idempotent",bounds.length===2,bounds.length);
  host.hide("office-perf");
  const parkedCount=bounds.length;
  check("hiding keeps editor live but parks it once",
    parkedCount===3 && closed===0 && bounds.at(-1)?.x===-9999,bounds);
  for(let i=0;i<100;i++) host.setBounds("office-perf",{...moved});
  const hiddenNew={x:55,y:67,width:720,height:485};
  host.setBounds("office-perf",hiddenNew);
  check("hidden bounds updates do not trigger native layout",
    bounds.length===parkedCount,bounds.length);
  host.show("office-perf");
  check("show restores the latest hidden resize without rebuilding the editor",
    constructed===1 && closed===0 && bounds.length===4 &&
    JSON.stringify(bounds.at(-1))===JSON.stringify(hiddenNew),
    {constructed,closed,bounds});
  host.dispose();
  check("dispose closes the native editor exactly once",closed===1,closed);

  // Native setBounds may transiently throw if the OS-level view is changing
  // ownership. Do not remember an unsuccessful layout as already applied.
  let attempts=0;
  const failHost=new DocumentViewHost({
    getMainWindow:()=>window,
    createView:()=>({
      webContents:{
        loadURL:async()=>{},focus(){},close(){},isDestroyed:()=>false,
        setWindowOpenHandler(){},
      },
      setBounds(){
        attempts++;
        if(attempts===1) throw new Error("simulated OS layout failure");
      },
    }),
  });
  failHost.open({docId:"retry-layout",url:"file:///test/editor/index.html",bounds:initial,visible:true});
  failHost.setBounds("retry-layout",{...initial});
  check("failed OS layout remains retryable even when the rectangle is unchanged",attempts===2,attempts);
  failHost.setBounds("retry-layout",{...initial});
  check("once retry succeeds, subsequent identical rectangles are coalesced",attempts===2,attempts);
  failHost.dispose();

  const { resolveSafeGenofficeAsset } = await import("@main/document/genofficeAssetPath.js");
  const root=await mkdtemp(join(tmpdir(),"mcode-office-assets-"));
  try {
    const docroot=join(root,"pdf","out","renderer");
    const other=join(root,"outside");
    await mkdir(join(docroot,"assets"),{recursive:true});
    await mkdir(other,{recursive:true});
    await writeFile(join(docroot,"index.html"),"inlined html");
    await writeFile(join(docroot,"assets","bundle.js"),"js");
    await writeFile(join(other,"outside.js"),"escape");
    check("valid main editor resource resolves inside configured root",
      (await resolveSafeGenofficeAsset(docroot,"/index.html"))===await realpath(join(docroot,"index.html")));
    check("encoded nested chunk resolves without changing bytes",
      (await resolveSafeGenofficeAsset(docroot,"/assets%2Fbundle.js"))===await realpath(join(docroot,"assets","bundle.js")));
    for(const path of ["/../outside/outside.js","/%2e%2e%2foutside.js","/%GG","/%00broken","/".repeat(4100),"","/missing.js"]) {
      const found=await resolveSafeGenofficeAsset(docroot,path);
      check("invalid or escaping resource path fail-closed: "+path.slice(0,36),found===null,found);
    }
    try {
      await symlink(other,join(docroot,"assets","escape"),"junction");
      check("assets directory junction cannot escape Mcode's renderer root",
        (await resolveSafeGenofficeAsset(docroot,"/assets/escape/outside.js"))===null);
    } catch(e) {
      console.log("  note symlink/junction fixture unavailable: "+String(e));
    }
    const many=await Promise.all(Array.from({length:100},()=>resolveSafeGenofficeAsset(docroot,"/assets/bundle.js")));
    check("parallel editor chunks use the same bounded asynchronous resolver",
      many.length===100 && many.every(x=>x===many[0]) && !!many[0]);
    // Security must hold even when the staged renderer root's symlink changes.
    // Never cache an unchecked canonical path across requests.
  } finally {
    await rm(root,{force:true,recursive:true,maxRetries:3,retryDelay:40});
  }
  console.log("office-perf-smoke: "+passed+"/"+(passed+failed)+" passed");
  if(failed) process.exitCode=1;
}
main().catch(e=>{console.error("office-perf-smoke failed",e);process.exitCode=1;});
