import {checkoutArgsFor,remoteShortName} from "../../src/renderer/lib/branchRef.js";
let ok=0,bad=0;function eq(name:string,a:unknown,b:unknown){const pass=JSON.stringify(a)===JSON.stringify(b);console.log((pass?"PASS ":"FAIL ")+name+(pass?"":` actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`));if(pass)ok++;else bad++;}
const r=(name:string,current=false)=>({name,current,type:"remote" as const});
eq("remote HEAD symbolic ref is not an actionable branch",checkoutArgsFor(r("origin/HEAD") as never,new Set()),null);
eq("bare malformed remote ref is not checked out",checkoutArgsFor(r("origin/") as never,new Set()),null);
eq("nested remote branch keeps its whole short path",remoteShortName("origin/feature/one"),"feature/one");
eq("real remote missing locally creates tracking branch",checkoutArgsFor(r("origin/feature/one") as never,new Set()),{branch:"origin/feature/one",newBranch:"feature/one"});
eq("remote available locally uses local branch",checkoutArgsFor(r("origin/main") as never,new Set(["main"])),{branch:"main"});
eq("current branch remains a no-op",checkoutArgsFor(r("origin/main",true) as never,new Set()),null);
eq("local feature branch remains direct checkout",checkoutArgsFor({name:"feature/x",current:false,type:"local"} as never,new Set()),{branch:"feature/x"});
console.log(`branch-ref-symbolic-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;
