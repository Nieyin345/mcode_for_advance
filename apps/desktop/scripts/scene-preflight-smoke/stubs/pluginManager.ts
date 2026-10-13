/** 桩:已启用插件 —— 一份研究插件,不碰磁盘。 */
export async function getEnabledPlugins(): Promise<never> {
  return [
    {
      name: "research-pack",
      manifest: {
        name: "research-pack",
        version: "1.2.0",
        capabilities: [{ kind: "plugin", id: "research-pack" }],
      },
      compatibleProviderIds: ["claude-sdk"],
      componentReports: [],
    },
  ] as never;
}
