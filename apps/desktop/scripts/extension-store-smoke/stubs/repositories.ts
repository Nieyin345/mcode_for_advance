/**
 * `@main/store/repositories.js` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么需要它
 *
 * 【MC-095】`main/ipc/extensions.ts` 从 `main/memory/agentScope.js` 引
 * `extensionAccessRefusal`(可信扩展身份闸),而那个模块**同时**装着记忆作用域 ——
 * 它在文件顶部 import 了 `SessionRepo`(记忆作用域延迟到执行点解析用)。于是打扩展这套
 * 无头 smoke 时,`repositories → db → electron` 整条链被顺带收进 bundle,而 db 那层
 * import 真 `electron`(`app.getPath`)、还缠着 sql.js。
 *
 * 换掉 `repositories` 比顺着 alias 一个个堵 electron 更窄也更准(与 `memory-smoke` 的
 * 同一份形状)。本套只跑**扩展身份闸**,不读任何会话 —— `SessionRepo` 给一个**空桩**:
 * 有代码真去查会话时返回 `undefined`(agentScope 的 `currentAgentMemoryProjectId` 会因此
 * 抛「没有可用的宿主会话项目身份」—— 那是**记忆**那条路才走的,本套不碰)。
 *
 * ⚠️ **不是空实现里唯一要紧的那个**:`extensionAccessRefusal` 完全不碰 SessionRepo
 * (它只读扩展作用域),所以本套的判据不受这个桩影响。
 */
export const SessionRepo = {
  get(_id: string): undefined {
    return undefined;
  },
};
