import {
  registerSessionCleanupHook, runSessionCleanupHooks,
  registerProjectCleanupHook, runProjectCleanupHooks,
  __sessionCleanupHookCount,
} from "@main/lib/sessionCleanupHooks.js";
let total=0,failures=0;
const check=(name:string,ok:boolean,actual?:unknown):void=>{
  total++;
  console.log((ok?"ok ":"FAIL ")+name+(ok?"":" "+JSON.stringify(actual)));
  if(!ok)failures++;
};
{
  const calls:string[]=[];
  let offLate=()=>{};
  const offA=registerSessionCleanupHook((id)=>{
    calls.push("A:"+id);
    if(id==="old") offLate=registerSessionCleanupHook(x=>calls.push("LATE:"+x));
  });
  runSessionCleanupHooks("old");
  check("★ session hook registered DURING cleanup must not run for deleted session",calls.join(",")==="A:old",calls);
  runSessionCleanupHooks("new");
  check("new registration runs on NEXT deletion",calls.join(",")==="A:old,A:new,LATE:new",calls);
  offLate();offA();
  const before=calls.length;
  runSessionCleanupHooks("after");
  check("session unregister removes callbacks",calls.length===before);
}
{
  const calls:string[]=[];
  let offLate=()=>{};
  const offA=registerProjectCleanupHook((id,path)=>{
    calls.push("A:"+id+":"+path);
    if(id==="old-project")offLate=registerProjectCleanupHook(x=>calls.push("LATE:"+x));
  });
  runProjectCleanupHooks("old-project","/old-root");
  check("★ project hook registered DURING cleanup must not run for deleted project",calls.join(",")==="A:old-project:/old-root",calls);
  runProjectCleanupHooks("next-project","/next-root");
  check("project callback sees real saved path",calls.join(",")==="A:old-project:/old-root,A:next-project:/next-root,LATE:next-project",calls);
  offLate();offA();
  const before=calls.length;
  runProjectCleanupHooks("after","/after");
  check("project unregister removes callbacks",calls.length===before);
}
{
  let healthy=0;
  const offFail=registerSessionCleanupHook(()=>{throw new Error("synthetic fail");});
  const offSuccess=registerSessionCleanupHook(()=>{healthy++;});
  const prevWarn=console.warn;
  const warnings:string[]=[];
  console.warn=(...args:unknown[])=>{warnings.push(args.map(String).join(" "));};
  try{runSessionCleanupHooks("failure");}
  finally{console.warn=prevWarn;offFail();offSuccess();}
  check("one failing hook does not block healthy cleanup",healthy===1);
  check("cleanup failure stays visible but not propagated",warnings.some(x=>x.includes("synthetic fail")));
}
check("cleanup registry finishes without leaked session hooks",__sessionCleanupHookCount()===0);
console.log("cleanup-hook-mutation-smoke:"+(total-failures)+"/"+total+" PASS");
if(failures)process.exitCode=1;
