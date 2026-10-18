import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataRoot } from "@main/lib/dataRoot.js";
import { isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";
import { EXAMPLE_MODULE, ModuleManifestSchema, moduleRefusalError, type ModuleManifest } from "@contracts/modules";
import { ModuleHost, type ActionApprovalRequest } from "./ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "./fileCapabilities.js";
import { verifyPermissionedProgram } from "./permissionedProcessRunner.js";

/**
 * 【MC-060】**生产审批端口** —— 一个 `action` 能力**每次执行**前,宿主经它拿到用户批准。
 *
 * 端口本身留在**本模块**(纯 Node,不 import Electron):宿主与它同款注入,`service.ts`
 * 被多个无头 smoke bundle,不能把 electron 拉进来。真实现(原生确认框)在
 * `moduleApproval.ts`,由 `index.ts` 在启动装配期经 `configureModuleApprovalPort` 装上。
 *
 * **fail-closed** 与 `gateAppAction` 一致:没装上端口(= 这个环境没有可用的审批通道)→
 * 一律拒(`approval_unavailable`),写档动作绝不被"没界面问"默认放行。装上之后不回退。
 */
export type ModuleApprovalPort = (request: ActionApprovalRequest) => Promise<void>;
let approvalPort: ModuleApprovalPort | null = null;
/** 装配期唯一入口(由 `index.ts` 调 `assembleModuleApprovalPort()`)。传 `null` 可卸载,仅测试用。 */
export function configureModuleApprovalPort(next: ModuleApprovalPort | null): void { approvalPort = next; }
/** 宿主注入的审批端口实现:有真端口就交它,没有就 **fail-closed 抛 `approval_unavailable`**
 *  (命令没执行 → 上层按 REJECTED 归类)。判定只有这一处,宿主不 import 本函数之外的东西。 */
export async function requestModuleActionApproval(request: ActionApprovalRequest): Promise<void> {
  if (!approvalPort) {
    throw moduleRefusalError("approval_unavailable", "action 能力执行需要审批通道,当前环境没有可用的审批通道,为安全起见未执行。");
  }
  return approvalPort(request);
}

let hostPromise: Promise<ModuleHost> | null = null;
/** Lazy: importing IPC must not touch the user's data root during smoke tests. */
export function getModuleHost(): Promise<ModuleHost> {
  if (!hostPromise) hostPromise=createHost().catch(error=>{hostPromise=null;throw error;});
  return hostPromise;
}
/** 【MC-036】工作流授权的落点 —— 与模块清单同目录的独立文件(理由见
 *  `@contracts/moduleCapability` 的 `MODULE_WORKFLOW_GRANT_FILE_VERSION` 注释)。 */
const workflowGrantPath = (dir: string): string => join(dir, "workflow-grants.json");
async function createHost(): Promise<ModuleHost> {
  const dir=join(dataRoot(),"ui-modules"),path=join(dir,"manifests.json"),grantPath=workflowGrantPath(dir);
  const host=new ModuleHost({
    authorize:async resource=>{await resolveModuleResource(resource,isKnownWorkspaceRoot);},
    // 【MC-036】工作流运行授权:读侧现读文件(不缓存 → 撤销在下一次判定立刻生效);
    // 读不动(权限等)交给宿主按 fail-closed 处理。写侧 tmp+rename 原子写,与模块清单同一套。
    readWorkflowGrants:()=>{try{return readFileSync(grantPath,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}},
    persistWorkflowGrants:async text=>{
      // 一张授权表最多几十条;上限只为防"被外部写成一个巨大文件后整份读进内存"。
      if(Buffer.byteLength(text)>256*1024)throw Error("Workflow grant store exceeds 256 KiB");
      await mkdir(dir,{recursive:true});
      const temp=join(dir,"workflow-grants-"+randomUUID()+".tmp");
      try {
        const file=await open(temp,"wx");
        try {await file.writeFile(text,"utf8");await file.sync();}finally {await file.close();}
        await rename(temp,grantPath);
      } finally {await unlink(temp).catch(()=>{});}
    },
    // 【MC-060】生产审批通道:把 `requestModuleActionApproval` 交给宿主,`action` 能力每次执行
    // 前经它拿用户批准。装配期由 `index.ts` 装上真端口(`assembleModuleApprovalPort`);未装配时
    // 该函数 fail-closed 抛 `approval_unavailable` —— 于是"有通道"(这个选项存在)与"通道真能
    // 问用户"统一由那一个端口决定,宿主不再需要一个"有没有通道"的布尔。
    requestApproval: requestModuleActionApproval,
    // 【MC-035】扩展程序的两个生产端口:
    //  - 资源解析:与 `authorize` 走**同一个** `resolveModuleResource` —— 授权判定与
    //    真实路径解析不各写一份,扩展进程的 `--allow-fs-read` 拿到的就是被判定过的那个路径;
    //  - 安装期核验:受控子进程求值工厂(零文件系统放行),引用短名缺失/工厂恶意读盘 →
    //    安装失败且不落盘。
    resolveResource: (resource) => resolveModuleResource(resource, isKnownWorkspaceRoot),
    verifyProgram: (source, capabilities, timeoutMs) =>
      verifyPermissionedProgram(source, capabilities, timeoutMs ?? 10_000),
    // 【ARC-006 Gate E】升级换执行体 / 卸载时取消运行中任务的诊断：取消数与非空失败
    // 都落日志（取消失败不静默）。诊断不改变事务结果。
    onChanged: (outcome) => {
      if (outcome.cancelledTasks > 0) {
        log.info(`[modules] ${outcome.moduleId}: 已取消 ${outcome.cancelledTasks} 个运行中任务`);
      }
      for (const failure of outcome.cancelFailures) {
        log.warn(`[modules] ${outcome.moduleId}: 取消任务 ${failure.taskId} 失败：${failure.reason}`);
      }
    },
    persist:async manifests=>{
      const body=JSON.stringify(manifests,null,2);
      if(Buffer.byteLength(body)>512*1024)throw Error("Module store exceeds 512 KiB");
      await mkdir(dir,{recursive:true});
      const temp=join(dir,"manifests-"+randomUUID()+".tmp");
      try {
        const file=await open(temp,"wx");
        try {await file.writeFile(body,"utf8");await file.sync();}finally{await file.close();}
        await rename(temp,path);
      } finally {await unlink(temp).catch(()=>{});}
    },
  });
  for(const capability of fileCapabilities(isKnownWorkspaceRoot))host.register(capability);
  host.addBuiltin({
    ...EXAMPLE_MODULE, id:"core.file-report",
    title:{zh:"内置文件检查",en:"Built-in file inspection"},
    contributions:[
      {...EXAMPLE_MODULE.contributions[0],title:{zh:"检查文件（大小 / SHA-256）",en:"Inspect file (size / SHA-256)"}},
      {
        id:"info",slot:"files.context",capability:"core.file.info",
        title:{zh:"查看文件信息",en:"View file information"},
        view:{
          title:{zh:"文件信息",en:"File information"},
          fields:[
            {key:"bytes",title:{zh:"字节数",en:"Bytes"}},
            {key:"modifiedAt",title:{zh:"修改时间",en:"Modified at"}},
          ],
        },
      },
    ],
  });
  let saved:ModuleManifest[]=[];
  try {
    if((await stat(path)).size>512*1024)throw Error("Module store exceeds 512 KiB");
    saved=z.array(ModuleManifestSchema).max(31).parse(JSON.parse(await readFile(path,"utf8")));
    // 【MC-035】持久化里出现引用 `module.*` 的清单,说明它是扩展包 —— 但恢复时**没有**
    // 用户点头这一次。信任模型不变:装过一次(安装期已核验 + 用户同意)才允许重启后复活;
    // 落盘本身只经 `install` 写,所以"出现在 manifests.json 里"就是"装过"的证据。
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  // 【MC-035】恢复期的程序核验失败不拖垮整个宿主:跳过那一条并显式记录(坏东西报出来,
  // 不静默跳过 —— 但也不能让一份损坏的清单把其余模块全挡在门外)。
  for(const manifest of saved){
    try{host.restore(manifest);}
    catch(error){console.warn(`[modules] 恢复模块 ${manifest.id} 失败:${error instanceof Error?error.message:String(error)}`);}
  }
  return host;
}
