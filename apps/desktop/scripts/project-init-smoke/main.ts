import { registerProjectInitHandlers } from "../../src/main/ipc/projectInit.js";
import { IPC } from "@contracts/ipc";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectInitDraftSchema, type ProjectInitDraft } from "@contracts/ipc/projectInit";
import { listProjectInitializers, getProjectInitializer, saveProjectInitializer, deleteProjectInitializer, previewProjectInitializer, applyProjectInitializer, setDefaultProjectInitializer } from "../../src/main/projectInit/service.js";
import { readMemoryFile } from "../../src/main/memory/store.js";
import { ensureShippedInitializersSeeded } from "../../src/main/projectInit/service.js";
import { SHIPPED_INITIALIZERS } from "../../src/main/projectInit/shipped.js";
import { setRoot, projects, sessions, events, settings } from "./stubs.js";
const base = await mkdtemp(join(tmpdir(), "mcode-project-init-"));
let root = "", data = "", passed = 0, failed = 0, count = 0;
const draft = (name="学术"): ProjectInitDraft => ({ name, description:"A user-defined scenario", directories:["papers"], files:[{path:"notes/README.md",content:"# Research\n用户定义正文"}], memories:[{category:"project",filename:"init.md",title:"Project rules",content:"Cite primary sources",pinned:true}] });
async function test(name:string, run:()=>unknown|Promise<unknown>) {
 const folder=join(base,String(++count));root=join(folder,"workspace");data=join(folder,"data");
 await mkdir(root,{recursive:true});await mkdir(data,{recursive:true});setRoot(data);
 projects.set("p1",{id:"p1",name:"Project one",path:root});sessions.set("s1",{id:"s1",projectId:"p1"});
 try {await run();passed++;console.log("PASS "+name);} catch(e){failed++;console.error("FAIL "+name+": "+String(e));}
}
const preview = () => previewProjectInitializer({sessionId:"s1",command:"init-学术"});
const execute = async() => {const p=await preview();return applyProjectInitializer({sessionId:p.sessionId,command:"init-学术",digest:p.digest});};
try {
 await test("real IPC handlers validate and route preview/apply to the service",async()=>{
  const handlers=new Map<string,(_event:unknown,input?:unknown)=>unknown>();
  registerProjectInitHandlers({handle:(channel:string,handler:(_event:unknown,input?:unknown)=>unknown)=>{handlers.set(channel,handler);}} as Parameters<typeof registerProjectInitHandlers>[0]);
  const invoke=async(channel:string,input?:unknown)=>{assert.ok(handlers.has(channel));return handlers.get(channel)!(null,input) as any;};
  const saved=await invoke(IPC.PROJECT_INIT_SAVE,{draft:draft()});assert.equal(saved.name,"学术");assert.equal((await invoke(IPC.PROJECT_INIT_LIST)).templates.length,1);
  const p=await invoke(IPC.PROJECT_INIT_PREVIEW,{sessionId:"s1",command:"init-学术"});assert.deepEqual(await readdir(root),[]);
  const result=await invoke(IPC.PROJECT_INIT_APPLY,{sessionId:"s1",command:"init-学术",digest:p.digest});assert.ok(result.actions.every((a:any)=>a.status==="created"));
  assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),draft().files[0].content);
  await assert.rejects(invoke(IPC.PROJECT_INIT_SAVE,{draft:{...draft(),files:[{path:"../escape",content:"x"}]}}));
 });
 await test("save/list/get persist summaries without content",()=>{
  const t=saveProjectInitializer({draft:draft()});assert.equal(getProjectInitializer({id:t.id}).files[0].content,draft().files[0].content);
  assert.equal(listProjectInitializers().templates[0].name,"学术");assert.ok(!("files" in listProjectInitializers().templates[0]));
 });
 await test("updates and deletes require original revision",()=>{
  const t=saveProjectInitializer({draft:draft()});const changed=saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:draft("会议")});
  assert.throws(()=>saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:draft()}),/changed/);
  assert.throws(()=>deleteProjectInitializer({id:t.id,expectedRevision:t.revision}),/changed/);
  deleteProjectInitializer({id:t.id,expectedRevision:changed.revision});assert.equal(listProjectInitializers().templates.length,0);
 });
 await test("normalized command names cannot collide",()=>{
  saveProjectInitializer({draft:draft("Study")});assert.throws(()=>saveProjectInitializer({draft:draft("study")}),/already exists/);
 });
 await test("unreadable templates never get replaced silently",()=>{
  const t=saveProjectInitializer({draft:draft()});settings.set("projectInit.template."+t.id,"{broken");
  assert.throws(()=>saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:draft()}));assert.equal(settings.get("projectInit.template."+t.id),"{broken");
 });
 for (const path of ["../x","a/../x","/tmp/x","C:/x","a\\b","a//b",".git/config","CON.txt","name.","name ","a\u0000b"]) await test(`reject unsafe path ${JSON.stringify(path)}`,()=>{
  assert.equal(ProjectInitDraftSchema.safeParse({...draft(),files:[{path,content:"x"}]}).success,false);
 });
 await test("reject file-parent conflicts and portable case collisions",()=>{
  for(const files of [[{path:"a",content:""},{path:"a/b",content:""}],[{path:"A.md",content:""},{path:"a.md",content:""}]]) assert.equal(ProjectInitDraftSchema.safeParse({...draft(),files}).success,false);
 });
 await test("reject empty templates and out-of-scope memory filenames",()=>{
  assert.equal(ProjectInitDraftSchema.safeParse({name:"x",directories:[],files:[],memories:[]}).success,false);
  assert.equal(ProjectInitDraftSchema.safeParse({...draft(),memories:[{...draft().memories[0],filename:"../../global.md"}]}).success,false);
 });
 await test("bound path depth and generated directory work",()=>{
  assert.equal(ProjectInitDraftSchema.safeParse({...draft(),files:[{path:Array(17).fill("a").join("/"),content:""}]}).success,false);
  const files=Array.from({length:100},(_,i)=>({path:`d${i}/a/b/c/d/e/f/g/readme.md`,content:""}));
  assert.equal(ProjectInitDraftSchema.safeParse({...draft(),files}).success,false);
 });
 await test("preview has no filesystem or memory writes",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();assert.ok(p.actions.every(a=>a.status==="create"));assert.deepEqual(await readdir(root),[]);assert.deepEqual(await readdir(data),[]);assert.equal(events.length,0);
 });
 await test("apply creates actual files, parents and scoped pinned memory",async()=>{
  saveProjectInitializer({draft:draft()});const r=await execute();assert.ok(r.actions.every(a=>a.status==="created"));
  assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),draft().files[0].content);
  assert.match(readMemoryFile("projects/p1/project/init.md").content,/Cite primary sources/);
  assert.match(await readFile(join(data,"memory/projects/p1/project/init.md"),"utf8"),/pinned: true/);
  assert.equal(events.length,1);assert.equal((await readdir(join(root,"notes"))).some(p=>p.endsWith(".tmp")),false);
 });
 await test("second execution skips all existing entries without rewriting",async()=>{
  saveProjectInitializer({draft:draft()});await execute();await writeFile(join(root,"notes/README.md"),"User edited");
  const r=await execute();assert.ok(r.actions.every(a=>a.status==="skip"));assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),"User edited");assert.equal(events.length,1);
 });
 await test("files created after preview invalidate approval",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();await mkdir(join(root,"notes"));await writeFile(join(root,"notes/README.md"),"Do not touch");
  await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest}),/Preview changed/);assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),"Do not touch");
 });
 await test("editing a template invalidates an old preview",async()=>{
  const t=saveProjectInitializer({draft:draft()});const p=await preview();saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:{...draft(),description:"Changed"}});
  await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest}),/Preview changed/);assert.deepEqual(await readdir(root),[]);
 });
 await test("approval is bound to conversation and project",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();const other=join(base,"other-project");await mkdir(other);projects.set("p2",{id:"p2",name:"Other",path:other});sessions.set("s2",{id:"s2",projectId:"p2"});
  await assert.rejects(applyProjectInitializer({sessionId:"s2",command:"init-学术",digest:p.digest}),/Preview changed/);assert.deepEqual(await readdir(other),[]);
 });
 await test("missing session and command fail explicitly",async()=>{
  saveProjectInitializer({draft:draft()});await assert.rejects(previewProjectInitializer({sessionId:"missing",command:"init-学术"}));await assert.rejects(previewProjectInitializer({sessionId:"s1",command:"init-unknown"}));
 });
 await test("selected worktree receives files, original project receives memory",async()=>{
  const worktree=join(base,"worktree");await mkdir(worktree);sessions.set("s1",{id:"s1",projectId:"p1",worktreePath:worktree});saveProjectInitializer({draft:draft()});await execute();
  assert.deepEqual(await readdir(root),[]);assert.equal(await readFile(join(worktree,"notes/README.md"),"utf8"),draft().files[0].content);assert.match(readMemoryFile("projects/p1/project/init.md").content,/Cite/);
 });
 await test("file parents block the entire plan before any writes",async()=>{
  await writeFile(join(root,"notes"),"not a directory");saveProjectInitializer({draft:draft()});const p=await preview();assert.ok(p.actions.some(a=>a.status==="blocked"));await assert.rejects(execute(),/blocked/);assert.deepEqual(await readdir(root),["notes"]);
 });
 await test("symlink/junction parents cannot escape project",async()=>{
  const outside=join(base,"outside");await mkdir(outside);await symlink(outside,join(root,"notes"),process.platform==="win32"?"junction":"dir");
  saveProjectInitializer({draft:draft()});assert.ok((await preview()).actions.some(a=>a.reason==="symlink"));await assert.rejects(execute(),/blocked/);assert.deepEqual(await readdir(outside),[]);
 });
 await test("memory symlink/junction is rejected before file creation",async()=>{
  const outside=join(base,"outside-memory");await mkdir(outside);await symlink(outside,join(data,"memory"),process.platform==="win32"?"junction":"dir");
  saveProjectInitializer({draft:draft()});await assert.rejects(execute(),/blocked/);assert.deepEqual(await readdir(root),[]);assert.deepEqual(await readdir(outside),[]);
 });
 await test("memory failures are explicit partial results, not silent success",async()=>{
  saveProjectInitializer({draft:{...draft(),memories:[{...draft().memories[0],content:"sk-"+"A".repeat(30)}]}});const r=await execute();
  assert.equal(r.actions.find(a=>a.kind==="memory")?.status,"failed");assert.equal(r.actions.find(a=>a.kind==="file")?.status,"created");assert.equal(events.length,0);
 });
 await test("parallel applies never overwrite or duplicate memories",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();const settled=await Promise.allSettled([1,2].map(()=>applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest})));
  assert.equal(settled.filter(r=>r.status==="fulfilled").length,1);assert.equal(events.length,1);assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),draft().files[0].content);
 });
 // 出厂模板(2026-09-30):只播一次、删了不复活、不抢用户的同名命令、内容本身能真的落盘。
 await test("shipped initializer drafts pass the schema",()=>{
  for(const s of SHIPPED_INITIALIZERS){assert.equal(ProjectInitDraftSchema.safeParse(s.draft).success,true,s.draft.name);assert.ok(s.draft.directories.every(d=>s.draft.files.some(f=>f.path.startsWith(d.split("/")[0]+"/README"))),"every top folder has a README");}
 });
 await test("shipped initializer seeds once and is idempotent",()=>{
  ensureShippedInitializersSeeded();const names=listProjectInitializers().templates.map(t=>t.name);
  assert.deepEqual(names,[...SHIPPED_INITIALIZERS.map(s=>s.draft.name)].sort((a,b)=>a.localeCompare(b)));
  ensureShippedInitializersSeeded();assert.equal(listProjectInitializers().templates.length,SHIPPED_INITIALIZERS.length);
 });
 await test("deleted shipped initializer never resurrects",()=>{
  ensureShippedInitializersSeeded();for(const t of listProjectInitializers().templates)deleteProjectInitializer({id:t.id,expectedRevision:t.revision});
  ensureShippedInitializersSeeded();assert.equal(listProjectInitializers().templates.length,0);
 });
 await test("shipped initializer yields to a user template with the same command",()=>{
  const mine=saveProjectInitializer({draft:draft(SHIPPED_INITIALIZERS[0].draft.name)});ensureShippedInitializersSeeded();
  const same=listProjectInitializers().templates.filter(t=>t.name===SHIPPED_INITIALIZERS[0].draft.name);assert.equal(same.length,1);assert.equal(same[0].id,mine.id);
  assert.equal(listProjectInitializers().templates.length,SHIPPED_INITIALIZERS.length,"the other shipped scenarios still seed");
 });
 await test("shipped research initializer creates folders, READMEs and pinned memories",async()=>{
  ensureShippedInitializersSeeded();const shipped=SHIPPED_INITIALIZERS[0].draft;const command="init-"+shipped.name;
  const p=await previewProjectInitializer({sessionId:"s1",command});const r=await applyProjectInitializer({sessionId:"s1",command,digest:p.digest});
  assert.ok(r.actions.every(a=>a.status==="created"),JSON.stringify(r.actions.filter(a=>a.status!=="created")));
  assert.match(await readFile(join(root,"data/README.md"),"utf8"),/raw/);assert.deepEqual(await readdir(join(root,"data/raw")),[]);
  assert.match(readMemoryFile("projects/p1/rules/项目目录约定.md").content,/data\/raw/);
  assert.match(await readFile(join(data,"memory/projects/p1/project/项目概况.md"),"utf8"),/pinned: true/);
 });

 // AI 生成说明文件(2026-10):只出计划和提示词,文件由引擎在对话里写;三个引擎拿到的是同一段提示词。
 const agentDraft=(over:Partial<ProjectInitDraft>={}):ProjectInitDraft=>({name:"代码",description:"",directories:[],files:[],memories:[],agentFile:{enabled:true,filename:"AGENTS.md",focus:"重点写测试命令"},...over});
 const agentRun=async(command="init-代码")=>{const p=await previewProjectInitializer({sessionId:"s1",command});return {p,r:await applyProjectInitializer({sessionId:"s1",command,digest:p.digest})};};
 await test("agent-only template is valid, disabled agent alone is still empty",()=>{
  assert.equal(ProjectInitDraftSchema.safeParse(agentDraft()).success,true);
  assert.equal(ProjectInitDraftSchema.safeParse(agentDraft({agentFile:{enabled:false,filename:"AGENTS.md",focus:""}})).success,false);
  assert.equal(ProjectInitDraftSchema.safeParse({...agentDraft(),agentFile:{enabled:true,filename:"README.md",focus:""}}).success,false);
 });
 await test("agent step: preview carries the prompt, apply writes nothing and returns it",async()=>{
  saveProjectInitializer({draft:agentDraft()});const {p,r}=await agentRun();
  assert.equal(p.actions.length,0);assert.equal(p.agentFile?.filename,"AGENTS.md");assert.equal(p.agentFile?.exists,false);assert.equal(p.agentFile?.shadowed,false);
  assert.match(p.agentFile!.prompt,/创建 `AGENTS.md`/);assert.match(p.agentFile!.prompt,/重点写测试命令/);assert.match(p.agentFile!.prompt,/Claude、Codex、Pi/);
  assert.equal(r.agentPrompt,p.agentFile!.prompt);assert.equal(r.agentFilename,"AGENTS.md");assert.deepEqual(await readdir(root),[]);
  assert.equal(listProjectInitializers().templates[0].agentFile,"AGENTS.md");
 });
 await test("existing guide file switches the prompt to improve, never overwritten by apply",async()=>{
  await writeFile(join(root,"AGENTS.md"),"# mine");saveProjectInitializer({draft:agentDraft()});const {p}=await agentRun();
  assert.equal(p.agentFile?.exists,true);assert.match(p.agentFile!.prompt,/改进已有的/);assert.equal(await readFile(join(root,"AGENTS.md"),"utf8"),"# mine");
 });
 await test("a template seed file with the same name counts as existing; scaffold is listed",async()=>{
  saveProjectInitializer({draft:agentDraft({directories:["src"],files:[{path:"AGENTS.md",content:"# seed"}]})});const {p}=await agentRun();
  assert.equal(p.agentFile?.exists,true);assert.match(p.agentFile!.prompt,/- src/);assert.match(p.agentFile!.prompt,/- AGENTS.md/);
 });
 await test("CLAUDE.md is flagged as shadowed when AGENTS.md exists",async()=>{
  await writeFile(join(root,"AGENTS.md"),"# a");saveProjectInitializer({draft:agentDraft({agentFile:{enabled:true,filename:"CLAUDE.md",focus:""}})});
  const p=await previewProjectInitializer({sessionId:"s1",command:"init-代码"});assert.equal(p.agentFile?.shadowed,true);assert.match(p.agentFile!.prompt,/CLAUDE.md/);
 });
 await test("guide file appearing after preview invalidates approval",async()=>{
  saveProjectInitializer({draft:agentDraft()});const p=await previewProjectInitializer({sessionId:"s1",command:"init-代码"});await writeFile(join(root,"AGENTS.md"),"late");
  await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-代码",digest:p.digest}),/Preview changed/);
 });
 await test("guide path occupied by a directory blocks the plan",async()=>{
  await mkdir(join(root,"AGENTS.md"));saveProjectInitializer({draft:agentDraft()});const p=await previewProjectInitializer({sessionId:"s1",command:"init-代码"});
  assert.equal(p.agentFile?.blocked,"wrongType");await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-代码",digest:p.digest}),/blocked/);
 });
 await test("default scenario: set, list, clear, stale after delete, unknown id rejected",()=>{
  const a=saveProjectInitializer({draft:agentDraft()});assert.equal(listProjectInitializers().defaultId,null);
  setDefaultProjectInitializer({id:a.id});assert.equal(listProjectInitializers().defaultId,a.id);
  setDefaultProjectInitializer({id:null});assert.equal(listProjectInitializers().defaultId,null);
  setDefaultProjectInitializer({id:a.id});deleteProjectInitializer({id:a.id,expectedRevision:a.revision});assert.equal(listProjectInitializers().defaultId,null);
  assert.throws(()=>setDefaultProjectInitializer({id:"00000000-0000-4000-8000-000000000000"}));assert.throws(()=>setDefaultProjectInitializer({id:"nope"}));
 });
 await test("untouched old research template is upgraded in place; edited or disabled copies are left alone",()=>{
  const shipped=SHIPPED_INITIALIZERS[0];const next=ProjectInitDraftSchema.parse(shipped.draft);const old={...next};delete old.agentFile;
  settings.set("projectInit.template."+shipped.id,JSON.stringify(old));settings.set("projectInit.seededShipped",JSON.stringify(SHIPPED_INITIALIZERS.map(s=>s.id)));
  ensureShippedInitializersSeeded();assert.equal(getProjectInitializer({id:shipped.id}).agentFile?.enabled,true);
  ensureShippedInitializersSeeded();assert.equal(settings.get("projectInit.template."+shipped.id),JSON.stringify(next),"idempotent");
  const edited={...old,description:"我改过"};settings.set("projectInit.template."+shipped.id,JSON.stringify(edited));ensureShippedInitializersSeeded();
  assert.equal(settings.get("projectInit.template."+shipped.id),JSON.stringify(edited));
  const off={...next,agentFile:{...next.agentFile!,enabled:false}};settings.set("projectInit.template."+shipped.id,JSON.stringify(off));ensureShippedInitializersSeeded();
  assert.equal(settings.get("projectInit.template."+shipped.id),JSON.stringify(off));
 });
 await test("every shipped scenario previews and applies cleanly on an empty project",async()=>{
  ensureShippedInitializersSeeded();
  let thesisRoot="";
  for(const s of SHIPPED_INITIALIZERS){
   // 每个场景一个空项目目录:研究项目与论文写作都有 notes/、references/,同一目录里第二个会是「跳过」。
   const dir=join(base,"scenario-"+s.id);await mkdir(dir);projects.set("p1",{id:"p1",name:"Project one",path:dir});if(s.draft.name==="论文写作")thesisRoot=dir;
   const command="init-"+s.draft.name;const p=await previewProjectInitializer({sessionId:"s1",command});
   assert.ok(p.actions.every(a=>a.status==="create"),s.draft.name);assert.equal(p.agentFile?.filename,"AGENTS.md",s.draft.name);
   const r=await applyProjectInitializer({sessionId:"s1",command,digest:p.digest});assert.ok(r.actions.every(a=>a.status==="created"),s.draft.name);assert.ok(r.agentPrompt,s.draft.name);
  }
  assert.match(await readFile(join(thesisRoot,"manuscript/README.md"),"utf8"),/main.tex/);assert.match(readMemoryFile("projects/p1/rules/写作约定.md").content,/不编造文献/);
 });
} finally { await rm(base,{recursive:true,force:true}); }
console.log(`Project init smoke: ${passed} pass, ${failed} fail`);process.exitCode=failed?1:0;
