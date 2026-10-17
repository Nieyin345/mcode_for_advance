import { registerProjectInitHandlers } from "../../src/main/ipc/projectInit.js";
import { IPC } from "@contracts/ipc";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectInitDraftSchema, type ProjectInitDraft } from "@contracts/ipc/projectInit";
import { listProjectInitializers, getProjectInitializer, saveProjectInitializer, deleteProjectInitializer, previewProjectInitializer, applyProjectInitializer, setDefaultProjectInitializer } from "../../src/main/projectInit/service.js";
import { readMemoryFile } from "../../src/main/memory/store.js";
import { importProjectInitPreset, readProjectInitPresets } from "../../src/main/projectInit/presets.js";
import { setRoot, projects, sessions, events, settings } from "./stubs.js";
const base = await mkdtemp(join(tmpdir(), "mcode-project-init-"));
let root = "", data = "", passed = 0, failed = 0, count = 0;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
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
  assert.throws(()=>saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:draft()}),/改动/);
  assert.throws(()=>deleteProjectInitializer({id:t.id,expectedRevision:t.revision}),/改动/);
  deleteProjectInitializer({id:t.id,expectedRevision:changed.revision});assert.equal(listProjectInitializers().templates.length,0);
 });
 await test("normalized command names cannot collide",()=>{
  saveProjectInitializer({draft:draft("Study")});assert.throws(()=>saveProjectInitializer({draft:draft("study")}),/已存在/);
 });
 await test("unreadable templates never get replaced silently",()=>{
  const t=saveProjectInitializer({draft:draft()});settings.set("projectInit.template."+t.id,"{broken");
  assert.throws(()=>saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:draft()}));assert.equal(settings.get("projectInit.template."+t.id),"{broken");
 });
 await test("schema-invalid stored template fails with a human message, not raw zod JSON",()=>{
  // "JSON 合法但 schema 不符" —— 从前这条会原样抛 `ZodError.message`(一整段英文 JSON 数组),
  // 而 `list/get/delete` 与渲染端 `ProjectInitManager` 把它画在设置页上。紧邻的 JSON 解析失败
  // 一直是中文,这条不该漏。判据:抛出的理由是中文、且不含 zod 的 JSON 形状。
  const t=saveProjectInitializer({draft:draft()});
  settings.set("projectInit.template."+t.id, JSON.stringify({name:"x", files:"不是数组"}));
  let msg="";
  try { listProjectInitializers(); } catch (err) { msg=err instanceof Error?err.message:String(err); }
  assert.ok(msg.length>0,"应当抛出");
  assert.ok(/[一-鿿]/.test(msg),`理由应当含中文:${msg}`);
  assert.ok(!/\[[\s\S]*"code"[\s\S]*\]/.test(msg),`不该是 zod JSON:${msg}`);
  // 坏模板没被悄悄替换/删除。
  assert.equal(settings.get("projectInit.template."+t.id), JSON.stringify({name:"x", files:"不是数组"}));
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
  await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest}),/预览已改变/);assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),"Do not touch");
 });
 await test("editing a template invalidates an old preview",async()=>{
  const t=saveProjectInitializer({draft:draft()});const p=await preview();saveProjectInitializer({id:t.id,expectedRevision:t.revision,draft:{...draft(),description:"Changed"}});
  await assert.rejects(applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest}),/预览已改变/);assert.deepEqual(await readdir(root),[]);
 });
 await test("approval is bound to conversation and project",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();const other=join(base,"other-project");await mkdir(other);projects.set("p2",{id:"p2",name:"Other",path:other});sessions.set("s2",{id:"s2",projectId:"p2"});
  await assert.rejects(applyProjectInitializer({sessionId:"s2",command:"init-学术",digest:p.digest}),/预览已改变/);assert.deepEqual(await readdir(other),[]);
 });
 await test("missing session and command fail explicitly",async()=>{
  saveProjectInitializer({draft:draft()});await assert.rejects(previewProjectInitializer({sessionId:"missing",command:"init-学术"}));await assert.rejects(previewProjectInitializer({sessionId:"s1",command:"init-unknown"}));
 });
 // 这些报错**原样画在渲染端的 ErrorNote 上**(ProjectInitManager / useProjectInitializer),
 // 与同仓其它主进程报错一样是中文;从前 service.ts 全部是英文(同一页一屏中文里蹦出英文)。
 await test("user-visible errors are Chinese, not English",async()=>{
  saveProjectInitializer({draft:draft()});
  const zh=/[一-龥]/, en=/^[A-Za-z]/;
  const grab=async(fn:()=>unknown)=>{try{await fn();return "";}catch(e){return String((e as Error).message);}};
  const notFound=await grab(()=>previewProjectInitializer({sessionId:"s1",command:"init-不存在"}));
  const noProject=await grab(()=>previewProjectInitializer({sessionId:"nope",command:"init-学术"}));
  const collide=await grab(()=>saveProjectInitializer({draft:draft()}));
  for(const [name,msg] of [["未找到命令",notFound],["无有效项目",noProject],["命令重名",collide]] as const){
   assert.ok(msg.length>0,`${name}: 有报错`);
   assert.ok(zh.test(msg),`${name} 是中文:${msg}`);
   assert.ok(!en.test(msg),`${name} 不是英文开头:${msg}`);
  }
 });
 await test("selected worktree receives files, original project receives memory",async()=>{
  const worktree=join(base,"worktree");await mkdir(worktree);sessions.set("s1",{id:"s1",projectId:"p1",worktreePath:worktree});saveProjectInitializer({draft:draft()});await execute();
  assert.deepEqual(await readdir(root),[]);assert.equal(await readFile(join(worktree,"notes/README.md"),"utf8"),draft().files[0].content);assert.match(readMemoryFile("projects/p1/project/init.md").content,/Cite/);
 });
 await test("file parents block the entire plan before any writes",async()=>{
  await writeFile(join(root,"notes"),"not a directory");saveProjectInitializer({draft:draft()});const p=await preview();assert.ok(p.actions.some(a=>a.status==="blocked"));await assert.rejects(execute(),/阻止/);assert.deepEqual(await readdir(root),["notes"]);
 });
 await test("symlink/junction parents cannot escape project",async()=>{
  const outside=join(base,"outside");await mkdir(outside);await symlink(outside,join(root,"notes"),process.platform==="win32"?"junction":"dir");
  saveProjectInitializer({draft:draft()});assert.ok((await preview()).actions.some(a=>a.reason==="symlink"));await assert.rejects(execute(),/阻止/);assert.deepEqual(await readdir(outside),[]);
 });
 await test("memory symlink/junction is rejected before file creation",async()=>{
  const outside=join(base,"outside-memory");await mkdir(outside);await symlink(outside,join(data,"memory"),process.platform==="win32"?"junction":"dir");
  saveProjectInitializer({draft:draft()});await assert.rejects(execute(),/阻止/);assert.deepEqual(await readdir(root),[]);assert.deepEqual(await readdir(outside),[]);
 });
 await test("memory failures are explicit partial results, not silent success",async()=>{
  saveProjectInitializer({draft:{...draft(),memories:[{...draft().memories[0],content:"sk-"+"A".repeat(30)}]}});const r=await execute();
  assert.equal(r.actions.find(a=>a.kind==="memory")?.status,"failed");assert.equal(r.actions.find(a=>a.kind==="file")?.status,"created");assert.equal(events.length,0);
 });
 await test("parallel applies never overwrite or duplicate memories",async()=>{
  saveProjectInitializer({draft:draft()});const p=await preview();const settled=await Promise.allSettled([1,2].map(()=>applyProjectInitializer({sessionId:"s1",command:"init-学术",digest:p.digest})));
  assert.equal(settled.filter(r=>r.status==="fulfilled").length,1);assert.equal(events.length,1);assert.equal(await readFile(join(root,"notes/README.md"),"utf8"),draft().files[0].content);
 });
 // ── 【MC-006】出厂模板改成"预设 + 按需导入",不再自动播种 ──
 //
 // 台账失败反例:本体按固定 UUID 给每个新装用户**播种**三份学术场景模板(研究项目 /
 // 论文写作),做通用软件开发的人打开「初始化」就见到 notes/references/experiments。
 // 现在三份正文住在 resources/presets/project-init.json,导入是用户动作。
 await test("出厂预设文件里三份模板都在,且都过契约 schema",()=>{
  const { catalog, drafts }=readProjectInitPresets();
  assert.equal(catalog.health,"ok",JSON.stringify(catalog));
  assert.equal(drafts.length,3,"三份(研究项目/代码项目/论文写作)");
  assert.deepEqual(catalog.problems,[]);
  assert.deepEqual(drafts.map(d=>d.draft.name).sort(),["代码项目","研究项目","论文写作"].sort());
  for(const s of drafts){
   assert.equal(ProjectInitDraftSchema.safeParse(s.draft).success,true,s.draft.name);
   assert.ok(s.draft.directories.every(d=>s.draft.files.some(f=>f.path.startsWith(d.split("/")[0]+"/README"))),"every top folder has a README");
  }
 });
 await test("★ 启动**不再**播种:库里空着,不 import 就什么都没有",()=>{
  // 这条是 MC-006 的核心判据 —— 从前启动时就悄悄写进去了。现在没有那个调用点,
  // 模板只可能来自用户动作(导入/手建)。
  assert.equal(listProjectInitializers().templates.length,0);
 });
 await test("按 id 导入一份预设:建成普通模板、可以再改",()=>{
  const { drafts }=readProjectInitPresets();
  const research=drafts.find(d=>d.draft.name==="研究项目")!;
  const res=importProjectInitPreset(research.id);
  assert.equal(res.ok,true,JSON.stringify(res));
  if(!res.ok)return;
  const stored=getProjectInitializer({id:res.id});
  assert.equal(stored.name,"研究项目");
  // stored 带 id/revision(模板契约是 strict),校验 draft 本体要剥掉这两个。
  const {id:_id,revision:_rev,...storedDraft}=stored;
  assert.equal(ProjectInitDraftSchema.safeParse(storedDraft).success,true);
  // 导入进来就是普通模板:改它不会影响预设文件里的那一份。
  saveProjectInitializer({id:res.id,expectedRevision:stored.revision,draft:{...storedDraft,name:"我的研究项目"}});
  assert.equal(getProjectInitializer({id:res.id}).name,"我的研究项目");
  assert.equal(readProjectInitPresets().drafts.find(d=>d.id===research.id)!.draft.name,"研究项目");
 });
 await test("重名导入自动加后缀(不因为名字撞了而失败)",()=>{
  const { drafts }=readProjectInitPresets();
  const research=drafts.find(d=>d.draft.name==="研究项目")!;
  const first=importProjectInitPreset(research.id);
  assert.ok(first.ok && first.name==="研究项目",JSON.stringify(first));
  const second=importProjectInitPreset(research.id);
  assert.equal(second.ok,true,JSON.stringify(second));
  if(!second.ok)return;
  assert.equal(second.name,"研究项目-2");
  const third=importProjectInitPreset(research.id);
  assert.ok(third.ok && third.name==="研究项目-3",JSON.stringify(third));
 });
 await test("不存在的预设 id → 明确报错(不是静默成功)",()=>{
  const res=importProjectInitPreset("00000000-0000-4000-8000-000000000000");
  assert.equal(res.ok,false);
  if(!res.ok)assert.match(res.error,/没有 id/);
 });
 await test("导入的研究项目模板真的能落盘:目录、README、置顶记忆",async()=>{
  const { drafts }=readProjectInitPresets();
  const thesis=drafts.find(d=>d.draft.name==="论文写作")!;
  const res=importProjectInitPreset(thesis.id);
  assert.equal(res.ok,true,JSON.stringify(res));
  if(!res.ok)return;
  const command="init-"+res.name;
  const p=await previewProjectInitializer({sessionId:"s1",command});const r=await applyProjectInitializer({sessionId:"s1",command,digest:p.digest});
  assert.ok(r.actions.every(a=>a.status==="created"),JSON.stringify(r.actions.filter(a=>a.status!=="created")));
  assert.match(await readFile(join(root,"manuscript/README.md"),"utf8"),/main.tex/);
  assert.match(readMemoryFile("projects/p1/rules/写作约定.md").content,/不编造文献/);
 });
 await test("没有预置文件 → health:absent;坏 JSON → health:corrupt(都不是空列表)",async()=>{
  // 硬规矩 3:「这个安装没带」与「带了但坏了」是两种不同的可观测状态,不能都画成空列表。
  const { mkdtemp:mk,writeFile:wf,mkdir:mkd,rm:rmdir }=await import("node:fs/promises");
  const empty=await mk("preset-absent-");
  try{
   const absent=readProjectInitPresets([empty]).catalog;
   assert.equal(absent.health,"absent");
   assert.ok(String(absent.reason).length>0,"absent 要带原因");
   assert.equal(absent.presets.length,0);
   await mkd(join(empty,"resources","presets"),{recursive:true});
   await wf(join(empty,"resources","presets","project-init.json"),"{这不是 json","utf8");
   const corrupt=readProjectInitPresets([empty]).catalog;
   assert.equal(corrupt.health,"corrupt");
   assert.match(String(corrupt.reason),/JSON/);
  }finally{await rmdir(empty,{recursive:true,force:true});}
 });
 await test("出厂预设逐条校验:坏条目进 problems,好的照常可用",async()=>{
  const { mkdtemp:mk,writeFile:wf,mkdir:mkd }=await import("node:fs/promises");
  const tmp=await mk("preset-bad-");
  try{
   await mkd(join(tmp,"resources","presets"),{recursive:true});
   await wf(join(tmp,"resources","presets","project-init.json"),JSON.stringify({
    templates:[{id:"good",draft:{name:"好模板",description:"",directories:["x"],files:[{path:"x/README.md",content:"# x"}],memories:[],agentFile:{enabled:false,filename:"AGENTS.md",focus:""}}},{id:"bad",draft:{name:"../../逃逸"}}]
   }),"utf8");
   const { catalog, drafts }=readProjectInitPresets([tmp]);
   assert.equal(catalog.health,"ok");
   assert.equal(drafts.length,1);
   assert.equal(drafts[0].draft.name,"好模板");
   assert.equal(catalog.problems.length,1);
   assert.match(catalog.problems[0],/不是合法的初始化模板/);
   // 报错要点得出**哪里**不合法(路径逃逸),不是一句笼统的"坏"。
   assert.match(catalog.problems[0],/name/,"逐条问题里要带出错字段");
  }finally{await (await import("node:fs/promises")).rm(tmp,{recursive:true,force:true});}
 });

 // 事件名**只有一份**:设置页改了模板要通知对话里的 `/init` 选择框刷新。
 // 它曾经在 `useProjectInitializer.tsx` 与 `ProjectInitManager.tsx` 各写了一份字面量
 // (前者刻意不 import 后者,免得把设置编辑器拉进每个对话),于是**改一处漏一处就静默不刷新**。
 // 现在两份都引用契约里的同一个常量;这条断言盯的就是"别再回去各写一份"。
 await test("project-init 变更事件名只有一份,两处都引用契约常量",async()=>{
  const { PROJECT_INIT_CHANGED_EVENT } = await import("@contracts/ipc/projectInit.js");
  assert.equal(PROJECT_INIT_CHANGED_EVENT,"mcode:project-initializers-changed","契约里的字面量是唯一那份,值别改(改了旧窗口监听不上)");
  const dir = join(process.cwd(), "src/renderer/components");
  const fromUse=await readFile(join(dir,"chat/useProjectInitializer.tsx"),"utf8");
  const fromManager=await readFile(join(dir,"memory/ProjectInitManager.tsx"),"utf8");
  assert.match(fromUse,/PROJECT_INIT_CHANGED_EVENT/,"useProjectInitializer 必须引用契约常量");
  assert.match(fromManager,/PROJECT_INIT_CHANGED_EVENT/,"ProjectInitManager 必须引用契约常量");
  // 两处都不得再出现裸字面量(引用契约变量不算)。
  assert.doesNotMatch(fromUse,/"mcode:project-initializers-changed"/,"useProjectInitializer 里不该再有裸字面量");
  assert.doesNotMatch(fromManager,/"mcode:project-initializers-changed"/,"ProjectInitManager 里不该再有裸字面量");
 });
} finally { await rm(base,{recursive:true,force:true}); }
console.log(`Project init smoke: ${passed} pass, ${failed} fail`);process.exitCode=failed?1:0;
