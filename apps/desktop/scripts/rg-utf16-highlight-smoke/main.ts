import * as rg from "../../src/main/lib/rgSearch.js";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fn=(rg as typeof rg & {byteOffsetsToUtf16?: (s:string,r:Array<{start:number,end:number}>)=>Array<{start:number,end:number}>}).byteOffsetsToUtf16;
let good=0,bad=0;
function check(name:string,actual:unknown,expected:unknown){const ok=JSON.stringify(actual)===JSON.stringify(expected);console.log(`${ok?"PASS":"FAIL"} ${name}${ok?"":` expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);if(ok)good++;else bad++;}
check("production byte offset helper exported",typeof fn,"function");
if(fn){
 const test=(name:string,s:string,needle:string) => {
   const index=s.indexOf(needle);
   const start=Buffer.byteLength(s.slice(0,index),"utf8");
   const end=start+Buffer.byteLength(needle,"utf8");
   check(name,fn(s,[{start,end}]),[{start:index,end:index+needle.length}]);
 };
 test("ASCII index unchanged","abc target end","target");
 test("emoji before match must count two UTF16 units","abc😀target","target");
 test("emoji match must span full surrogate pair","abc😀target","😀");
 test("two emoji before match","🧪😀target","target");
 test("Chinese before emoji and ASCII","中文😀target","target");
 test("ZWJ emoji sequence exact selection","x👩‍💻y","👩‍💻");
 test("plain 3-byte CJK substring","会话测试","测试");
}
const src=readFileSync("src/main/lib/rgSearch.ts","utf8");
check("JSON rg matcher consumes production shared byte converter",src.includes("byteOffsetsToUtf16(lineText, subs)"),true);
const tempRoot=mkdtempSync(join(tmpdir(),"mcode-rg-candidate-"));
const priorRoot=process.env.MCODE_SMOKE_USERDATA;
try {
 process.env.MCODE_SMOKE_USERDATA=tempRoot;
 const bundled=rg.bundledRgPath();
 mkdirSync(bundled,{recursive:true});
 rg.resetRgCache();
 check("bundled ripgrep directory must not be accepted as executable",rg.resolveRg()===bundled,false);
 rmSync(bundled,{recursive:true,force:true});
 writeFileSync(bundled,"fake isolated fixture");
 if(process.platform!=="win32") chmodSync(bundled,0o755);
 rg.resetRgCache();
 check("regular app-owned bundled ripgrep still wins",rg.resolveRg()===bundled,true);
} finally {
 rg.resetRgCache();
 if(priorRoot===undefined) delete process.env.MCODE_SMOKE_USERDATA;
 else process.env.MCODE_SMOKE_USERDATA=priorRoot;
 rmSync(tempRoot,{recursive:true,force:true});
}
console.log(`rg-utf16-highlight-smoke: ${good}/${good+bad}`);
if(bad)process.exitCode=1;
