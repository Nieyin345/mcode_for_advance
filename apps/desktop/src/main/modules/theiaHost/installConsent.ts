/**
 * 【F023】安装时的能力告知 —— 用户裁决「装时说清楚，之后不打断」的**决策那一半**。
 *
 * ## 它是什么，不是什么
 *
 * - 它是**知情同意**：装之前把「这个扩展至少能碰什么」摆给用户，用户点了才装。
 * - 它**不是保护**：装完之后**不再打断**，也**不做运行时隔离**。一个扩展真去起
 *   子进程、真去写文件，本宿主不会拦。这条必须同时出现在 UI 文案和套件输出里
 *   （`NOT-COVERED: 运行时沙箱 …`），否则「装时说清楚」会被读成「有保护」。
 *
 * ## 为什么决策放在纯函数里
 *
 * 这一层不 import electron、不弹窗、不写盘 —— 于是「拒绝 / 同意 / 没有报告」
 * 三条分支都能在无头套件里断言。UI 只是把 `InstallConsentPrompt` 渲染出来。
 *
 * ## fail-closed 的方向
 *
 * **没有报告 → 不允许安装**（`needs-report`），不是「没报告就当没问题」。
 * 报告本身是静态下限，但**连下限都拿不到**说明扫描器没跑完 —— 那种时候让用户
 * 点「同意」等于让他同意一份空白。
 */

import type { ExtensionPermissionReport } from "@contracts/extensionPermissionReport.js";

/**
 * UI 要展示的一条能力。`label` 是**用户能判断的那句话**（不是字段名），
 * `evidence` 原样来自报告，让用户和审计都能追到 `文件:行号`。
 */
export interface CapabilityLine {
  capability: "readsFiles" | "writesFiles" | "spawnsProcesses" | "network";
  label: string;
  evidence: string[];
}

export interface InstallConsentPrompt {
  extensionId: string;
  /** 标题句 —— 明确说这是**下限**，不是完整清单。 */
  headline: string;
  /** 只包含报告为 `true` 的能力，按危险度排序（起进程 > 写文件 > 网络 > 读文件）。 */
  capabilities: CapabilityLine[];
  /** 报告的已知盲区，原样展示。 */
  limits: string[];
  /** 一句必须和提示一起出现的话 —— 它不是保护。 */
  disclosure: string;
}

/** 危险度排序：越靠前越该先看到。 */
const ORDER: CapabilityLine["capability"][] = ["spawnsProcesses", "writesFiles", "network", "readsFiles"];

const LABELS: Record<CapabilityLine["capability"], string> = {
  spawnsProcesses: "启动子进程（可以运行本机上的其它程序）",
  writesFiles: "写入文件（可以修改或删除你的文件）",
  network: "访问网络（可以把数据发到外部）",
  readsFiles: "读取文件（可以看到你的文件内容）",
};

/** 必须与提示同屏的那句话。措辞是产品决定，不是实现细节。 */
export const INSTALL_DISCLOSURE =
  "这是安装时的静态扫描结果，是下限而不是完整清单（混淆或动态加载的代码看不见）。" +
  "安装后不会再询问，也不会在运行时拦截——这是知情同意，不是沙箱。";

/**
 * 组装提示。**`evidence` 只保留与 `true` 能力相关的行** ——
 * 把无关行也塞进来会让用户在一堆路径里找不到「它到底为什么说能起进程」。
 */
export function buildInstallConsentPrompt(report: ExtensionPermissionReport): InstallConsentPrompt {
  const capabilities: CapabilityLine[] = [];
  for (const capability of ORDER) {
    if (!report[capability]) continue;
    capabilities.push({ capability, label: LABELS[capability], evidence: [] });
  }
  // evidence 是全局去重过的 `文件:行号` 列表；报告没有能力→出处的一一映射，
  // 所以这里把全部出处挂到**第一条**能力上，其余留空 —— 明确不假装精确。
  if (capabilities.length > 0 && report.evidence.length > 0) {
    capabilities[0].evidence = [...report.evidence];
  }
  return {
    extensionId: report.extensionId,
    headline:
      capabilities.length === 0
        ? `这个扩展在静态扫描里没有显示出任何系统能力（同样是下限：看不见的代码仍可能有）。`
        : `这个扩展至少需要以下 ${capabilities.length} 项能力：`,
    capabilities,
    limits: [...report.limits],
    disclosure: INSTALL_DISCLOSURE,
  };
}

export type InstallDecision = "install" | "decline" | "needs-report";

/**
 * 用户点了之后发生什么。
 *
 * - `prompt` 为 `undefined`（报告没生成）→ `needs-report`，**不装**；
 * - `userAccepted === false` → `decline`；
 * - 其余 → `install`。
 *
 * **没有「静默安装」这条分支**：一个不经过提示的安装路径不该存在，
 * 所以这里没有 `default: install` 的方便写法。
 */
export function decideInstall(
  prompt: InstallConsentPrompt | undefined,
  userAccepted: boolean,
): InstallDecision {
  if (!prompt) return "needs-report";
  return userAccepted ? "install" : "decline";
}
