/** ARC-002: real context inheritance core + fake library IDs; no user files. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextRefOfPath, contextKindOfPath, inheritContextLines, kindLabel, type ContextLookup } from "../../src/main/orchestration/contextInherit.js";
const root=mkdtempSync(join(tmpdir(),"mcode-context-guard-"));
const dir=join(root,"collections");
mkdirSync(dir);
const p=(name:string)=>join(dir,name);
const lookup:ContextLookup={
 libraryRoot:root,
 groupsOfCollection:(id)=>id==="lc_doc"?["docs"]:id==="lc_dual"?["docs","templates"]:undefined,
 groupsOfItem:(id)=>id==="li_doc"?["docs"]:undefined,
};
let ok=0,fail=0;
const check=(name:string,truth:boolean,details?:unknown)=>{
 if(truth)ok++;else fail++;
 console.log(`${truth?"  ok  ":"  FAIL"} ${name}${truth?"":" "+JSON.stringify(details)}`);
};
try{
 for(const name of ["group-docs.md","group-docs.txt","lc_doc.md","lc_doc.json","lc_dual.md","item-li_doc.md"]){
  writeFileSync(p(name),"fixture");
 }
 check("合法 group Markdown 被识别", contextKindOfPath(p("group-docs.md"),lookup)==="docs");
 check("假 group .txt 不是清单",contextKindOfPath(p("group-docs.txt"),lookup)===null);
 check("具有已知分类名的 JSON 文件不是清单",contextKindOfPath(p("lc_doc.json"),lookup)===null);
 check("合法分类 Markdown 仍识别",contextKindOfPath(p("lc_doc.md"),lookup)==="docs");
 check("合法单篇 Markdown 仍识别",contextKindOfPath(p("item-li_doc.md"),lookup)==="docs");
 check("不匹配的 wanted 不能 fallback 另一个类目",contextRefOfPath(p("lc_doc.md"),lookup,["templates"])===null);
 check("空 wanted 显式不给",contextRefOfPath(p("lc_doc.md"),lookup,[])===null);
 check("多类条目按请求选中 templates",contextRefOfPath(p("lc_dual.md"),lookup,["templates"])?.kind==="templates");
 check("kindLabel 原型键 __proto__ 保留为字符串",kindLabel("__proto__")==="__proto__");
 check("kindLabel 原型键 constructor 保留为字符串",kindLabel("constructor")==="constructor");
 check("class label 默认未知键原文",kindLabel("my-custom-group")==="my-custom-group");
 check("inheritContextLines 过滤不在 docs 类的清单",
   inheritContextLines(["@"+p("group-docs.txt"),"@"+p("lc_doc.md"),"@"+p("lc_doc.json")].join("\n"),["docs"],lookup).length===1);
 check("继承的可用记录类型为 collection",
   inheritContextLines("@"+p("lc_doc.md"),["docs"],lookup)[0]?.level==="collection");
}finally{rmSync(root,{recursive:true,force:true});}
console.log(`context-inherit-guard-smoke: ${ok}/${ok+fail}`);
if(fail)process.exitCode=1;
