/**
 * 【F023】扩展安装时的**能力报告** —— 用户裁决「装时说清楚，之后不打断」的那一半。
 *
 * ## 为什么这里是「下限」，不是「清单」
 *
 * VS Code 的扩展清单里**没有权限声明字段**。经源码核对（`vendor/theia` 锁定
 * `d8106d7f` / `v1.76.0`）：
 *
 * ```
 * grep -c "capabilities" packages/plugin-ext/src/common/plugin-protocol.ts   → 0（无权限语义）
 * grep    "permissions"  packages/plugin-ext/src/common/plugin-protocol.ts   → 无
 * ```
 *
 * 清单里唯一沾边的是 `capabilities.untrustedWorkspaces` / `virtualWorkspaces`，
 * 那是**扩展对工作区信任的自我声明**，不是「它申请了哪些系统能力」。
 *
 * 所以「这个扩展能碰什么」只能**从它的实际代码静态推断**。而静态推断有两个
 * 天生的漏洞，必须写进契约而不是藏在实现里：
 *
 * 1. **混淆或动态拼接的 require 看不见**（`require("child_" + "process")`、
 *    `eval`、`new Function`、打包器的运行时映射）；
 * 2. **代码路径看不见** —— 「它 require 了 fs」不等于「它每次都会读文件」。
 *
 * 因此 `confidence` 恒为 `"static-lower-bound"`：报告说的是
 * **「至少需要这些」**，不是「只会这些」。凡是要给用户看的措辞，都必须
 * 按这个方向写，否则一个漏扫就变成了「我告诉过你它只能读文件」的假保证。
 *
 * ## `evidence` 为什么要强制
 *
 * 一条「能启动子进程」而没有出处的提示，用户无法判断（哪个文件？真的是它？）
 * 也无法审计（三个月后这个结论还成立吗？）。所以每条 `true` 都必须带
 * `文件:行号`；扫描器**不允许**产出没有出处的判断 —— 类型上
 * `evidence` 是必填数组，语义上见 `theiaPermissionReport.ts` 的
 * `evidenceFor(capability)`：没有出处的能力一律不报 `true`。
 */
import { z } from "zod";

/**
 * 能力名。刻意只有四个 —— **每多一个都必须能回答「用户拿它做什么决定」**。
 * 名字是 API 的一部分：渲染端、审计日志、测试夹具都按这几个字符串对齐。
 */
export const EXTENSION_CAPABILITY_NAMES = [
  "readsFiles",
  "spawnsProcesses",
  "network",
  "writesFiles",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITY_NAMES)[number];

/**
 * 一个扩展的能力下限报告。
 *
 * 四个布尔是**并列的**：`readsFiles: true` 不蕴含 `writesFiles: true` ——
 * 静态扫描能区分 `fs.readFileSync` 与 `fs.writeFileSync`，就不该把两者合并，
 * 否则「只读的扩展」和「能改你文件的扩展」在用户眼里会变成同一句话。
 */
export const ExtensionPermissionReportSchema = z.object({
  /** 扩展的版本化 id（`publisher.name@version`），与清单一致。 */
  extensionId: z.string().min(1),
  /** 静态看到 fs / `workspace.fs` 读取调用。 */
  readsFiles: z.boolean(),
  /** 静态看到 fs 写入调用（含 `workspace.fs.writeFile`）。 */
  writesFiles: z.boolean(),
  /** 静态看到 `child_process` / `node-pty` / `spawn` 一类。 */
  spawnsProcesses: z.boolean(),
  /** 静态看到 `net` / `http(s)` / `fetch` / 原生 `WebSocket`。 */
  network: z.boolean(),
  /**
   * 每条判断的出处，形如 `out/src/main.js:12`。
   *
   * 格式被 schema 钉死为**仓库相对 + 冒号 + 十进制行号**（相对扩展根目录）。
   * 这不是装饰：一条 `"main.js"` 或 `"某处"` 的出处，等于没有出处。
   */
  evidence: z.array(z.string().regex(/^[^\s:][^:]*:\d+$/u)).max(200),
  /**
   * 恒为 `"static-lower-bound"`。写成字面量而不是枚举，是为了让
   * 「以后加一档 `runtime-verified`」必须先改契约 —— 那是产品决定，
   * 不该由一个实现悄悄打开。
   */
  confidence: z.literal("static-lower-bound"),
  /**
   * 扫描器的**已知盲区**，逐条人话。它与 `confidence` 一起出现是有意的：
   * 消费者只读布尔时不会看到边界，但把报告原样渲染时边界就在旁边。
   */
  limits: z.array(z.string().min(1)).max(20),
});
export type ExtensionPermissionReport = z.infer<typeof ExtensionPermissionReportSchema>;
