/**
 * 插件 hook 授权面板的**视图模型** —— 全是纯函数,不 import React、不碰 `api`、不读 i18n
 * (`hooksView.ts` / `workflowView.ts` 同一条)。
 *
 * ## 为什么单拎出来
 *
 * 「用户给某条插件 hook 授权」这个动作的**输入**是这份逻辑唯一的、也是最容易错的地方:
 *   - 少绑了 `command` → 签发的是"按插件 + 事件放行"的**宽授权**,把该插件**任意命令**
 *     的钩子都放行了(授权粒度悄悄变宽,而界面上看不出来);
 *   - 少绑了 `matcher` → 同命令同事件、**不同 matcher** 的钩子共享授权(放宽 matcher =
 *     扩大了它管得着的范围);
 *   - 带上了 `grantId` / `expiresAt` 这类**宿主字段** → schema `.strict()` 直接拒(签不
 *     出去),或(若 schema 松)等于让用户自签一份永不过期的授权。
 * 这些都是"看着点了一下、其实授错了信",埋在组件里只能靠手点排查。拎成纯函数后
 * `renderer-pure-smoke` 能逐条钉住。
 *
 * ## 摘要不在渲染端算
 *
 * 授权按**命令摘要**(sha256)绑定,而渲染端算不了 sha256。所以这里递的是命令/matcher 的
 * **原文**,宿主 `main/ipc/hooks.ts` 用**唯一一份** `hostHookCommandDigest` 算摘要 —— 与
 * 面板(`toPluginState`)、执行通道(`HookRunner`)同一份来源身份。渲染端另算一份 = 两处一
 * 漂移就"面板标已授信、执行时 denied"。
 */
import type { HostHookGrant } from "@contracts/hostHookGrant";
import { isHostHookGrantActive } from "@contracts/hostHookGrant";
import type { HostHookGrantIssueInput, PluginHookSummary, PluginState } from "@contracts/ipc";

/** 一条 hook 的授权动作**输入** —— 只给"授什么信"的坐标,不给任何宿主字段。
 *
 *  - `events` 恰好是这条 hook 的事件(收窄到这条,不是整插件);
 *  - `command` 是命令**原文**(授权绑命令:命令改了旧授权失效);
 *  - `matcher` 只在**声明了**的时候带上(空 matcher = 不绑定);
 *  - `version` 带上 —— 插件升级(版本变)= 新来源,旧授权不自动覆盖。
 *
 * ⚠️ 这里**不含** `commandDigest` / `matcherDigest`(交给宿主算),**更不含** `grantId` /
 * `issuedAt` / `expiresAt` / `revoked`(宿主签发,`schema.strict()` 拒绝)。 */
export function hookGrantIssueInput(
  plugin: Pick<PluginState, "name" | "version">,
  hook: Pick<PluginHookSummary, "event" | "command" | "matcher">,
): HostHookGrantIssueInput {
  return {
    pluginId: plugin.name,
    version: plugin.version,
    events: [hook.event],
    command: hook.command,
    ...(hook.matcher !== undefined && hook.matcher !== "" ? { matcher: hook.matcher } : {}),
  };
}

/**
 * 这条 hook **能不能授权**。不能的两类:
 *   - `unmappable`:事件名映射不到 Mcode 的统一事件,即使签了授权也不会投递
 *     (`decideHostHookExecution` 会返回 unmappable)—— 给一个签了也不生效的按钮是骗人;
 *   - `granted`:已经授过信了(按钮换成"撤销",而不是再签一份)。
 * 只有 `unsupported`(映射得到、但还没授权)能签。
 */
export function canAuthorizeHook(hook: Pick<PluginHookSummary, "execution">): boolean {
  return hook.execution !== "granted" && hook.execution !== "unmappable";
}

/** 这个插件**当前的、有效的**授权(已撤销 / 已过期的不算)。面板据此把"活跃授权"与
 *  "历史授权"分开列 —— 前者可撤,后者只作记录。 */
export function activePluginGrants(
  grants: readonly HostHookGrant[],
  pluginId: string,
  now: number,
): HostHookGrant[] {
  return grants.filter((g) => g.pluginId === pluginId && isHostHookGrantActive(g, now));
}

/** 这个插件的**全部**授权(含已撤销 / 已过期) —— 面板要把"撤过的"也显示出来,否则用户
 *  撤完发现那一行凭空消失、以为点错了。按签发时刻倒序(最近的在最上)。 */
export function pluginGrants(
  grants: readonly HostHookGrant[],
  pluginId: string,
): HostHookGrant[] {
  return grants
    .filter((g) => g.pluginId === pluginId)
    .sort((a, b) => b.issuedAt - a.issuedAt || (a.grantId < b.grantId ? 1 : -1));
}
