/** F026: persistent Theia VSIX installs. Startup only restores metadata; never auto-runs code. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import * as path from "node:path";
import { buildExtensionPermissionReport } from "../theiaPermissionReport.js";
import { buildInstallConsentPrompt } from "./installConsent.js";
import { parseTheiaVsix } from "./theiaVsixPreview.js";
import { TheiaHost, type TheiaExtensionHandle, type TheiaNativeTerminalDriver } from "./host.js";
import { McodeWorkspaceFs } from "./mcodeWorkspaceFs.js";
import { McodeExtensionPreferences } from "./mcodeExtensionPreferences.js";
import type { TheiaInstalledEntry, TheiaInstalledResult, TheiaMonacoEditorSnapshot, TheiaEditorMenu, TheiaNativeConfigSetting, TheiaExtensionDiagnostic } from "@contracts/ipc/modules.js";

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
interface Pending { ticket: string; senderId: number; createdAt: number; root: string; record: Saved; upgradeOf?:string; oldVersion?:string; previousArchiveHash?:string }
interface Running { id: string; senderId: number; sessionId: string; host: TheiaHost;
  handle: TheiaExtensionHandle; commands: Set<string>; editorMenus:TheiaEditorMenu[];
  languageProviders:Array<{kind:"hover"|"completion";language:string}>;
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
  /** One session per installed extension. Different extensions may run together; no automatic startup. */
  private readonly running = new Map<string, Running>();
  private readonly maxActive = 8;
  private findSession(sessionId: string): Running | undefined {
    for (const run of this.running.values()) if (run.sessionId === sessionId) return run;
    return undefined;
  }
  private closed = new Set<number>();
  constructor(private readonly root: string, private readonly theiaRoot: string) {
    if (!path.isAbsolute(root)) deny("扩展数据根必须是绝对路径");
    this.installed = path.join(root,"installed");
    this.staging = path.join(root,"staging");
    for (const folder of [root,this.installed,this.staging]) {
      if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())) deny("扩展数据目录被重定向");
      mkdirSync(folder,{recursive:true});
    }
    // Crash recovery: an incomplete upgrade MUST NOT strand the old version.
    // Restore any old installation held in a protected backup directory,
    // preserving its storage instead of trusting an unfinished replacement.
    for(const name of readdirSync(this.staging)){
      if(!/^backup-[0-9a-f-]{36}$/i.test(name))continue;
      const backup=path.join(this.staging,name);
      try{
        const rec=JSON.parse(readFileSync(path.join(backup,"record.json"),"utf8")) as Saved;
        validateRecord(rec,rec.id);
        const dest=this.dir(rec.id);
        if(existsSync(dest)){
          const saved=path.join(dest,"storage");
          const oldStorage=path.join(backup,"storage");
          if(existsSync(saved)&&!existsSync(oldStorage))renameSync(saved,oldStorage);
          const abandoned=path.join(this.staging,"aborted-"+randomUUID());
          renameSync(dest,abandoned);
        }
        renameSync(backup,dest);
      }catch{/* Keep backup; never delete user data on an uncertain recovery. */}
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
    const current=this.running.get(rec.id);
    const owned=current!==undefined && senderId!==undefined && current.senderId===senderId && !this.closed.has(senderId);
    return {id:rec.id,extensionId:rec.extensionId,version:rec.version,enabled:rec.enabled,
      installedAt:rec.installedAt,running:current!==undefined,integrity:"not-checked",
      ...(owned ? {activeSession:{sessionId:current.sessionId,commands:[...current.commands].sort(),editorMenus:current.editorMenus,languageProviders:current.languageProviders}} : {})};
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
      const existing=this.list().find(x=>!x.corrupted&&x.extensionId===extensionId);
      let upgradeOf:string|undefined,oldVersion:string|undefined,previousArchiveHash:string|undefined;
      if(existing){
        if(existing.running||this.startingId===existing.id)deny("升级前必须停止扩展");
        const old=this.read(existing.id);
        await this.verify(existing.id,old);
        const parts=(version:string)=>{
          const match=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i.exec(version);
          if(!match)deny("升级要求语义化版本号（如 1.2.3）");
          return [Number(match[1]),Number(match[2]),Number(match[3]),match[4]??""] as const;
        };
        const current=parts(old.version),next=parts(manifest.version);
        const cmp=next[0]-current[0]||next[1]-current[1]||next[2]-current[2]||
          (current[3]!==next[3]?(current[3]?(next[3]?next[3].localeCompare(current[3]):1):-1):0);
        if(cmp<=0)deny("升级版本必须高于现有版本");
        upgradeOf=old.id;oldVersion=old.version;previousArchiveHash=old.archiveHash;
      }
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
        const rec:Saved={format:1,id:upgradeOf??id,extensionId,version:manifest.version,main:archive.main,
          archiveHash:hash(bytes),installedAt:upgradeOf?this.read(upgradeOf).installedAt:Date.now(),
          enabled:upgradeOf?this.read(upgradeOf).enabled:true,files};
        validateRecord(rec,rec.id);
        const ticket=randomUUID();
        this.pending={senderId,ticket,createdAt:Date.now(),root:stage,record:rec,
          upgradeOf,oldVersion,previousArchiveHash};
        this.timer=setTimeout(()=>{if(this.pending?.ticket===ticket)this.discard();},AGE_MS);
        this.timer.unref?.();
        return {kind:"inspected",ticket,extensionId,prompt:buildInstallConsentPrompt(report),
          fileCount:Object.keys(files).length,
          ...(upgradeOf?{upgradeFrom:oldVersion,newVersion:manifest.version}:{}),
        };
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
      const dest=this.dir(pending.record.id);
      if(!pending.upgradeOf){
        if(this.list().some(x=>!x.corrupted&&x.extensionId===pending.record.extensionId)) deny("扩展已安装");
        writeFileSync(path.join(pending.root,"record.json"),JSON.stringify(pending.record),{flag:"wx"});
        if(existsSync(dest))deny("目标已存在");
        renameSync(pending.root,dest);
        return {kind:"installed",item:this.item(pending.record)};
      }
      if(pending.upgradeOf!==pending.record.id||this.running.has(pending.upgradeOf)||
         this.startingId===pending.upgradeOf) deny("运行中的扩展不能升级");
      const before=this.read(pending.upgradeOf);
      if(before.extensionId!==pending.record.extensionId||before.version!==pending.oldVersion||
         before.archiveHash!==pending.previousArchiveHash)deny("升级期间旧扩展已变化，请重新预检");
      const backup=path.join(this.staging,"backup-"+randomUUID());
      writeFileSync(path.join(pending.root,"record.json"),JSON.stringify(pending.record),{flag:"wx"});
      // The entire old version is protected until the new installation exists
      // with the SAME ID and the same user storage. Any incomplete backup
      // is recovered conservatively in the registry constructor on next start.
      renameSync(dest,backup);
      let swapped=false,storageMoved=false;
      try{
        renameSync(pending.root,dest);swapped=true;
        if(existsSync(path.join(backup,"storage"))){
          renameSync(path.join(backup,"storage"),path.join(dest,"storage"));
          storageMoved=true;
        }
      }catch(error){
        try{
          if(storageMoved)renameSync(path.join(dest,"storage"),path.join(backup,"storage"));
          if(swapped)renameSync(dest,pending.root);
          renameSync(backup,dest);
        }catch{/* Preserve the backup for recovery, do not delete user data. */}
        throw error;
      }
      // Fully installed. Backup contains only the retired payload.
      rmSync(backup,{recursive:true,force:true});
      return {kind:"upgraded",item:this.item(pending.record)};
    }catch(error){rmSync(pending.root,{recursive:true,force:true});throw error;}
  }
  private update(rec:Saved):void{
    const folder=this.dir(rec.id),tmp=path.join(folder,"record-"+randomUUID()+".tmp");
    try{writeFileSync(tmp,JSON.stringify(rec),{flag:"wx"});renameSync(tmp,path.join(folder,"record.json"));}
    finally{rmSync(tmp,{force:true});}
  }
  /** Manage ONLY settings declared in this installed extension's own manifest. */
  private async settings(id:string):Promise<{
    settings:TheiaNativeConfigSetting[];types:Map<string,TheiaNativeConfigSetting["type"]>;
  }> {
    const rec=this.read(id);
    await this.verify(id,rec);
    const manifest=JSON.parse(readFileSync(path.join(this.dir(id),"extension","package.json"),"utf8")) as {
      contributes?:{configuration?:{properties?:Record<string,{
        type?:unknown;default?:unknown;description?:unknown;
      }>}|Array<{properties?:Record<string,{
        type?:unknown;default?:unknown;description?:unknown;
      }>}>};
    };
    const sections=Array.isArray(manifest.contributes?.configuration)?
      manifest.contributes.configuration:manifest.contributes?.configuration?[manifest.contributes.configuration]:[];
    const prefs=await McodeExtensionPreferences.open(path.join(this.dir(id),"storage"));
    const user=prefs.user,settings:TheiaNativeConfigSetting[]=[];
    const types=new Map<string,TheiaNativeConfigSetting["type"]>();
    for(const section of sections){
      for(const [key,spec] of Object.entries(section.properties??{})){
        if(!/^[a-zA-Z0-9_.-]{1,150}$/.test(key)||types.has(key)||settings.length>=150)continue;
        if(spec.type!=="string"&&spec.type!=="boolean"&&spec.type!=="number")continue;
        const type=spec.type;
        const value=Object.hasOwn(user,key)?user[key]:spec.default;
        if(value!==undefined&&typeof value!==type)continue;
        types.set(key,type);
        settings.push({key,type,value:(value??null) as string|number|boolean|null,
          ...(typeof spec.description==="string"?{description:spec.description.slice(0,500)}:{})});
      }
    }
    return {settings:settings.sort((a,b)=>a.key.localeCompare(b.key)),types};
  }
  async configList(id:string):Promise<TheiaInstalledResult>{
    return {kind:"configurations",settings:(await this.settings(id)).settings};
  }
  async configSet(senderId:number,id:string,key:string,value:string|number|boolean|null):Promise<TheiaInstalledResult>{
    if(this.startingId===id)deny("扩展启动期间不可修改配置");
    const {types}=await this.settings(id);
    const type=types.get(key);
    if(!type)deny("配置项并非该扩展声明的合法设置");
    if(value!==null&&typeof value!==type)deny("配置类型不匹配");
    const current=this.running.get(id);
    if(current&&current.senderId!==senderId)deny("其他桌面窗口不可修改运行中扩展的配置");
    if(current)await current.host.updatePreference(key,value===null?undefined:value);
    else await (await McodeExtensionPreferences.open(path.join(this.dir(id),"storage")))
      .update(key,value===null?undefined:value);
    return {kind:"configurationUpdated"};
  }
  setEnabled(id:string,enabled:boolean):TheiaInstalledResult{
    if(this.running.has(id)||this.startingId===id) deny("请先停止扩展");
    // Changing metadata cannot execute extension code; full integrity is checked on start.
    const rec=this.read(id);rec.enabled=enabled;this.update(rec);
    return {kind:"updated",item:this.item(rec)};
  }
  async start(senderId:number,id:string,onMessage?:(
    sessionId:string,extensionId:string,input:{type:number;message:string;detail?:string;modal:boolean;actions:string[]}
  )=>Promise<number|undefined>,workspacePath?:string,onQuickInput?:(
    sessionId:string,extensionId:string,input:{kind:"input"|"pick";title?:string;placeholder?:string;
      value?:string;password?:boolean;canPickMany?:boolean;
      items?:Array<{label:string;description?:string;detail?:string}>}
  )=>Promise<string|number[]|undefined>,onStatus?:(
    sessionId:string,extensionId:string,item:{id:string;removed?:boolean;text?:string;
      name?:string;tooltip?:string;command?:string;priority?:number;alignment?:number}
  )=>void,onDiagnostics?:(
    sessionId:string,collectionId:string,resource:string,
    markers:TheiaExtensionDiagnostic[],removed?:boolean
  )=>void,makeTerminalDriver?:(sessionId:string,root:string)=>TheiaNativeTerminalDriver,
    onWebview?:(sessionId:string,extensionId:string,event:{
      handle:string;action:"create"|"html"|"message"|"dispose"|"title";
      title?:string;html?:string;payload?:unknown
    })=>void):Promise<TheiaInstalledResult>{
    if(this.closed.has(senderId)||this.starting||this.running.has(id)) deny("该扩展已启动或正在启动");
    if(this.running.size>=this.maxActive) deny("同时运行的扩展已达资源上限");
    const rec=this.read(id);
    if(!rec.enabled) deny("扩展已禁用");
    this.starting=true;this.startingSender=senderId;this.startingId=id;
    // Allocate a stable session before activation: many extensions display an
    // informational prompt while activate() is pending. Responses must be
    // sender/session-scoped even before the extension reaches Running.
    const sessionId=randomUUID();
    let host:TheiaHost|undefined;
    try{
    const workspaceFs=workspacePath?await McodeWorkspaceFs.open(workspacePath):undefined;
    host=new TheiaHost({theiaRoot:this.theiaRoot,extensionDir:path.join(this.dir(id),"extension"),
      workspaceRoot:workspaceFs?.root,workspaceFs,
      ...(workspaceFs&&makeTerminalDriver?{terminalDriver:makeTerminalDriver(sessionId,workspaceFs.root)}:{}),
      storageRoot:path.join(this.dir(id),"storage"),
      onMessage: onMessage?(input)=>onMessage(sessionId,rec.extensionId,input):undefined,
      onQuickInput: onQuickInput?(input)=>onQuickInput(sessionId,rec.extensionId,input):undefined,
      onStatus: onStatus?(item)=>onStatus(sessionId,rec.extensionId,item):undefined,
      onDiagnostics:onDiagnostics?(collectionId,resource,markers,removed)=>onDiagnostics(sessionId,collectionId,resource,markers,removed):undefined,
      onWebview:onWebview?(event)=>onWebview(sessionId,rec.extensionId,event):undefined});
      await this.verify(id,rec); // fail closed before any untrusted extension code is spawned
      await host.start();const handle=await host.activate(),commands=await handle.commands();
      if(this.closed.has(senderId)) deny("启动期间窗口已关闭");
      // Main-owned, integrity-checked manifest contributions. Only supported
      // unconditional/editor-focus menus enter Monaco, not a fabricated Theia UI.
      const manifest=JSON.parse(readFileSync(path.join(this.dir(id),"extension","package.json"),"utf8")) as {
        contributes?:{commands?:Array<{command?:string;title?:string}>;
          menus?:Record<string,Array<{command?:string;when?:string;group?:string}>>};
      };
      const titles=new Map((manifest.contributes?.commands??[])
        .filter(c=>typeof c.command==="string").map(c=>[c.command!,c.title??c.command!]));
      const editorMenus:TheiaEditorMenu[]=(manifest.contributes?.menus?.["editor/context"]??[])
        .filter(menu=>typeof menu.command==="string"&&commands.includes(menu.command)&&
          (!menu.when||menu.when==="editorTextFocus"))
        .slice(0,40).map(menu=>({
          commandId:menu.command!,label:titles.get(menu.command!)??menu.command!,
          ...(typeof menu.group==="string"?{group:menu.group.slice(0,100)}:{}),
        }));
      this.running.set(id,{id,senderId,sessionId,host,handle,commands:new Set(commands),editorMenus,languageProviders:host.getLanguageDescriptors()});
      return {kind:"started",id,sessionId,commands,activationErrors:handle.activationErrors.map(e=>e.message).slice(0,8)};
    }catch(error){await host?.dispose();throw error;}
    finally{this.starting=false;this.startingSender=null;this.startingId=null;}
  }
  /** Sync one REAL Mcode editor snapshot on user command invocation, not on every keystroke.
   * Owner callback only resolves after the renderer's Monaco model accepted the undoable edits.
   */
  async editorSync(senderId:number,sessionId:string,input:TheiaMonacoEditorSnapshot|null,
    apply: (transaction:import("./editorTransactions.js").EditorEditTransaction)=>Promise<boolean>):Promise<TheiaInstalledResult> {
    const current=this.findSession(sessionId);
    if(!current||current.senderId!==senderId||this.closed.has(senderId)||
       current.syncing||current.executing) deny("仅当前窗口的空闲运行会话可以同步编辑器");
    if(input && (!path.isAbsolute(input.filePath)||input.text.length>2_000_000)) deny("编辑器文档不符合安全边界");
    current.syncing=true;
    try{
      const bridge=current.editorBridge??=current.host.editors();
      await bridge.setActive(input===null?null:{...input,applyEdits:apply});
      if(this.running.get(current.id)!==current||this.closed.has(senderId)) deny("同步期间会话已失效");
      return {kind:"editorSynced",active:input!==null};
    }finally{current.syncing=false;}
  }
  async webviewMessage(senderId:number,sessionId:string,handle:string,payload:unknown):Promise<TheiaInstalledResult>{
    const current=this.findSession(sessionId);
    if(!current||current.senderId!==senderId||this.closed.has(senderId))
      deny("扩展 Webview 已失效或不属于当前窗口");
    const value=JSON.stringify(payload);
    if(value===undefined||value.length>64_000)deny("扩展 Webview 消息内容过大");
    await current.host.sendWebviewMessage(handle,payload);
    return {kind:"webviewAcknowledged"};
  }
  async webviewDispose(senderId:number,sessionId:string,handle:string):Promise<TheiaInstalledResult>{
    const current=this.findSession(sessionId);
    if(!current||current.senderId!==senderId||this.closed.has(senderId))
      deny("扩展 Webview 已失效或不属于当前窗口");
    await current.host.disposeWebview(handle);
    return {kind:"webviewAcknowledged"};
  }
  async languageQuery(senderId:number,sessionId:string,kind:"hover"|"completion",
    lineNumber:number,column:number):Promise<TheiaInstalledResult>{
    const active=this.findSession(sessionId);
    if(!active||active.senderId!==senderId||this.closed.has(senderId)||active.syncing||
      active.executing)deny("非法或忙碌的扩展语言会话");
    return {kind:"languageResult",...await active.host.languageQuery(kind,lineNumber,column)};
  }
  async execute(senderId:number,sessionId:string,commandId:string,args:readonly string[]=[]):Promise<TheiaInstalledResult>{
    const current=this.findSession(sessionId);
    if(!current||current.senderId!==senderId||
       !current.commands.has(commandId)||current.syncing||current.executing) deny("扩展会话或命令不存在/正在忙碌");
    current.executing=true;
    try{
      const result=await current.handle.executeCommand<unknown>(commandId,...args);
      if(this.running.get(current.id)!==current||this.closed.has(senderId)) deny("扩展已停止");
      let output:string;try{output=JSON.stringify(result)??"undefined";}catch{output="[unserializable]";}
      return {kind:"executed",result:output.slice(0,3000)};
    }finally{current.executing=false;}
  }
  async stop(senderId:number,sessionId:string):Promise<TheiaInstalledResult>{
    const current=this.findSession(sessionId);
    if(!current||current.senderId!==senderId) deny("扩展会话不存在");
    this.running.delete(current.id);await current.host.dispose();return {kind:"stopped"};
  }
  remove(id:string):TheiaInstalledResult{
    if(this.running.has(id)||this.startingId===id) deny("请先停止正在启动或运行的扩展");
    this.read(id);rmSync(this.dir(id),{recursive:true,force:true});return {kind:"removed",id};
  }
  async disposeSender(senderId:number):Promise<void>{
    this.closed.add(senderId);
    if(this.pending?.senderId===senderId)this.discard();
    const owned=[...this.running.values()].filter(run=>run.senderId===senderId);
    for(const run of owned)this.running.delete(run.id);
    await Promise.allSettled(owned.map(run=>run.host.dispose()));
  }
  async disposeAll():Promise<void>{
    this.discard();
    if(this.startingSender!==null)this.closed.add(this.startingSender);
    const active=[...this.running.values()];this.running.clear();
    await Promise.allSettled(active.map(run=>run.host.dispose()));
  }
}
