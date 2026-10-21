/** @smoke-covers src/main/document/genofficeViewFactories.ts
 * T53 fail-closed check with an enabled upstream seam and a missing sidecar.
 * No actual user executable is removed; all files are synthetic temp fixtures.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configureGenofficeNativeViews, makeGenofficeNativeView } from "@main/document/genofficeViewFactories.js";
const root = mkdtempSync(join(tmpdir(), "mcode-t53-sidecar-guard-"));
let total=0, fail=0;
function check(name:string,ok:boolean,detail?:unknown) {
  total++;
  if(ok)console.log("  ok  "+name);
  else{fail++;console.error("  FAIL "+name,detail);}
}
try{
  const cli=join(root,"genoffice/packages/cli/dist/genoffice.cjs");
  mkdirSync(dirname(cli),{recursive:true});
  writeFileSync(cli,"native test");
  const out=join(root,"genoffice/apps/sheets/out");
  mkdirSync(join(out,"preload"),{recursive:true});
  mkdirSync(join(out,"renderer"),{recursive:true});
  writeFileSync(join(out,"preload/index.js"),"preload");
  writeFileSync(join(out,"renderer/index.html"),"renderer");
  const status=configureGenofficeNativeViews(cli);
  check("XLSX fail-closed even with vendor and renderer installed but Rust binary missing",
    status.sheets===false,status);
  let refused=false;
  try{makeGenofficeNativeView(null,"sheets");}catch{refused=true;}
  check("missing XLSX sidecar refuses view creation",refused);
}finally{rmSync(root,{recursive:true,force:true});}
console.log("genoffice-native-sidecar-failclosed:"+(total-fail)+"/"+total+" 通过");
if(fail)process.exitCode=1;
