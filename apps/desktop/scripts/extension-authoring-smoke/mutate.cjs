/** T51 E1 source mutations. Run only when no concurrent builds are in progress. */
const {readFileSync,writeFileSync,existsSync}=require("node:fs");
const {join,resolve}=require("node:path");
const {createHash}=require("node:crypto");
const {spawnSync}=require("node:child_process");
const root=resolve(__dirname,"../../../..");
const cases=[
  {
    "path": "apps/desktop/src/main/appControl/extensionValidate.ts",
    "original": "issues.push(`权限 ${String(value)} 不存在`);",
    "mutant": "/* mutation: remove explicit unknown-permission finding */",
    "marker": "未知权限明确点名"
  },
  {
    "path": "apps/desktop/src/main/appControl/guide.ts",
    "original": "topics: [...buildGuideTopics(sources), { id: \"extensions\", kind: \"authoring-guide\" as const, title: \"extensions — 创建扩展\", summary: \"AI 编写扩展的 manifest、权限、API、可运行示例与常见错误\" }],",
    "mutant": "topics: buildGuideTopics(sources),",
    "marker": "指南主题在无扩展安装时也存在"
  }
];
let passed=0;
for(const item of cases){
 const file=join(root,item.path), snapshot=readFileSync(file,"utf8");
 if(!snapshot.includes(item.original))throw Error("not found: "+item.path);
 const sha=s=>createHash("sha256").update(s).digest("hex"),before=sha(snapshot);
 try{
  writeFileSync(file,snapshot.replace(item.original,item.mutant),"utf8");
  const r=spawnSync(process.execPath,["apps/desktop/scripts/run-smokes.mjs","extension-authoring-smoke"],{cwd:root,encoding:"utf8",timeout:180000,maxBuffer:1024*1024});
  const output=(r.stdout||"")+"\n"+(r.stderr||"");
  const runPath=/Smoke logs:\s*([^\r\n]+)/.exec(output)?.[1]?.trim();
  const caseLog=runPath ? join(runPath,"extension-authoring-smoke.log") : "";
  const details=caseLog && existsSync(caseLog)?readFileSync(caseLog,"utf8"):output;
  if(r.status===0||!details.includes("FAIL "+item.marker))throw Error("mutation survived or wrong failure: "+item.marker+"\n"+details.slice(-1500));
  passed++;console.log("KILLED "+item.marker);
 }finally{writeFileSync(file,snapshot,"utf8");if(sha(readFileSync(file,"utf8"))!==before)throw Error("restore failed "+file);}
}
console.log("T51 mutation score "+passed+"/"+cases.length);
if(passed!==cases.length)process.exitCode=1;
