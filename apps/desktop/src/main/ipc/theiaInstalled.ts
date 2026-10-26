/** F026: distinct persistent Theia lifecycle IPC; no Agent delegation or auto-start. */

import { TheiaEditorApplyBroker } from "@main/modules/theiaHost/editorApplyBroker.js";
import { TheiaRuntimeMessageBroker } from "@main/modules/theiaHost/runtimeMessageBroker.js";
import { TheiaQuickInputBroker } from "@main/modules/theiaHost/quickInputBroker.js";
import { McodeTheiaTerminalDriver } from "@main/modules/theiaHost/mcodeTerminalDriver.js";
import { currentTheiaNativePtyOps } from "@main/modules/theiaHost/nativePtyBinding.js";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { TheiaInstalledInputSchema } from "@contracts/ipc/modules.js";
import { theiaDesktopSender } from "./theiaPreview.js";
import { resolveTheiaRoot } from "@main/modules/theiaHost/theiaRoot.js";

interface DataOptions { dataRoot: () => string; theiaRoot?: string }

/** 【EXT-07】桥的端口。由 `main/index.ts` 在启动装配期注入。
 *
 *  **类型是结构定义的**（不 import 那两个模块）—— 本文件必须能被无头 smoke 打包，
 *  而实现方 `appControl/tools.js` 会拉进整片主进程图（含 `.node` 原生模块）。 */
interface ExtensionBridgePorts {
  dispatch: (method: string, input: unknown, approved: boolean, label: string, operationId?: string)
    => Promise<{ ok: boolean; result?: unknown; error?: string; needsApproval?: boolean;
      level?: "write" | "danger"; description?: string }>;
  requestApproval: (request: { method: string; level: "write" | "danger"; description: string;
    extensionId: string; input: unknown }) => Promise<boolean>;
  builtinLookup?: (id: string) => unknown;
  knownRoot?: (path: string) => boolean;
}
let extensionBridgePorts: ExtensionBridgePorts | null = null;

/** 装配入口（`main/index.ts` 调一次）。没装 = 不接桥。 */
export function configureExtensionBridge(next: ExtensionBridgePorts | null): void {
  extensionBridgePorts = next;
  // 注册表可能已经建好了（IPC 先注册、装配后到）—— 端口要在已存在的注册表上也生效。
  if (registryPromise) void registryPromise.then(store => store.setExtensionBridge(next ?? undefined)).catch(() => {});
}

let registryPromise: Promise<import("@main/modules/theiaHost/installedRegistry.js").TheiaInstalledRegistry> | null = null;
async function registry(options:DataOptions) {
  if (!registryPromise) {
    registryPromise = import("@main/modules/theiaHost/installedRegistry.js").then(({TheiaInstalledRegistry})=>{
      // 路径判定只有一处 —— `theiaHost/theiaRoot.ts`。两边各写一份候选表时，
      // 打包态（`<resources>/theia`）会被漏掉，症状是「开发能用、装完不能用」。
      const root = resolveTheiaRoot(options.theiaRoot, "Theia 持久扩展");
      const store = new TheiaInstalledRegistry(join(options.dataRoot(),"theia-extensions"),root,
        extensionBridgePorts === null ? undefined : extensionBridgePorts as never);
      import("electron").then(({app}) => app.once("before-quit",()=>{void store.disposeAll();})).catch(()=>{});
      return store;
    }).catch(error=>{registryPromise=null;throw error;});
  }
  return registryPromise;
}
export function registerTheiaInstalledHandlers(ipc:IpcMain, options:DataOptions):void {
  const watched = new Set<number>(), destroyed = new Set<number>();
  const editorBroker = new TheiaEditorApplyBroker();
  const messageBroker = new TheiaRuntimeMessageBroker();
  const quickBroker = new TheiaQuickInputBroker();
  ipc.handle(IPC.MODULE_THEIA_INSTALLED,async(event,raw:unknown)=>{
    const senderId=theiaDesktopSender(event);
    if(destroyed.has(senderId)) throw Error("旧窗口不可管理或执行已安装扩展");
    const input=TheiaInstalledInputSchema.parse(raw);
    const manager=await registry(options);
    const sender=event.sender;
    if(sender.isDestroyed?.()||destroyed.has(senderId)) throw Error("窗口已关闭");
    if(!watched.has(senderId)&&typeof sender.once==="function"){
      watched.add(senderId);
      sender.once("destroyed",()=>{
        watched.delete(senderId);
        destroyed.add(senderId);
        editorBroker.cancelSender(senderId);
        messageBroker.cancelSender(senderId);
        quickBroker.cancelSender(senderId);
        void manager.disposeSender(senderId).catch(error=>console.warn("[theia-installed] cleanup failed:",error));
      });
    }
    switch(input.op){
      case "list":return {kind:"list" as const,items:manager.list(senderId)};
      case "inspect":return manager.inspect(senderId,input.path);
      case "cancel":return manager.cancel(senderId,input.ticket);
      case "install":return manager.install(senderId,input.ticket,input.accepted);
      case "start":{
        const started=await manager.start(senderId,input.id,(sessionId,extensionId,message)=>
        messageBroker.request(senderId,sessionId,extensionId,message,
          payload=>{if(sender.isDestroyed?.()||destroyed.has(senderId))throw Error("窗口已关闭");
            sender.send(IPC.MODULE_THEIA_RUNTIME_MESSAGE,payload);}),input.workspacePath,
        (sessionId,extensionId,quick)=>quickBroker.request(senderId,sessionId,extensionId,quick,
          payload=>{if(sender.isDestroyed?.()||destroyed.has(senderId))throw Error("窗口已关闭");
            sender.send(IPC.MODULE_THEIA_QUICK_INPUT,payload);}),
        (sessionId,extensionId,item)=>{
          if(sender.isDestroyed?.()||destroyed.has(senderId))return;
          sender.send(IPC.MODULE_THEIA_STATUS_ENTRY,{
            channel:"modules:theiaStatusEntry",sessionId,extensionId,...item,
          });
        },
        (sessionId,collectionId,resource,markers,removed)=>{
          if(sender.isDestroyed?.()||destroyed.has(senderId))return;
          sender.send(IPC.MODULE_THEIA_DIAGNOSTICS,{
            channel:"modules:theiaDiagnostics",sessionId,collectionId,resource,markers,
            ...(removed?{removed:true}:{}),
          });
        },
        (sessionId,root)=>new McodeTheiaTerminalDriver(sessionId,root,currentTheiaNativePtyOps()),
        (sessionId,extensionId,event)=>{
          if(sender.isDestroyed?.()||destroyed.has(senderId))return;
          sender.send(IPC.MODULE_THEIA_WEBVIEW,{
            channel:"modules:theiaWebview",sessionId,extensionId,...event,
          });
        }
        );
        sender.send(IPC.MODULE_THEIA_CONTRIBUTION_CHANGED,{
          channel:"modules:theiaContributionChanged",sessionId:started.kind==="started"?started.sessionId:"",
        });
        return started;
      }
      case "webviewMessage":return manager.webviewMessage(senderId,input.sessionId,input.handle,input.payload);
      case "webviewDispose":return manager.webviewDispose(senderId,input.sessionId,input.handle);
      case "languageQuery":return manager.languageQuery(senderId,input.sessionId,input.query,input.lineNumber,input.column,input.includeDeclaration,input.formatOptions,input.signatureContext,input.formatContext,input.editContext);
      case "execute":return manager.execute(senderId,input.sessionId,input.commandId,input.args);
      case "editorSync":return manager.editorSync(senderId,input.sessionId,input.editor,
        transaction=>editorBroker.request(senderId,input.sessionId,transaction,
          message=>sender.send(IPC.MODULE_THEIA_EDITOR_APPLY,message)));
      case "editorApplied":
        if(!editorBroker.acknowledge(senderId,input.sessionId,input.requestId,input.accepted))
          throw Error("未知、过期或其他桌面窗口的编辑事务");
        return {kind:"editorAcknowledged" as const};
      case "messageRespond":
        if(!messageBroker.respond(senderId,input.sessionId,input.requestId,input.choice))
          throw Error("消息选项不存在、已失效或不属于当前窗口");
        return {kind:"messageAcknowledged" as const};
      case "quickRespond":
        if(!quickBroker.respond(senderId,input.sessionId,input.requestId,input.choice))
          throw Error("输入选择不存在、无效或属于其他窗口");
        return {kind:"quickAcknowledged" as const};
      case "stop":
        quickBroker.cancelSession(senderId,input.sessionId);
        messageBroker.cancelSession(senderId,input.sessionId);
        sender.send(IPC.MODULE_THEIA_STATUS_ENTRY,{
          channel:"modules:theiaStatusEntry",sessionId:input.sessionId,extensionId:"",id:"*",removed:true,
        });
        editorBroker.cancelSession(senderId,input.sessionId);
        sender.send(IPC.MODULE_THEIA_DIAGNOSTICS,{
          channel:"modules:theiaDiagnostics",sessionId:input.sessionId,
          collectionId:"*",resource:"",markers:[],removed:true,
        });
        const stopped=await manager.stop(senderId,input.sessionId);
        sender.send(IPC.MODULE_THEIA_CONTRIBUTION_CHANGED,{
          channel:"modules:theiaContributionChanged",sessionId:input.sessionId,
        });
        return stopped;
      case "configList":return manager.configList(input.id);
      case "configSet":return manager.configSet(senderId,input.id,input.key,input.value);
      case "setEnabled":return manager.setEnabled(input.id,input.enabled);
      case "remove":return manager.remove(input.id);
    }
  });
}
