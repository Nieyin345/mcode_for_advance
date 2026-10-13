/**
 * **用户签发主机 hook 授权** —— IPC 契约(设置 → 插件 → 钩子授权 / MC-061)。
 *
 * ## 这一层补的洞(MC-061)
 *
 * `main/hooks/hostHookGrants.ts` 的 `issueHostHookGrant` 早就有定义,授权判定也早就
 * **驱动执行**(未被授权的插件 hook 默认不跑,见 `HookRunner.onEvent`),但**没有任何
 * 宿主入口能签发它** —— 普通用户在界面上根本没法给自己装的插件里某条 hook 授信,于是
 * 「默认拒绝」事实上变成了「永远拒绝」。这三条 RPC 就是那扇门:
 *
 *   - `hooks.listHostHookGrants`   —— 列出当前全部主机 hook 授权(只读);
 *   - `hooks.issueHostHookGrant`   —— **用户真实操作**后,由主进程签发一份授权(落盘);
 *   - `hooks.revokeHostHookGrant`  —— 撤销一份授权(该来源回到「默认拒绝」)。
 *
 * ## 为什么这一条**不能**开给 agent(issue / revoke 钉在 `blocked`)
 *
 * 授权本身就是「用户点头」这件事的落点 —— 与 `workflow.approve`(同为"用户本人的执行
 * 授权签发")同一条纪律。所以 `appControl/policy.ts` 把 `hooks.issueHostHookGrant` /
 * `hooks.revokeHostHookGrant` 钉死在 **blocked** 档:agent 经 `app_api_call` **根本够不
 * 到**(直接拒,不是"每次弹卡"),自定义面板的 `mcode.api.call` 同理。真正够得到这两条
 * 的只有桌面渲染端(`window.api.hooks.*`)—— 设置页那颗按钮 = 用户动作。
 *
 * 这一条比"danger 档每次弹卡"更严:插件 hook 的授权**没有**"agent 试着调用、用户顺带
 * 在卡上批准"这种流程,agent 任何理由都**不该**签出它,故直接封路而不是留一道审批口。
 *
 * ## schema 是 `.strict()` 的:调用方只能给"授什么信"的坐标
 *
 * `grantId` / `issuedAt` / `expiresAt` / `revoked` **都由主进程签发**,调用方给不了 ——
 * 多给一个字段(比如 `revoked:true`)直接被 schema 拒,于是「自签一份已生效/永不过期的
 * 授权」从**契约层**就断了。有效期(`ttlMs`)也由宿主定(见 `main/ipc/hooks.ts` 的常量),
 * 调用方同样给不了。
 *
 * ## 为什么调用方给的是命令**原文**(`command` / `matcher`),不是摘要
 *
 * 授权按 `commandDigest` 绑定(命令改了旧授权就失效)。摘要算的是 sha256 —— 那是
 * `node:crypto` 的事,渲染端算不了;而**设置页那颗"授权这条"按钮**只知道这条 hook 的
 * 命令原文(它正是界面上显示的那一行)。所以调用方递**原文**,宿主 `main/ipc/hooks.ts`
 * 用**唯一一份** `hostHookCommandDigest` 算摘要 —— 与面板(`toPluginState`)、执行通道
 * (`HookRunner`)是同一份摘要。若让渲染端自己算,两处一旦漂移就是最坏的那种坏:
 * 面板标「已授信」而执行时判 denied(或反之)。`commandDigest` / `matcherDigest` 两个
 * 摘要字段仍保留(旧调用方 / 测试直接给摘要),与 `command` / `matcher` 二选一。
 *
 * `.strict()` 的取舍不变:`command` / `matcher` 是调用方**本来就看得见**的坐标
 * (命令就在插件的 hooks 文件里,界面上也印着),不是宿主事实 —— 多给它们不构成"自签"。
 */
import { z } from "zod";

/** 无参列表(保持 schema 一致,避免"空 object schema"那类坑)。 */
export const HostHookGrantListSchema = z.object({});
export type HostHookGrantListInput = z.infer<typeof HostHookGrantListSchema>;

/** 一条授权能覆盖的原生事件名(如 `PreToolUse`;空数组 = 不限定事件)。 */
const HostHookGrantEvents = z.array(z.string().min(1).max(120)).max(64);

/**
 * 签发一份主机 hook 授权。
 *
 * ⚠️ `.strict()` 承重,不是洁癖:`grantId` / `issuedAt` / `expiresAt` / `revoked` **由主
 * 进程签发**,调用方只能给"授什么信"的坐标(插件名 + 可选版本 / 事件 / 命令摘要 / matcher
 * 摘要)。给多一个宿主字段会被 schema 直接拒 —— "自签自己"这条路从**契约层**就断了。
 */
export const HostHookGrantIssueSchema = z
  .object({
    /** 贡献这条 hook 的插件名(manifest name)。 */
    pluginId: z.string().min(1).max(200),
    /** 插件版本;省略 = 授权不限版本(升级后旧授权仍覆盖,较宽)。 */
    version: z.string().max(120).optional(),
    /** 该授权覆盖的原生事件名集合;省略/空 = 不限定事件。 */
    events: HostHookGrantEvents.optional(),
    /** 命令内容摘要;省略/空 = 不绑定命令(按插件 + 事件放行,较宽)。 */
    commandDigest: z.string().max(200).optional(),
    /** matcher 摘要;省略/空 = 不绑定 matcher。 */
    matcherDigest: z.string().max(200).optional(),
    /** 命令**原文** —— 设置页那颗"授权这条"按钮把界面上印的那行命令递上来,
     *  宿主用**唯一一份**摘要函数算 `commandDigest`(渲染端算不了 sha256,也不该另写一份)。
     *  与 `commandDigest` 二选一:`command` 优先。 */
    command: z.string().min(1).max(2000).optional(),
    /** matcher **原文**(同上,宿主算摘要);省略 = 不绑定 matcher。 */
    matcher: z.string().max(200).optional(),
  })
  .strict();
export type HostHookGrantIssueInput = z.infer<typeof HostHookGrantIssueSchema>;

/** 撤销一份授权(按 `grantId`)。 */
export const HostHookGrantRevokeSchema = z
  .object({ grantId: z.string().min(1).max(200) })
  .strict();
export type HostHookGrantRevokeInput = z.infer<typeof HostHookGrantRevokeSchema>;
