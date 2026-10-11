/**
 * **视觉中继**那条重依赖的**惰性登记口**。
 *
 * `agentTools.ts` 是纯模块(它的 import 图里已经有 `ssh2`,但那是既有的;再加
 * `SettingRepo → db → electron` 会让更多无头套件打不动)。而视觉中继要读设置、要发
 * SDK query —— 两者都够重,不能静态 import 进工具表。
 *
 * 于是这里做一个**可选的、装配期注入**的登记口:
 *   - 应用启动时(`main/index.ts`)把真实实现登进来;
 *   - 没登记 / 没配模型 → 中继能力不存在,`agent_read_image` 照旧只回图片块(不假装)。
 *
 * 刻意零依赖 —— 与 `agentEngineCwd.ts` 同一理由:调用方在无头套件里也要能引它。
 */

export interface VisionRelayImpl {
  describeImage(args: {
    imageBase64: string;
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    source?: string;
    question?: string;
  }): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }>;
  /** 用户配没配中继模型。 */
  configured(): boolean;
}

let impl: VisionRelayImpl | null = null;

/** 应用装配时调一次。传 `null` = 摘掉(测试 / 拆卸)。 */
export function setVisionRelayImpl(next: VisionRelayImpl | null): void {
  impl = next;
}

/** 当前实现(没登记 = `null`)。工具层据此决定能力在不在。 */
export function getVisionRelayImpl(): VisionRelayImpl | null {
  return impl;
}
