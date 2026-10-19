import { lineDiff, diffSummary } from "../../src/renderer/lib/lineDiff.js";
let ok=0,bad=0;
function check(name:string,condition:boolean,detail=""){console.log((condition?"PASS ":"FAIL ")+name+(condition?"":" "+detail));if(condition)ok++;else bad++;}
const Original=Int32Array;
const maxCells=1_000_000;
const allocations:number[]=[];
class GuardInt32Array extends Original {
 constructor(n:number | ArrayLike<number>){if(typeof n==="number"){allocations.push(n);if(n>maxCells)throw Error("over budget LCS allocation "+n);}super(n as number);}
}
(globalThis as unknown as {Int32Array:typeof Int32Array}).Int32Array=GuardInt32Array as typeof Int32Array;
try {
 const common=Array.from({length:1600},(_,i)=>"shared-"+i);
 const old=[...common,"OLD CONTENT","stable footer"].join("\n");
 const changed=[...common,"NEW CONTENT","stable footer"].join("\n");
 let diff:ReturnType<typeof lineDiff>|null=null;
 try{diff=lineDiff(old,changed);}catch(e){console.log("caught "+String(e));}
 check("large code review never allocates LCS above 4MiB budget",diff!==null,allocations.join(","));
 if(diff) {
   const sum=diffSummary(diff);
   check("large review keeps actual deleted and inserted lines",sum.adds===1&&sum.dels===1,JSON.stringify(sum));
   check("large review preserves equal first and last lines",diff[0]?.op==="equal"&&diff.at(-1)?.text==="stable footer");
 }
 check("small diff still uses exact LCS not fast coarse mode",lineDiff("A\nB\nC","A\nX\nC").filter(x=>x.op!=="equal").length===2);
}finally {(globalThis as unknown as {Int32Array:typeof Int32Array}).Int32Array=Original;}
console.log(`line-diff-budget-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;
