/** F026: distinct persistent Theia lifecycle IPC; no Agent delegation or auto-start. */
import { existsSync } from "node:fs";
import { TheiaEditorApplyBroker } from "@main/modules/theiaHost/editorApplyBroker.js";
import { TheiaRuntimeMessageBroker } from "@main/modules/theiaHost/runtimeMessageBroker.js";
import { TheiaQuickInputBroker } from "@main/modules/theiaHost/quickInputBroker.js";
import { resolve, join } from "node:path";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { TheiaInstalledInputSchema } from "@contracts/ipc/modules.js";
import { theiaDesktopSender } from "./theiaPreview.js";

interface DataOptions { dataRoot: () => string; theiaRoot?: string }
let registryPromise: Promise<import("@main/modules/theiaHost/installedRegistry.js").TheiaInstalledRegistry> | null = null;
async function registry(options:DataOptions) {
  if (!registryPromise) {
    registryPromise = import("@main/modules/theiaHost/installedRegistry.js").then(({TheiaInstalledRegistry})=>{
      const choices = [options.theiaRoot, process.env.MCODE_THEIA_ROOT,
        resolve(process.cwd(),"vendor/theia"),resolve(process.cwd(),"../../vendor/theia")].filter((p):p is string=>Boolean(p));
      const root = choices.find(p => existsSync(join(p,"packages/plugin-ext/lib/hosted/node/plugin-host.js")) &&
        existsSync(join(p,"packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js")));
      if(!root) throw Error("Theia persistent extensions require a built Theia runtime; packaged distribution is not yet supported");
      const store = new TheiaInstalledRegistry(join(options.dataRoot(),"theia-extensions"),root);
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
        }
        );
        sender.send(IPC.MODULE_THEIA_CONTRIBUTION_CHANGED,{
          channel:"modules:theiaContributionChanged",sessionId:started.kind==="started"?started.sessionId:"",
        });
        return started;
      }
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
