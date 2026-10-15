/**
 * 「设置表里那个 `id → 密文` 映射」的**唯一一份**读写。
 *
 * ## 为什么要有这个文件
 *
 * 同一段逻辑曾经在三个地方各有一份副本（`secretStore.ts` / `piModelsStore.ts` /
 * `codexModelsStore.ts`），逐行同构，**只有一处不一样**：`secretStore` 那份在
 * JSON 解析失败时 `catch { return {} }` —— **不打日志**。另两份打。
 *
 * 后果是：用户的 API Key 表损坏时，自定义模型面板显示"没有配置任何模型"，
 * 而日志里一个字节都没有。凭据上的静默失败 —— 违反仓库硬规矩 3
 * 「坏东西显式报出来，不静默跳过」，而且是最难查的那一类（没有任何线索）。
 *
 * 所以收敛成一份，并且**结构上不允许静默**：这里没有"安静地返回空"这条出口，
 * 解析失败一律 (a) 记 `log.error`、(b) 记进 {@link secretMapCorruption} 供界面显示。
 *
 * ## 为什么返回 `{}` 而不是抛
 *
 * 读侧要能降级（否则坏一个键 = 整个设置面板打不开），但**降级不等于假装没事**：
 * 调用方拿到空映射的**同时**，用户能在界面上看到"配置表损坏"。写侧
 * （{@link writeSecretMap}）不在这里做保护 —— 谁来拒绝覆盖是各个 store 自己的
 * 职责（它们的注释里写了"读不出来就拒绝保存，盘上内容一个字节不动"）。
 */

import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";

/** 设置表里 `id → base64(密文或明文)` 的映射。 */
export type SecretMap = Record<string, string>;

/**
 * 已知损坏的设置键。**只增不减**（进程生命周期内）——一次损坏就是一次数据事故，
 * 不该因为后续某次读成功了就从界面上消失。用户处理完之后重启即可清空。
 *
 * 用 Set 而不是计数器：界面要显示的是"哪些键坏了"，不是"坏了多少次"。
 */
const corrupted = new Set<string>();

/**
 * 读一份密钥映射。
 *
 * @param settingKey 设置表键名（如 `"customModelKeys"`）。
 * @param label      日志与界面上的可读名（如 `"自定义模型密钥"`）。**必填** ——
 *                   正是"某一份可以不打日志"这件事造成了这次的静默，所以这里
 *                   不给它默认值，调用方必须想一下自己的名字。
 */
export function readSecretMap(settingKey: string, label: string): SecretMap {
  const raw = readRaw(settingKey);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SecretMap;
    }
    // 合法 JSON 但不是「对象映射」——同样是损坏，同样要报。
    markCorrupted(settingKey, label, `顶层是 ${Array.isArray(parsed) ? "数组" : typeof parsed}，期望对象`);
    return {};
  } catch (err) {
    markCorrupted(settingKey, label, (err as Error).message);
    return {};
  }
}

/**
 * 写一份密钥映射。
 *
 * **不做保护。** 读不出来时要不要拒绝保存，由调用方按自己的语义决定 ——
 * 本文件只负责"这一份读写长什么样"。
 */
export function writeSecretMap(settingKey: string, map: SecretMap): void {
  SettingRepo.set(settingKey, JSON.stringify(map));
}

/**
 * 这个设置键在本次进程里是否读出过损坏内容。
 *
 * 供 RPC 层暴露给界面 —— 照 `agentRemoteSsh.ts` 的 `knownHostsStoreInvalid()`
 * 那个模式（它的返回结构里就带着 `storeInvalid: boolean`，注释写着
 * 「界面据此显示『信任表损坏』，而不是静默假装空」）。
 */
export function secretMapCorrupted(settingKey: string): boolean {
  return corrupted.has(settingKey);
}

/** 当前所有读出过损坏的键（只读快照，供总览/诊断用）。 */
export function corruptedSecretMapKeys(): string[] {
  return [...corrupted];
}

/**
 * 供**测试**清空损坏标记。
 *
 * 生产代码不该调它 —— 损坏只增不减是刻意的（见 `corrupted` 的注释）。
 * 测试要重置模块状态，只能走这个显式出口，不能摸私有 Set。
 */
export function __resetSecretMapCorruptionForTest(): void {
  corrupted.clear();
}

function markCorrupted(settingKey: string, label: string, reason: string): void {
  corrupted.add(settingKey);
  log.error(
    `${settingKey}: ${label}读取失败，已当作空表继续（盘上内容未动）：${reason}`,
  );
}

/** `SettingRepo` 的唯一入口。抽出来是为了让 esbuild 的 `--alias` 只需换一处。 */
function readRaw(settingKey: string): string | null {
  return SettingRepo.get(settingKey);
}
