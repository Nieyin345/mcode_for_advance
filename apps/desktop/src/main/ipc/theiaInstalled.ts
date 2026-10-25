/** F026: distinct persistent Theia lifecycle IPC; no Agent delegation or auto-start. */
import { existsSync } from "node:fs";
import { TheiaEditorApplyBroker } from "@main/modules/theiaHost/editorApplyBroker.js";
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
        void manager.disposeSender(senderId).catch(error=>console.warn("[theia-installed] cleanup failed:",error));
      });
    }
    switch(input.op){
      case "list":return {kind:"list" as const,items:manager.list(senderId)};
      case "inspect":return manager.inspect(senderId,input.path);
      case "cancel":return manager.cancel(senderId,input.ticket);
      case "install":return manager.install(senderId,input.ticket,input.accepted);
      case "start":return manager.start(senderId,input.id);
      case "execute":return manager.execute(senderId,input.sessionId,input.commandId,input.args);
      case "editorSync":return manager.editorSync(senderId,input.sessionId,input.editor,
        transaction=>editorBroker.request(senderId,input.sessionId,transaction,
          message=>sender.send(IPC.MODULE_THEIA_EDITOR_APPLY,message)));
      case "editorApplied":
        if(!editorBroker.acknowledge(senderId,input.sessionId,input.requestId,input.accepted))
          throw Error("未知、过期或其他桌面窗口的编辑事务");
        return {kind:"editorAcknowledged" as const};
      case "stop":
        editorBroker.cancelSession(senderId,input.sessionId);
        return manager.stop(senderId,input.sessionId);
      case "setEnabled":return manager.setEnabled(input.id,input.enabled);
      case "remove":return manager.remove(input.id);
    }
  });
}
