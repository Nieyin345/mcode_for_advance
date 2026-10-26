/**
 * 工作流 → 扩展命令的生产端口。
 *
 * 把 `ModuleCapabilityExecutor` 的 `ExtensionCommandPort` 接到真 Theia 注册表上。
 *
 * ## 为什么延迟装配
 *
 * `executionEngine.ts` 被很多无头 smoke 打包，而 `installedRegistry.js` 会拖进
 * Theia 那一整片（fork / RPC / 协议）。所以这里只在**真的执行时**才去取注册表；
 * 导入本文件、构造引擎都不拉起 Theia 会话。
 */
export interface ExtensionCommandPortLike {
  execute(input: { extensionId: string; commandId: string; path: string; signal: AbortSignal }): Promise<unknown>;
}

/** 注册表的延迟句柄。由 `index.ts` 在启动装配期注入。 */
type RegistryProvider = () => Promise<{
  executeHeadless(input: {
    extensionId: string;
    commandId: string;
    path: string;
    workspacePath?: string;
    signal: AbortSignal;
  }): Promise<unknown>;
}>;

let provider: RegistryProvider | null = null;

/** 装配入口（`main/index.ts` 调一次）。没装 = 端口不可用，节点报「扩展运行时不可用」。 */
export function configureExtensionCommandPort(next: RegistryProvider | null): void {
  provider = next;
}

export const extensionCommandPort: ExtensionCommandPortLike = {
  async execute({ extensionId, commandId, path, signal }) {
    if (!provider) {
      throw Error("扩展运行时还没有装配：这个版本的工作流无法调用 VS Code 扩展命令（重启应用或查看装配日志）");
    }
    const registry = await provider();
    return registry.executeHeadless({ extensionId, commandId, path, signal });
  },
};
