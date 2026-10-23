/**
 * 【T52】「这个设置键能不能被通用设置写入」的**唯一判据**。
 *
 * ## 为什么单独一个模块
 *
 * 判定本身只依赖 `@main/lib/secretKeys`（纯模块），但它的两个消费方处境不同：
 * `appControl/tools.ts` 会拖进整个主进程依赖树（Electron、vendor、原生插件）；
 * 而审批卡摘要那条路只需要这一个判断。放一起会让「只想验判定逻辑」的套件
 * 被迫打包整个主进程 —— 那也是这个文件被拆出来的直接原因。
 *
 * ## 它管什么、不管什么
 *
 * - **管**：凭据本体（`isSecretSettingKey` 那三层：显式名单 / 通用词 / 结构形状）。
 * - **不管**：工作流执行授权（`workflow.review.v1.*` / `workflow.pinnedDefaults`）——
 *   那一族由 `@contracts/ipc` 的 `isWorkflowExecutionTrustSettingKey` 在
 *   `ipc/claude.ts` 的 `setting:set` 里拦，两族互补、各一份判据。
 *
 * ## 为什么写也要拦（2026-10-23 实测补上）
 *
 * 从前只有**读**侧拦。实测：`setting.set` 拿着 `{key:"engine.claude.apiKey"}` 一路放行
 * —— 读不到，但**能覆盖**。而覆盖对凭据来说比读取更危险：读到要把它带走才造成损失，
 * 覆盖一次就能把用户正在用的引擎换成任意地址、把已配对设备清空。
 *
 * ## 为什么可以放心拦
 *
 * 正常写口**不走这条通道**：设置面板改密钥走 `customModel.save` / `codexModels.save` /
 * `piModels.save` 等专用方法（各自管加密与校验）。移动端 HTTP 桥的
 * `touchesBlockedSetting` 早就是这个取向（对密钥键读写都不给）—— 这里是把桌面侧的
 * agent 通道对齐到同一取向。
 */
import { isSecretSettingKey } from "@main/lib/secretKeys.js";

/** 哪些方法会「读/写一条设置」。只有它们需要查 {@link settingKeyRefusal}。 */
const SETTING_READ_METHODS = new Set(["setting.get", "setting.getMany"]);
const SETTING_WRITE_METHODS = new Set(["setting.set", "setting.setMany"]);

/**
 * 这次调用有没有踩到密钥本体键。踩到就返回给模型看的拒绝理由，否则 `null`。
 *
 * 理由文案按**读 / 写**分开 —— 两种拒绝后该怎么做不同：读被拒是"要改密钥请让用户
 * 在设置里改"，写被拒是"这次改写没生效，别重试，让用户自己改"。
 */
export function settingKeyRefusal(method: string, input: unknown): string | null {
  const isRead = SETTING_READ_METHODS.has(method);
  const isWrite = SETTING_WRITE_METHODS.has(method);
  if (!isRead && !isWrite) return null;
  const o = (input ?? {}) as { key?: unknown; keys?: unknown };
  const keys: unknown[] = Array.isArray(o.keys) ? [...o.keys] : [o.key];
  const hit = keys.find((k) => isSecretSettingKey(k));
  if (hit === undefined) return null;
  return isWrite
    ? `设置键「${String(hit)}」是密钥本体,不能经通用设置写入(与 customModel.save / piModels.save 同一条规矩)。要让用户改密钥,请他在 设置 里操作。`
    : `设置键「${String(hit)}」是密钥本体,不读给模型(与 customModel.getToken / piModels.getApiKey 同一条规矩)。要改密钥请让用户在 设置 里操作。`;
}
