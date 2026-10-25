/** F026: persistent Theia VSIX installs. Startup only restores metadata; never auto-runs code. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import * as path from "node:path";
import { buildExtensionPermissionReport } from "../theiaPermissionReport.js";
import { buildInstallConsentPrompt } from "./installConsent.js";
import { parseTheiaVsix } from "./theiaVsixPreview.js";
import { TheiaHost, type TheiaExtensionHandle } from "./host.js";
import type { TheiaInstalledEntry, TheiaInstalledResult, TheiaMonacoEditorSnapshot } from "@contracts/ipc/modules.js";

const MAX_ARCHIVE = 64 * 1024 * 1024;
const AGE_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const safeId = /^[a-z0-9][a-z0-9._-]{0,100}$/i;
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function deny(reason: string): never { throw Error("THEIA_INSTALLED_REJECT: " + reason); }

interface Saved {
  format: 1; id: string; extensionId: string; version: string; main: string;
  archiveHash: string; installedAt: number; enabled: boolean; files: Record<string,string>;
}
interface Pending { ticket: string; senderId: number; createdAt: number; root: string; record: Saved }
interface Running { id: string; senderId: number; sessionId: string; host: TheiaHost;
  handle: TheiaExtensionHandle; commands: Set<string>;
  editorBridge?: ReturnType<TheiaHost["editors"]>; syncing?: boolean; executing?: boolean;
}

function validateRecord(input: unknown, id: string): Saved {
  if (!input || typeof input !== "object" || Array.isArray(input)) deny("安装记录无效");
  const rec = input as Partial<Saved>;
  if (rec.format !== 1 || rec.id !== id || !UUID.test(id) ||
      typeof rec.extensionId !== "string" || rec.extensionId.length > 225 ||
      typeof rec.version !== "string" || !safeId.test(rec.version) ||
      typeof rec.main !== "string" || rec.main.length > 400 ||
      typeof rec.archiveHash !== "string" || !HASH.test(rec.archiveHash) ||
      typeof rec.enabled !== "boolean" || !Number.isSafeInteger(rec.installedAt) ||
      !rec.files || typeof rec.files !== "object" || Array.isArray(rec.files)) deny("安装记录格式不可信");
  const files = Object.entries(rec.files);
  if (files.length < 2 || files.length > 3000 ||
      !Object.hasOwn(rec.files, "package.json") || !Object.hasOwn(rec.files, rec.main)) deny("安装清单不完整");
  for (const [name, digest] of files) {
    if (!name || name.startsWith("/") || name.includes("\\") || name.length > 400 ||
        /[<>:"|?*]/.test(name) || name.split("/").some(s => !s || s==="." || s==="..") ||
        !HASH.test(digest)) deny("安装清单存在危险路径或哈希");
  }
  return rec as Saved;
}

export class TheiaInstalledRegistry {
  private readonly installed: string;
  private readonly staging: string;
  private pending: Pending | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inspecting = false;
  private starting = false;
  private startingSender: number | null = null;
  private startingId: string | null = null;
  private running: Running | null = null;
  private closed = new Set<number>();
  constructor(private readonly root: string, private readonly theiaRoot: string) {
    if (!path.isAbsolute(root)) deny("扩展数据根必须是绝对路径");
    this.installed = path.join(root,"installed");
    this.staging = path.join(root,"staging");
    for (const folder of [root,this.installed,this.staging]) {
      if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())) deny("扩展数据目录被重定向");
      mkdirSync(folder,{recursive:true});
    }
    // Expired staging files never restore user consent following a crash.
    for (const name of readdirSync(this.staging)) {
      const p=path.join(this.staging,name);
      if (UUID.test(name) && lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink()) rmSync(p,{recursive:true,force:true});
    }
  }
  private dir(id:string):string {
    if(!UUID.test(id)) deny("安装 ID 无效");
    return path.join(this.installed,id);
  }
  private read(id:string):Saved {
    const folder=this.dir(id), st=lstatSync(folder);
    if(!st.isDirectory()||st.isSymbolicLink()) deny("扩展目录不是普通文件夹");
    const file=path.join(folder,"record.json"), stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>300000) deny("安装记录可能被替换");
    let value:unknown;
    try {value=JSON.parse(readFileSync(file,"utf8"));} catch {deny("安装记录 JSON 损坏");}
    return validateRecord(value,id);
  }
  /** Full integrity is a LAUNCH gate, not an Electron main-thread catalogue operation.
   * Stream via async filesystem I/O: no 32 MB per-file Buffer and no synchronous hashing loop.
   * This is still an integrity check, not OS-level filesystem isolation / a sandbox.
   */
  private async verify(id:string, rec:Saved):Promise<void> {
    const base=path.join(this.dir(id),"extension"), stat=await lstatAsync(base);
    if(!stat.isDirectory()||stat.isSymbolicLink()) deny("扩展根目录可能被替换");
    const seen=new Set<string>();
    const walk=async(dir:string,prefix=""):Promise<void>=>{
      for(const item of await readdirAsync(dir)){
        const name=prefix?prefix+"/"+item:item, absolute=path.join(dir,item), st=await lstatAsync(absolute);
        if(st.isSymbolicLink()) deny("扩展包含符号链接");
        if(st.isDirectory()) {await walk(absolute,name);continue;}
        if(!st.isFile()||st.nlink!==1||st.size>32*1024*1024||
            !Object.hasOwn(rec.files,name)) deny("扩展文件校验失败: "+name);
        const digest=createHash("sha256");
        let total=0;
        // The async iterator returns to the event loop between bounded chunks.
        for await(const chunk of createReadStream(absolute,{highWaterMark:128*1024})){
          const bytes=chunk as Buffer;
          total+=bytes.length;
          if(total>32*1024*1024) deny("扩展文件在校验期间变得过大: "+name);
          digest.update(bytes);
        }
        if(total!==st.size||digest.digest("hex")!==rec.files[name]) deny("扩展文件校验失败: "+name);
        seen.add(name);
      }
    };
    await walk(base);
    if(seen.size!==Object.keys(rec.files).length) deny("扩展文件缺失");
  }
  private item(rec:Saved,senderId?:number):TheiaInstalledEntry {
    const current=this.running;
    const owned=current?.id===rec.id && senderId!==undefined && current.senderId===senderId && !this.closed.has(senderId);
    return {id:rec.id,extensionId:rec.extensionId,version:rec.version,enabled:rec.enabled,
      installedAt:rec.installedAt,running:current?.id===rec.id,integrity:"not-checked",
      ...(owned ? {activeSession:{sessionId:current.sessionId,commands:[...current.commands].sort()}} : {})};
  }
  /** Metadata-only list: never read/hash extension payloads when opening the Mcode panel. */
  list(senderId?:number):TheiaInstalledEntry[] {
    const items:TheiaInstalledEntry[]=[];
    for(const name of readdirSync(this.installed)) {
      if(!UUID.test(name)) continue;
      try {const rec=this.read(name);items.push(this.item(rec,senderId));}
      catch {items.push({id:name,extensionId:"[corrupt installation]",version:"?",enabled:false,
        installedAt:0,running:false,corrupted:true,integrity:"corrupt"});}
    }
    return items.sort((a,b)=>a.extensionId.localeCompare(b.extensionId));
  }
  private discard():void {
    if(this.timer) clearTimeout(this.timer);
    this.timer=null;
    const old=this.pending;this.pending=null;
    if(old) rmSync(old.root,{recursive:true,force:true});
  }
  async inspect(senderId:number, filename:string):Promise<TheiaInstalledResult>{
    if(this.closed.has(senderId)||this.inspecting||this.starting) deny("窗口已关闭或操作冲突");
    if(this.pending && this.pending.senderId!==senderId) deny("其他窗口存在未完成的安装预检");
    this.inspecting=true;
    try{
      if(!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!==".vsix") deny("请选择绝对路径 VSIX 文件");
      const st=lstatSync(filename);
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>MAX_ARCHIVE) deny("VSIX 文件非法或过大");
      const bytes=readFileSync(filename), archive=parseTheiaVsix(bytes);
      const manifest=JSON.parse(Buffer.from(archive.files.get("extension/package.json")!).toString("utf8")) as Record<string,unknown>;
      if(typeof manifest.publisher!=="string"||!safeId.test(manifest.publisher)||
         typeof manifest.name!=="string"||!safeId.test(manifest.name)||
         typeof manifest.version!=="string"||!safeId.test(manifest.version)) deny("扩展身份字段非法");
      const extensionId=(manifest.publisher+"."+manifest.name).toLowerCase();
      if(this.list().some(x=>!x.corrupted&&x.extensionId===extensionId)) deny("已安装此扩展，请先手动卸载旧版本");
      this.discard();
      const id=randomUUID(),stage=path.join(this.staging,id);
      mkdirSync(path.join(stage,"extension"),{recursive:true});
      const files:Record<string,string>=Object.create(null) as Record<string,string>;
      try{
        for(const [name,data] of archive.files){
          if(!name.startsWith("extension/")) continue;
          const relative=name.slice("extension/".length), target=path.resolve(stage,name);
          if(!target.startsWith(stage+path.sep)) deny("解包目标越界");
          mkdirSync(path.dirname(target),{recursive:true});
          writeFileSync(target,data,{flag:"wx"});
          files[relative]=hash(data);
        }
        const report=await buildExtensionPermissionReport(path.join(stage,"extension"),{entry:archive.main});
        if(this.closed.has(senderId)) deny("预检期间窗口已关闭");
        if(report.limits.some(x=>/读取 package.json 失败|没有 main \/ browser|入口路径在扩展目录之外/.test(x))) deny("静态能力报告不完整");
        const rec:Saved={format:1,id,extensionId,version:manifest.version,main:archive.main,
          archiveHash:hash(bytes),installedAt:Date.now(),enabled:true,files};
        validateRecord(rec,id);
        const ticket=randomUUID();
        this.pending={senderId,ticket,createdAt:Date.now(),root:stage,record:rec};
        this.timer=setTimeout(()=>{if(this.pending?.ticket===ticket)this.discard();},AGE_MS);
        this.timer.unref?.();
        return {kind:"inspected",ticket,extensionId,prompt:buildInstallConsentPrompt(report),fileCount:Object.keys(files).length};
      }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}
    }finally{this.inspecting=false;}
  }
  cancel(senderId:number,ticket:string):TheiaInstalledResult {
    if(this.pending?.senderId!==senderId||this.pending?.ticket!==ticket) deny("授权已失效");
    this.discard();return {kind:"stopped"};
  }
  install(senderId:number,ticket:string,accepted:true):TheiaInstalledResult{
    const pending=this.pending;
    if(!pending||pending.senderId!==senderId||pending.ticket!==ticket||
       this.closed.has(senderId)||accepted!==true||Date.now()-pending.createdAt>AGE_MS) deny("安装必须由预检窗口本人确认");
    this.pending=null;if(this.timer)clearTimeout(this.timer);this.timer=null;
    try{
      if(this.list().some(x=>!x.corrupted&&x.extensionId===pending.record.extensionId)) deny("扩展已安装");
      writeFileSync(path.join(pending.root,"record.json"),JSON.stringify(pending.record),{flag:"wx"});
      const dest=this.dir(pending.record.id);
      if(existsSync(dest)) deny("目标已存在");
      renameSync(pending.root,dest); // same volume, atomic appearance
      return {kind:"installed",item:this.item(pending.record)};
    }catch(error){rmSync(pending.root,{recursive:true,force:true});throw error;}
  }
  private update(rec:Saved):void{
    const folder=this.dir(rec.id),tmp=path.join(folder,"record-"+randomUUID()+".tmp");
    try{writeFileSync(tmp,JSON.stringify(rec),{flag:"wx"});renameSync(tmp,path.join(folder,"record.json"));}
    finally{rmSync(tmp,{force:true});}
  }
  setEnabled(id:string,enabled:boolean):TheiaInstalledResult{
    if(this.running?.id===id||this.startingId===id) deny("请先停止扩展");
    // Changing metadata cannot execute extension code; full integrity is checked on start.
    const rec=this.read(id);rec.enabled=enabled;this.update(rec);
    return {kind:"updated",item:this.item(rec)};
  }
  async start(senderId:number,id:string):Promise<TheiaInstalledResult>{
    if(this.closed.has(senderId)||this.starting||this.running) deny("已有扩展启动或运行");
    const rec=this.read(id);
    if(!rec.enabled) deny("扩展已禁用");
    this.starting=true;this.startingSender=senderId;this.startingId=id;
    const host=new TheiaHost({theiaRoot:this.theiaRoot,extensionDir:path.join(this.dir(id),"extension"),storageRoot:path.join(this.dir(id),"storage")});
    try{
      await this.verify(id,rec); // fail closed before any untrusted extension code is spawned
      await host.start();const handle=await host.activate(),commands=await handle.commands();
      if(this.closed.has(senderId)) deny("启动期间窗口已关闭");
      const sessionId=randomUUID();
      this.running={id,senderId,sessionId,host,handle,commands:new Set(commands)};
      return {kind:"started",id,sessionId,commands,activationErrors:handle.activationErrors.map(e=>e.message).slice(0,8)};
    }catch(error){await host.dispose();throw error;}
    finally{this.starting=false;this.startingSender=null;this.startingId=null;}
  }
  /** Sync one REAL Mcode editor snapshot on user command invocation, not on every keystroke.
   * Owner callback only resolves after the renderer's Monaco model accepted the undoable edits.
   */
  async editorSync(senderId:number,sessionId:string,input:TheiaMonacoEditorSnapshot|null,
    apply: (transaction:import("./editorTransactions.js").EditorEditTransaction)=>Promise<boolean>):Promise<TheiaInstalledResult> {
    const current=this.running;
    if(!current||current.senderId!==senderId||current.sessionId!==sessionId||this.closed.has(senderId)||
       current.syncing||current.executing) deny("仅当前窗口的空闲运行会话可以同步编辑器");
    if(input && (!path.isAbsolute(input.filePath)||input.text.length>2_000_000)) deny("编辑器文档不符合安全边界");
    current.syncing=true;
    try{
      const bridge=current.editorBridge??=current.host.editors();
      await bridge.setActive(input===null?null:{...input,applyEdits:apply});
      if(this.running!==current||this.closed.has(senderId)) deny("同步期间会话已失效");
      return {kind:"editorSynced",active:input!==null};
    }finally{current.syncing=false;}
  }
  async execute(senderId:number,sessionId:string,commandId:string,args:readonly string[]=[]):Promise<TheiaInstalledResult>{
    const current=this.running;
    if(!current||current.senderId!==senderId||current.sessionId!==sessionId||
       !current.commands.has(commandId)||current.syncing||current.executing) deny("扩展会话或命令不存在/正在忙碌");
    current.executing=true;
    try{
      const result=await current.handle.executeCommand<unknown>(commandId,...args);
      if(this.running!==current||this.closed.has(senderId)) deny("扩展已停止");
      let output:string;try{output=JSON.stringify(result)??"undefined";}catch{output="[unserializable]";}
      return {kind:"executed",result:output.slice(0,3000)};
    }finally{current.executing=false;}
  }
  async stop(senderId:number,sessionId:string):Promise<TheiaInstalledResult>{
    const current=this.running;
    if(!current||current.senderId!==senderId||current.sessionId!==sessionId) deny("扩展会话不存在");
    this.running=null;await current.host.dispose();return {kind:"stopped"};
  }
  remove(id:string):TheiaInstalledResult{
    if(this.running?.id===id||this.startingId===id) deny("请先停止正在启动或运行的扩展");
    this.read(id);rmSync(this.dir(id),{recursive:true,force:true});return {kind:"removed",id};
  }
  async disposeSender(senderId:number):Promise<void>{
    this.closed.add(senderId);
    if(this.pending?.senderId===senderId)this.discard();
    const run=this.running;
    if(run?.senderId===senderId){this.running=null;await run.host.dispose();}
  }
  async disposeAll():Promise<void>{
    this.discard();
    if(this.startingSender!==null)this.closed.add(this.startingSender);
    const run=this.running;this.running=null;if(run)await run.host.dispose();
  }
}
