/** 桩:provider 注册表 —— 只给 scenePreflight 服务需要的 `list()`。不碰磁盘。
 *  id 用 `claude-sdk`(有真实语义矩阵,providerCapabilityDescriptor 才不会 NPE)。 */
export const providerRegistry = {
  list: () => [{ id: "claude-sdk", displayName: "Claude" }],
} as never;
