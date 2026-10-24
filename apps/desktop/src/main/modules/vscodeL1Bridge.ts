/**
 * ARC-006 VS Code L1 experiment (NOT a general VS Code extension host).
 * Accepts a local, two-file VSIX (ZIP STORE or DEFLATE). All untrusted JS is
 * delegated to ModuleHost's existing permissioned child process.
 * No renderer, filesystem installer, module loader or marketplace is added.
 */
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { type ModuleResource, type ModuleReply } from "@contracts/modules";
import { ModuleHost, type ModuleInstallDecision } from "./ModuleHost.js";

const COMMAND_ID = /^[a-zA-Z][a-zA-Z0-9.-]{2,99}$/;
/**
 * 【F011】`contributes` 里的贡献点分三类处理。
 *
 * ## 为什么不能一刀切放开（F009 提的前提）
 *
 * 放开却不实现，用户会**以为它能用**然后发现不行 —— 那比装不上更坏。
 * 但一刀切拒绝也不行：`rainbow-csv` 有 9 个贡献点、只有 `commands` 被支持，
 * 于是它一个都装不进。
 *
 * ## 三类的分法依据是「用户会不会当场发现」
 *
 * | 类 | 例 | 处理 | 用户会发现吗 |
 * |---|---|---|---|
 * | **A 声明式** | `configuration` `languages` `grammars` `colors` `jsonValidation` `semanticTokenScopes` `configurationDefaults` | **接受 + 标记「已记录，本宿主不读」** | **不会** ← 最危险 |
 * | **B 需运行时** | `menus` `submenus` `views` `keybindings` | **接受 + 标记「已记录，本宿主不做」** | 会（菜单项不出现） |
 * | **C 未知** | 其余 | **拒绝并点名** | 会（装不上） |
 *
 * ## ⚠️ A 类算不算欺骗 —— 结论是「算，而且更危险」
 *
 * `configuration` 接受了，但用户改了设置项**不会生效**，而**没有任何东西提示他**。
 * `menus` 至少会「菜单项不出现」—— 那是**当场可见**的失败。
 *
 * **所以 A 类不能因为「它不报错」就被当成无害**：它**恰恰因为不报错而更难发现**。
 * 处理方式因此是「接受 + **必须标记**」，标记与 B 类同样强制 ——
 * 差别只在措辞（「不读」vs「不做」），不在是否有标记。
 *
 * `languages` / `grammars` 更微妙：它们不需要我们的**运行时**，但需要**编辑器**去消费。
 * 当前编辑器不读它们 —— 所以归 A 类（接受 + 标记），**不能**归「支持」。
 *
 * ## C 类仍拒绝
 *
 * 不认识的东西静默接受，等于给一个我们完全不了解的行为开门。
 * 拒绝时**点名是哪个**，让用户知道是扩展声明了本宿主不认识的东西。
 */
const CONTRIBUTION_CLASSES = {
  /** 已支持（运行时真的会消费）。 */
  supported: ["commands"],
  /** A 类：声明式，接受但不消费。**用户不会察觉** —— 所以标记是强制的。 */
  declarative: [
    "configuration", "configurationDefaults", "languages", "grammars",
    "colors", "jsonValidation", "semanticTokenScopes",
  ],
  /** B 类：需运行时，接受但不实现。用户会发现（菜单项不出现）。 */
  runtime: ["menus", "submenus", "views", "keybindings"],
} as const;

/** 一个被本宿主接受、但**不会真正生效**的贡献点。 */
export interface IgnoredContribution {
  /** 贡献点名，如 `configuration`。 */
  section: string;
  /** `declarative` = 已记录但不读；`runtime` = 已记录但不做。 */
  kind: "declarative" | "runtime";
}

/** 判断某个贡献点属于哪一类。`null` = 不认识（C 类，拒绝）。 */
function classifyContribution(section: string): IgnoredContribution["kind"] | "supported" | null {
  const s = section as string;
  if ((CONTRIBUTION_CLASSES.supported as readonly string[]).includes(s)) return "supported";
  if ((CONTRIBUTION_CLASSES.declarative as readonly string[]).includes(s)) return "declarative";
  if ((CONTRIBUTION_CLASSES.runtime as readonly string[]).includes(s)) return "runtime";
  return null;
}

/** 【F004】`contributes.commands` 的上限。
 *
 * **原实现是 `z.tuple([...])`，即恰好 1 条，和 4096 / 24576 出自同一个提交 `68a7121c`，
 * 同样没有依据。** 实测最大真实值是 `rainbow-csv` 的 **24 条**；64 给它约 2.7 倍余量。
 *
 * 必须有上限：一个声称 100 万条命令的清单会在解析时撑爆内存，
 * 而 `z.array` 不设上限就是无界攻击面。 */
const MAX_COMMANDS = 64;

/** 【F004】`activationEvents` 的上限。真实扩展（rainbow-csv）是 11 条；给 64 留余量。
 *
 * ⚠️ **放开这个数组 ≠ 支持这些事件。** 运行时目前只认 `onCommand:<第一条命令>`，
 * 其余的（`onLanguage:csv`、`workspaceContains:**\/*.csv`…）声明了也不会被激活。
 * 见 `activate()` 里那段校验。
 *
 * **清单能过只是第一步**，运行时的激活要单独做。别把「schema 接受」读成「功能支持」。 */
const MAX_ACTIVATION_EVENTS = 64;

const packageSchema = z.object({
  // 【F009】`publisher` 放宽大小写。VS Code 官方要求小写，但**现实中存在大写**
  // （本机 29 个扩展里 4 个，如 `James-Yu.latex-workshop`）。
  //
  // **选方案 A（放宽）而不是 B（严格 + 可行动错误）**：
  // 用户装的是**别人写的现成扩展**，他改不了那个 manifest —— B 那句
  // 「请改为 james-yu」对他没有可操作性，他能做的只有放弃。
  // 归一化发生在 `moduleId` 构造处，不在这里拒绝。
  publisher: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,30}$/),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().min(1).max(120).optional(),
  // 【F009】`main` 从**字面量** `"./extension.js"` 改成路径。
  //
  // 原规则让 **29 个真实扩展里 0 个**能过（实测：27 个声明了 main，
  // 恰好等于 `./extension.js` 的 **0 个**）。真实形态：
  // `./main.js`(7)、`./dist/extension.js`(4)、`./dist/node/extension.js`(3)、
  // `./out/extension`(2)、`./out/src/main.js`、`./extension`、`main`…
  //
  // 规则：相对扩展根的路径，可任意层级，**无 `.js` 后缀时补 `.js`**，
  // 但**禁止 `..` 逃逸** —— 那是安全边界，不是格式偏好。
  main: z.string().min(1).max(200)
    .regex(/^\.\/(?!.*\.\.)[A-Za-z0-9._\-\/]+$/, {
      message: "main must be a relative path under the extension root (no '..' segments)",
    }),
  // 【F004】保留 .strict()：多出来的引擎声明我们不支持，静默忽略更糟 ——
  // 用户会以为「它声明了 vscode 1.95 就能按 1.95 的行为跑」。
  engines: z.object({ vscode: z.string().min(1).max(40) }).strict(),
  activationEvents: z.array(z.string()).min(1).max(MAX_ACTIVATION_EVENTS).optional(),
  contributes: z.object({
    // 【F004】`z.tuple` → `z.array`，并设上限。另加非空：0 条命令的扩展没有意义，
    // 而且下游 `contributes.commands[0]` 会在空数组上取到 undefined。
    commands: z.array(z.object({
      command: z.string().regex(COMMAND_ID),
      title: z.string().min(1).max(120),
      // 【F004】`category` 是真实扩展**普遍带的**字段（rainbow-csv 的 24 条里 22 条有，
      // 2 条没有）。它只是**显示前缀** —— VS Code 把它渲染成「Rainbow CSV: CSV Lint」。
      //
      // 接受它的理由：它不新增任何能力，只是 title 的前缀；而拒绝它等于 24 条命令里
      // 22 条装不进，这个扩展的清单根本过不了。这正是本卡要解决的。
      //
      // 其余字段（`icon` / `enablement` / `shortTitle`）**仍然拒绝** —— 那些不是纯显示，
      // 接受但不实现会给用户「图标会显示 / 条件会生效」的错觉。
      category: z.string().min(1).max(60).optional(),
    }).strict()).min(1).max(MAX_COMMANDS)
      // 【F008】同一份清单里命令 id 不能重复。
      // 前缀放宽之后（接受 `<name>.<cmd>`）这个风险变高了：两份清单可以用同一个
      // name 段，重复 id 会让「哪条命令被调用」变得不确定。
      // VS Code 自己也要求命令 id 全局唯一，这里先在清单内守住。
      .refine(
        (list) => new Set(list.map((c) => c.command)).size === list.length,
        { message: "VSIX declares duplicate command ids" },
      ),
  })
    // 【F004】`contributes` 的处理不是 `.strict()`，是 **`.passthrough()` + 自己点名**。
    //
    // ⚠️ 这里踩过一个坑，记下来免得下一个人再踩：
    // 我第一版写成 `.superRefine(...)` 替换掉 `.strict()`。**`.superRefine` 返回
    // `ZodEffects`，加不上 `.strict()`** —— 于是未知键检查**整个消失**了，
    // `keybindings` 被静默接受。`vscode-l1-smoke` 里那条「不支持的贡献点必须被拒」
    // 当场变红，才发现的。
    //
    // `.passthrough()` 让未知键**保留在解析结果里**（`.strict()` 会先剥掉它们，
    // 那时 `superRefine` 看不到），再由这里逐一点名。
    // 这样错误信息能同时说清「是哪个」和「本宿主支持什么」——
    // zod 原生的 `Unrecognized key(s) in object: 'keybindings'` 只说前者。
    .passthrough()
    .superRefine((value, ctx) => {
      // 【F011】只有 **C 类（不认识）** 才拒。A/B 类接受，但在 `install()` 里被记进
      // `ignoredContributions` 并随安装结果返回 —— 那是「用户能知道哪些不工作」的载体。
      const unknown = Object.keys(value).filter((k) => classifyContribution(k) === null);
      if (unknown.length > 0) {
        const known = [
          ...CONTRIBUTION_CLASSES.supported,
          ...CONTRIBUTION_CLASSES.declarative,
          ...CONTRIBUTION_CLASSES.runtime,
        ];
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "VSIX contributes section(s) this host does not recognise: " + unknown.join(", ") +
            ". Known sections: " + known.join(", ") + ".",
        });
      }
    }),
}).strict();

export type VscodeStatusBarSnapshot = { text: string; tooltip: string; command: string | null };

/**
 * Opt-in, single-resource L2 adapter ports. The actual Settings/Toast/diagnostics
 * services are owned by the trusted caller, NOT the VSIX process or this bridge.
 * Absent ports fail closed when an extension attempts to publish the corresponding DTO.
 * This is deliberately not a general VS Code API implementation.
 */
export interface VscodeL2Ports {
  /** Non-secret, per-extension SettingRepo projection, taken by a trusted host. */
  configuration?: Record<string, string | number | boolean>;
  /** Requests ModuleHost's existing resource.write/action approval on EVERY invocation. */
  fileWrite?: boolean;
  notify?: (message: { kind: "info" | "warning"; text: string }) => Promise<void>;
  publishDiagnostics?: (snapshot: { name: string; path: string; messages: string[] }) => Promise<void>;
}

const l2ConfigSchema = z.record(z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
  .refine(value => Object.keys(value).length <= 32, "Too many extension configuration keys");

const l2NotificationsSchema = z.array(z.object({
  kind: z.enum(["info", "warning"]), text: z.string().min(1).max(256),
}).strict()).max(4);
const l2DiagnosticsSchema = z.array(z.object({
  name: z.string().min(1).max(80), path: z.string().min(1).max(4096),
  messages: z.array(z.string().min(1).max(256)).max(8),
}).strict()).max(4);

/**
 * 【F003】两个条目各自的**上限**，与「为什么是这些数」。
 *
 * **这两个数字原本没有任何依据。** `68a7121c`（限制最初引入的提交）的提交信息是空的，
 * `docs/planning/extension-vscode-compat.md` §4 从未写过理由，`tasks/archive/` 里也没有。
 * 结论：它们是 L1 原型阶段随手定的安全边界。
 *
 * - **`MANIFEST_LIMIT` 从 4096 放宽到 65536（64 KiB）。**
 *   依据是实测：真实扩展里最大的 `package.json` 是 `mechatroner.rainbow-csv-3.24.1`
 *   的 **17 021 B**，超旧限 4.2 倍。64 KiB 给它约 3.8 倍余量。
 *   放宽它**不会**加重「装进来但 API 全缺」的问题 —— 那个问题只跟可执行入口有关，
 *   而 `package.json` 是**声明**：变大只意味着多了命令、配置项、activationEvents，
 *   不引入任何新能力。
 *
 * - **`SOURCE_LIMIT` 保持 24576（24 KiB），本卡不放宽。**
 *   这道墙后面才是真正的难题：`extension.js` 一旦能进，用户就会期望它**能跑**，
 *   而 `require` 白名单目前只有 `"vscode"`、53 个 `vscode.*` 成员没有一个是完整实现。
 *   **放宽等于承诺一个跑不起来的运行时** —— 装进去了、能列出、一调用就崩，
 *   比「装不进来」更坏。要让真实扩展（rainbow-csv 是 136 516 B）进得来，
 *   得先把运行时做出来，或者明确接受「装得进但跑不了」并告知用户。
 */
const MANIFEST_LIMIT = 64 * 1024;
const SOURCE_LIMIT = 24 * 1024;

/** 条目名 → 它该受哪一道限额管。
 *
 * 【F009】main 的条目名不再固定（可以是 `extension/dist/extension.js`），
 * 所以改成「**只看它是不是 package.json**」——
 * `extension/package.json` 是清单，其余一律按 main 的限额。 */
function limitFor(name: string): number {
  return name === "extension/package.json" ? MANIFEST_LIMIT : SOURCE_LIMIT;
}

function entryLabel(name: string): string {
  return name === "extension/package.json" ? "manifest" : "main entry";
}

/**
 * 从 ZIP 里取出 `extension/package.json` 与**它声明的 main** 两个条目。
 *
 * ## 【F009】为什么要分两遍读
 *
 * 从前是「按固定名字取两个条目」：`package.json` + 写死的 `extension/extension.js`。
 * 而 `main` 现在可以是任意路径（`./dist/extension.js`、`./out/src/main.js`、
 * 或无后缀的 `./extension`），**必须先读出清单才能知道该取哪个条目**。
 *
 * 所以拆成两个阶段：
 *  1. `scan()` 走一遍中央目录，把**所有**条目都解出来放进 `entries`；
 *  2. 取 `package.json` → 解析 → 算出 `main` 的**真实 ZIP 条目名**（`extension/` + 路径，
 *     无后缀补 `.js`）→ 从 `entries` 里取它。
 *
 * **没有真的读两遍 ZIP** —— `scan()` 本来就遍历全部条目，一次就够。
 * 所谓「两遍」是**逻辑上的两阶段**（先清单、再按清单取 main），不是两次 IO。
 *
 * ## ⚠️ 白名单从「两个固定名字」变成「package.json + 任意一个 main」
 *
 * 但**「恰好 2 个 entry」的约束没动**（F003 已确认它和 4096 一样没有依据，
 * 但那是另一张卡的事）。所以真正允许的包仍然是「两个条目」：
 * 一个必须是 `extension/package.json`，另一个必须**恰好是清单声明的那个 main**。
 * 多出来的第三个条目仍会被拒 —— 不是白名单拒的，是「恰好 2 个」拒的。
 */
export function readMinimalVsix(archive: Uint8Array): { packageJson: unknown; source: string } {
  if (archive.length < 100 || archive.length > 128 * 1024) throw Error("VSIX size out of L1 bounds");
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (n: number): number => view.getUint16(n, true);
  const u32 = (n: number): number => view.getUint32(n, true);
  const within = (start: number, length: number): boolean =>
    Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= bytes.length;
  // Local fixture ZIPs have no trailing comment. Other ZIP variants are explicitly unsupported.
  const end = bytes.length - 22;
  if (u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0 ||
      u16(end + 8) !== 2 || u16(end + 10) !== 2 || u16(end + 20) !== 0) {
    throw Error("VSIX requires exactly two plain ZIP entries");
  }
  const centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (!within(centralStart, centralSize) || centralStart + centralSize !== end) throw Error("Invalid VSIX central directory");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map<string, Uint8Array>();
  let pos = centralStart;
  for (let index = 0; index < 2; index++) {
    if (!within(pos, 46) || u32(pos) !== 0x02014b50) throw Error("Invalid VSIX central entry");
    const flags = u16(pos + 8), method = u16(pos + 10), crc = u32(pos + 16);
    const size = u32(pos + 20), unpacked = u32(pos + 24);
    const nameLength = u16(pos + 28), extra = u16(pos + 30), comment = u16(pos + 32);
    const local = u32(pos + 42);
    // 【F002】method 8 = DEFLATE。STORE 时 size 必须等于 unpacked；DEFLATE 时
    // size 是压缩后长度、unpacked 是解压后长度，两者通常不同，所以分开判。
    if (flags !== 0 || (method !== 0 && method !== 8) ||
        (method === 0 && size !== unpacked) ||
        u16(pos + 34) !== 0 || u32(pos + 38) !== 0 || !within(pos + 46, nameLength + extra + comment)) {
      throw Error("Unsupported VSIX ZIP entry");
    }
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    // 【F009】白名单从「两个固定名字」改成「清单 + 扩展根下的任意 .js 路径」。
    // main 现在可以是 `extension/dist/extension.js` 这种带目录的路径，
    // 固定名字不可能覆盖。但**仍然只收 `extension/` 前缀下的条目**，
    // 且**不许 `..` 段**（ZIP 里的条目名同样要防穿越）。
    if (!/^extension\/(?!.*\.\.)[A-Za-z0-9._\-\/]+$/.test(name)) {
      throw Error("L1 VSIX entry not allowlisted: " + name);
    }
    if (entries.has(name)) throw Error("Duplicate VSIX entry");
    // 局部头里的 method/crc/size 必须与中央目录一致（两处都写，不一致就是包被拼过）。
    if (!within(local, 30) || u32(local) !== 0x04034b50 ||
        u16(local + 6) !== flags || u16(local + 8) !== method ||
        u32(local + 14) !== crc || u32(local + 18) !== size || u32(local + 22) !== unpacked) {
      throw Error("VSIX local header mismatch");
    }
    const localNameSize = u16(local + 26), localExtra = u16(local + 28);
    const dataStart = local + 30 + localNameSize + localExtra;
    if (!within(local + 30, localNameSize + localExtra) ||
        decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name ||
        !within(dataStart, size) || dataStart + size > centralStart) {
      throw Error("Invalid VSIX local data extent");
    }
    const raw = bytes.subarray(dataStart, dataStart + size);
    // 【F002】解压路径。**先解压、再按声明尺寸核对、最后过同一套 CRC32** ——
    // 顺序很重要：解压失败 / 尺寸不符 / CRC 不符是三种不同的病因，各自要能分辨。
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else {
      // 声明尺寸先卡一遍上限，避免一个声称 4 GiB 的包把解压撑爆内存。
      // 【F003】两个上限各自不同、且错误信息要能区分是哪一道 —— 见文件末尾的限额常量。
      if (unpacked > limitFor(name)) {
        throw Error(
          "VSIX DEFLATE " + entryLabel(name) + " exceeds " + limitFor(name) + " B (header declares " + unpacked + ")",
        );
      }
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(unpacked, 1) }));
      } catch (cause) {
        // 损坏的 deflate 流、或解压结果超过声明尺寸，都会在这里。
        // 不静默返回空：说清是解压失败，并把底层原因带出来。
        throw Error("VSIX DEFLATE inflate failed for " + name + ": " + String(cause));
      }
      if (data.byteLength !== unpacked) {
        throw Error(
          "VSIX DEFLATE size mismatch for " + name +
          ": header declares " + unpacked + " bytes, inflated " + data.byteLength,
        );
      }
    }
    let computed = 0xffffffff;
    for (const value of data) {
      computed ^= value;
      for (let bit = 0; bit < 8; bit++) computed = (computed >>> 1) ^ ((computed & 1) ? 0xedb88320 : 0);
    }
    // 【F002】DEFLATE 时 CRC 必须对**解压后**的数据算（ZIP 规范如此）。STORE 时两者同一份。
    if (((computed ^ 0xffffffff) >>> 0) !== crc) throw Error("VSIX CRC mismatch");
    entries.set(name, data);
    pos += 46 + nameLength + extra + comment;
  }
  if (pos !== end) throw Error("Extra VSIX directory data");
  const manifest = entries.get("extension/package.json");
  // 【F003】四条拒绝各自可区分（「缺了」与「两类条目各自超限」分开）。
  if (!manifest) throw Error("VSIX archive has no extension/package.json");
  if (manifest.byteLength > MANIFEST_LIMIT) {
    throw Error("VSIX manifest exceeds " + MANIFEST_LIMIT + " B (got " + manifest.byteLength + ")");
  }

  // 【F009】**第二阶段**：先解析清单，读出它声明的 `main`，再按那个路径去取源码。
  // 这是本卡的结构性改动 —— 从前 `main` 是写死的 `extension/extension.js`，
  // 现在它可以是 `./dist/extension.js`、`./out/src/main.js`、或无后缀的 `./extension`。
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(manifest));
  } catch (cause) {
    throw Error("VSIX manifest is not valid JSON: " + String(cause));
  }
  const mainField = (parsed as { main?: unknown }).main;
  if (typeof mainField !== "string") {
    throw Error("VSIX manifest has no string 'main' field");
  }
  const mainEntry = mainEntryName(mainField);
  const main = entries.get(mainEntry);
  if (!main) {
    // 说清**声明的是什么、算出来的条目名是什么、包里有什么** —— 否则「读不到」
    // 无法与「路径写错了」区分开。
    throw Error(
      "VSIX declares main '" + mainField + "' (entry '" + mainEntry +
      "') but the archive does not contain it; entries: " + [...entries.keys()].join(", "),
    );
  }
  if (main.byteLength > SOURCE_LIMIT) {
    throw Error("VSIX main entry exceeds " + SOURCE_LIMIT + " B (got " + main.byteLength + ")");
  }
  return { packageJson: parsed, source: decoder.decode(main) };
}

/**
 * 【F009】`publisher.name` → 归一化的小写模块 id。
 *
 * `publisher` 现在允许大写（VS Code 官方要求小写，但现实中存在，本机 4 个），
 * 而 `ModuleHost` 的模块 id 是**大小写敏感的键**。不归一化的话，
 * `James-Yu.latex-workshop` 与 `james-yu.latex-workshop` 会是两个不同的模块 ——
 * 同一个扩展换个发布者大小写就变成两份。
 *
 * 归一化本身有代价：两个只差大小写的 publisher 会撞成同一个 id。
 * 那个代价由 `install()` 里的撞车检测兜住（拒绝并说清，不静默覆盖）。
 */
function normalizeModuleId(publisher: string, name: string): string {
  return ("user." + publisher + "." + name).toLowerCase();
}

/**
 * 【F009】清单里的 `main`（如 `./dist/extension.js`）→ ZIP 条目名（`extension/dist/extension.js`）。
 *
 * 三条规则，来自 VS Code 的真实行为：
 * 1. 相对扩展根，所以加 `extension/` 前缀；
 * 2. **无 `.js` 后缀时补 `.js`**（`./extension` → `extension/extension.js`）——
 *    实测 8 个真实扩展用无后缀写法；
 * 3. `..` 已由 schema 的 regex 拒掉，这里**再守一次**：万一将来有人放宽了 schema，
 *    这一层仍然拦住逃逸。
 */
function mainEntryName(mainField: string): string {
  const relative = mainField.replace(/^\.\//, "");
  if (relative.length === 0 || relative.split("/").includes("..")) {
    throw Error("VSIX main escapes the extension root: " + mainField);
  }
  const withSuffix = /\.js$/i.test(relative) ? relative : relative + ".js";
  return "extension/" + withSuffix;
}

/**
 * A scoped, ephemeral `require("vscode")` shim inside the existing child process.
 * Activation and command registration repeat for each invocation. Status-bar data
 * is a returned snapshot, NOT a live widget; only commands declared in contributes
 * are eligible. Unsupported vscode API access throws rather than silently no-ops.
 */
/**
 * L2 is a small opt-in API-to-ModuleResource adapter, not a VS Code extension
 * runtime. File operations are bound to the ONE already-authorized resource;
 * the real Node permissioned child is still ModuleHost's sole executor.
 * Editor edit transactions and long-lived diagnostics are NOT emulated.
 */
function childL2Snippet(command: string, section: string, configuration: Record<string, string | number | boolean>, fileWrite: boolean): string {
  return `
      const l2Notifications = [], l2Diagnostics = [];
      const l2Fs = require("node:fs");
      const l2Uri = Object.freeze({
        file: (fsPath) => {
          if (typeof fsPath !== "string" || fsPath.length > 4096) throw Error("L2 invalid file URI");
          return Object.freeze({ scheme: "file", fsPath });
        }
      });
      const l2Path = (uri) => {
        if (!uri || uri.scheme !== "file" || uri.fsPath !== resource.path)
          throw Error("L2 scope denied: URI differs from authorized resource");
        return resource.path;
      };
      const l2Notify = (kind, text) => {
        if (typeof text !== "string" || !text.trim() || text.length > 256 || l2Notifications.length >= 4)
          throw Error("L2 notification out of bounds");
        l2Notifications.push({ kind, text });
        return Promise.resolve(undefined);
      };
      const l2Configuration = Object.freeze(${JSON.stringify(configuration)});
      const l2 = Object.freeze({
        Uri: l2Uri,
        workspace: Object.freeze({
          fs: Object.freeze({
            readFile: async (uri) => {
              const bytes = l2Fs.readFileSync(l2Path(uri));
              if (bytes.byteLength > 1024 * 1024) throw Error("L2 read exceeds 1 MiB");
              return new Uint8Array(bytes);
            },
            writeFile: async (uri, bytes) => {
              if (!${JSON.stringify(fileWrite)}) throw Error("L2 resource.write permission required");
              const path = l2Path(uri);
              if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024)
                throw Error("L2 write requires Uint8Array <= 1 MiB");
              l2Fs.writeFileSync(path, bytes);
            }
          }),
          getConfiguration: (requested) => {
            if (requested !== undefined && requested !== ${JSON.stringify(section)})
              throw Error("L2 configuration namespace denied");
            return Object.freeze({
              get: (key, defaultValue) => {
                if (typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(key))
                  throw Error("L2 configuration key invalid");
                return Object.prototype.hasOwnProperty.call(l2Configuration, key)
                  ? l2Configuration[key] : defaultValue;
              },
              has: (key) => Object.prototype.hasOwnProperty.call(l2Configuration, key)
            });
          }
        }),
        window: Object.freeze({
          showInformationMessage: (text) => l2Notify("info", text),
          showWarningMessage: (text) => l2Notify("warning", text)
        }),
        commands: Object.freeze({
          registerTextEditorCommand: (id, callback) => {
            if (id !== ${JSON.stringify(command)} || typeof callback !== "function" || handlers.has(id))
              throw Error("L2 editor command undeclared or duplicate");
            handlers.set(id, async (selected) => callback(Object.freeze({
              document: Object.freeze({
                uri: l2Uri.file(selected.path),
                getText: () => l2Fs.readFileSync(selected.path, "utf8")
              }),
              edit: () => { throw Error("L2 editor edit transactions unsupported"); }
            })));
            return { dispose() { handlers.delete(id); } };
          }
        }),
        languages: Object.freeze({
          createDiagnosticCollection: (name) => {
            if (typeof name !== "string" || !name.trim() || name.length > 80)
              throw Error("L2 invalid diagnostic collection name");
            if (l2Diagnostics.length >= 4) throw Error("L2 too many diagnostic collections");
            const record = { name, path: resource.path, messages: [] };
            l2Diagnostics.push(record);
            return Object.freeze({
              set: (uri, entries) => {
                l2Path(uri);
                if (!Array.isArray(entries) || entries.length > 8 ||
                    entries.some(x => !x || typeof x.message !== "string" || !x.message.trim() || x.message.length > 256))
                  throw Error("L2 diagnostics out of bounds");
                record.messages = entries.map(x => x.message);
              },
              clear: () => { record.messages = []; },
              dispose: () => { record.messages = []; }
            });
          }
        })
      });
  `;
}

function childProgram(entry: string, command: string, l2?: { section: string; configuration: Record<string, string | number | boolean>; fileWrite: boolean }): string {
  return `({
    run: async (resource) => {
      const handlers = new Map();
      const statusBars = [];
      const disposables = [];
      ${l2 ? childL2Snippet(command, l2.section, l2.configuration, l2.fileWrite) : "const l2 = null;"}
      const vscode = Object.freeze({
        ...(l2 ? { Uri: l2.Uri, workspace: l2.workspace, languages: l2.languages } : {}),
        commands: Object.freeze({
          ...(l2 ? l2.commands : {}),
          registerCommand: (id, handler) => {
            if (id !== ${JSON.stringify(command)} || typeof handler !== "function" || handlers.has(id)) {
              throw Error("Undeclared or duplicate VS Code command");
            }
            handlers.set(id, handler);
            return { dispose() { handlers.delete(id); } };
          }
        }),
        window: Object.freeze({
          ...(l2 ? l2.window : {}),
          createStatusBarItem: () => {
            if (statusBars.length) throw Error("L1 permits one status bar item");
            const item = { text: "", tooltip: "", command: undefined, visible: false,
              show() { this.visible = true; },
              hide() { this.visible = false; },
              dispose() { this.visible = false; }
            };
            statusBars.push(item);
            return item;
          }
        })
      });
      const loaded = { exports: {} };
      // 【F013】扩展代码能 require 什么。
      //
      // ## 白名单是**枚举表**，不是 「startsWith("node:")「
      //
      // 前缀匹配会把 「node:child_process「 / 「node:net「 / 「node:vm「 一起放行 ——
      // 那等于把沙箱的钥匙递给它。这里只列**确实安全**的：
      //
      //  - 「vscode「：兼容层，本来就是给扩展的；
      //  - 「path「：纯字符串运算，没有 IO、没有进程、没有网络。给它是安全的，
      //    而**不给它**会让大量真实扩展在加载时就崩（它们普遍用 「path.join「）；
      //  - 「fs「：**受限替身，不是真 node:fs**。见下面 「fsCompat「。
      //
      // ## ⚠️ 关于 L2 的 「require("node:fs")「
      //
      // 「childL2Snippet「 里有 「const l2Fs = require("node:fs")「，而那段代码生成在
      // **这个 「new Function「 之外**（它在构造 「vscode「 对象时执行）。所以它用的是
      // **子进程的真实 require**，不受这里的白名单约束。
      //
      // **那是设计使然，不是漏洞**：L2 是宿主自己的适配层（「l2Path「 会校验
      // URI 必须等于已授权的 「resource.path「），不是扩展提交的代码。
      // 但**这条事实必须写在这里** —— 否则下一个人会以为白名单挡住了所有 「fs「，
      // 从而对「扩展拿不到真 fs」做出错误的推断。
      const pathCompat = require("node:path");
      const nodeFs = require("node:fs");
      // 扩展给的路径必须**就是**已授权的那个资源。用 「path.resolve「 归一化后比较，
      // 挡住 「./x/../resource「 这类写法 —— 但它**不**做符号链接解析（那要 IO），
      // 所以真实路径的放行仍由子进程的 「--allow-fs-read「 兜底（见
      // 「permissionedProcessRunner「 里那段关于 resolveResource 的注释）。
      const authorizedPath = (p) => {
        if (typeof p !== "string" || p.length === 0 || p.length > 4096) {
          throw Error("fs denied: invalid path");
        }
        if (pathCompat.resolve(p) !== pathCompat.resolve(resource.path)) {
          throw Error("fs denied: path is not the authorized resource");
        }
        return resource.path;
      };
      const fsCompat = Object.freeze({
        // 只开放**只读**操作，且每个都先过 authorizedPath()。
        // **不提供的**：写、删除、重命名、chmod、创建目录、任何 stream/watch ——
        // 写路径走 L2 的 「workspace.fs.writeFile「（它要 「resource.write「 权限 +
        // 逐次批准），不该从 fs 这里绕过去。
        readFileSync: (p, options) => nodeFs.readFileSync(authorizedPath(p), options),
        existsSync: (p) => { try { return nodeFs.existsSync(authorizedPath(p)); } catch { return false; } },
        statSync: (p) => nodeFs.statSync(authorizedPath(p)),
      });
      const requireCompat = (id) => {
        if (id === "vscode") return vscode;
        if (id === "path" || id === "node:path") return pathCompat;
        if (id === "fs" || id === "node:fs") return fsCompat;
        // ⚠️ **枚举表，不是「startsWith(node:)」** —— 后者会把
        // node:child_process / node:net / node:vm 一起放行。
        throw Error("Unsupported VS Code extension import: " + String(id));
      };
      const source = ${JSON.stringify(entry)};
      (new Function("module", "exports", "require", source))(loaded, loaded.exports, requireCompat);
      if (typeof loaded.exports.activate !== "function") throw Error("VS Code extension activate() missing");
      await loaded.exports.activate({ subscriptions: disposables });
      const handler = handlers.get(${JSON.stringify(command)});
      if (!handler) throw Error("Declared VS Code command not registered");
      // Only an already-authorized resource is passed; no untrusted command args.
      const value = await handler(resource);
      const bar = statusBars.find(x => x.visible);
      return {
        message: typeof value === "string" ? value.slice(0, 4096) : JSON.stringify(value ?? null).slice(0, 4096),
        statusBarText: bar ? String(bar.text).slice(0, 4096) : "",
        statusBarTooltip: bar ? String(bar.tooltip).slice(0, 4096) : "",
        statusBarCommand: bar && bar.command === ${JSON.stringify(command)} ? bar.command : "",
        ...(l2 ? {
          l2Notifications: JSON.stringify(l2Notifications),
          l2Diagnostics: JSON.stringify(l2Diagnostics)
        } : {})
      };
    }
  })`;
}

export class VscodeL1Bridge {
  private bar: VscodeStatusBarSnapshot | null = null;
  private constructor(
    private readonly host: ModuleHost,
    readonly moduleId: string,
    readonly commandId: string,
    private readonly installedManifest: string,
    /**
     * 【F011】本宿主**接受了、但不会真正生效**的贡献点。
     *
     * 存在的理由：装上一个真实扩展之后，它的菜单项不出现、设置项不生效 ——
     * **用户会以为自己装坏了**。这个列表是「哪些部分不会工作」的机器可读载体。
     *
     * ⚠️ **它只挂在实例上，没有进 `ModuleChangeResult`** —— 那个契约在
     * `packages/contracts/**`，不在本卡的范围。所以调用方（IPC handler / UI）
     * **需要自己把这个字段带出去**，否则用户仍然看不到。
     * 这一步没做，见 `tasks/F/F011` 回写区。
     */
    readonly ignoredContributions: readonly IgnoredContribution[],
    private readonly l2?: VscodeL2Ports,
  ) {}

  /** Trusted host entry only. Explicit install consent is required; never expose directly to an agent/renderer. */
  static async install(
    host: ModuleHost,
    archive: Uint8Array,
    consent: {
      confirmReadAccess: boolean;
      confirmExecutableCode: boolean;
      /** 【F010】安装卡片的三态选择。**由调用方给，不由这里默认**。
       *
       * 从前这里没有这个字段，`host.install(manifest)` 走的是它自己的默认
       * `decision = "allow-once"` —— 于是**用户选「拒绝」，走到 bridge 就被默认成
       * 「允许一次」**。handler 那边确实挡了一道（`deny` 在读文件之前返回），
       * 但那道离 `host.install` 隔着四步，**任何新调用方（工作流、直接调 bridge 的测试）
       * 都会绕过它**。
       *
       * ## 两道门不是重复
       *
       * - **handler 那道挡「读文件」**：`deny` 时不 `readFileSync`，磁盘零读取。
       *   那是 bridge **做不到**的 —— 它拿到 `archive` 时字节早就读进来了。
       * - **这里这道挡「写盘」**：`deny` 时不调 `host.install`，磁盘零写入。
       *
       * **两道门守的是两件事**（一个不读、一个不写），所以都要有。
       * 只加其中一道就以为万事大吉，是这张卡要防的那类误读。
       */
      installConsent?: ModuleInstallDecision;
    },
    l2?: VscodeL2Ports,
  ): Promise<VscodeL1Bridge> {
    const { packageJson, source } = readMinimalVsix(archive);
    const pkg = packageSchema.parse(packageJson);
    // 【F004】只**激活第一条**命令。这是本宿主的真实能力边界 ——
    // schema 现在能收下 24 条（为了过真实扩展的清单），但运行时只跑第一条。
    // 不在这里假装支持多命令：那会让第 2..24 条在菜单里出现、点了没反应。
    const commandId = pkg.contributes.commands[0]!.command;
    // 【F008】命令 id 的前缀规则改成**真实生态的形态**。
    //
    // 原规则强制 `<publisher>.<name>.`，而实测本机 24 个有 commands 的真实扩展
    // **没有一个**用那个前缀 —— 全部是 `<name>.<command>`：
    //   mechatroner.rainbow-csv → `rainbow-csv.CSVLint`
    //   James-Yu.latex-workshop → `latex-workshop.hostPort`
    //   ms-azuretools.vscode-containers → `vscode-containers.compose.down`
    // 所以那条规则让 **100% 的真实扩展装不上**，且它和 4096 / 128 KiB / z.tuple
    // 出自同一个提交 `68a7121c`，同样没有依据（VS Code 本身也不强制 publisher 前缀，
    // 只要求全局唯一）。
    //
    // **但不完全去掉**：去掉之后扩展可以声明别的扩展的命令 id。
    // 接受两种形态，且**先试更严格的那个** —— 这样下面的错误信息能说清用了哪种。
    const strictPrefix = pkg.publisher + "." + pkg.name + ".";
    const namePrefix = pkg.name + ".";
    const usedPrefix = commandId.startsWith(strictPrefix)
      ? strictPrefix
      : commandId.startsWith(namePrefix) ? namePrefix : null;
    if (usedPrefix === null) {
      throw Error(
        "VSIX command id must start with '" + strictPrefix + "' or '" + namePrefix +
        "' (got '" + commandId + "')",
      );
    }
    // 【F004】activationEvents 从「必须恰好 1 条且等于 onCommand:第一条」放宽成
    // 「**必须包含** onCommand:第一条」。其余事件（onLanguage:csv / workspaceContains:…）
    // **允许声明但不会激活** —— schema 放开的只是「装得进来」，不是「这些事件支持了」。
    // ⚠️ 这一段的语义边界别读错：清单里写了 11 个事件，本宿主仍然只在命令被调用时激活。
    if (pkg.activationEvents && !pkg.activationEvents.includes("onCommand:" + commandId)) {
      throw Error(
        "VSIX activationEvents must include onCommand:" + commandId +
        " (this host only activates on that command; other declared events are not honoured)",
      );
    }
    // 【F003】用统一常量而非字面量 —— 否则改一处忘一处，两道限额会分叉。
    // 这条错误与 `readMinimalVsix` 里那条**不同消息**：那个说「压缩包里的声明的多大」，
    // 这个说「解出来交给运行时的源码多长」，排查时指向不同的层。
    if (source.length > SOURCE_LIMIT) {
      throw Error("VSIX entry exceeds the L1 source limit (" + SOURCE_LIMIT + " B)");
    }
    // 【F009】moduleId 归一化到小写。publisher 现在允许大写（`James-Yu`），
    // 而 `ModuleHost` 的 id 是**大小写敏感**的键 —— 不归一化会得到
    // `user.James-Yu.latex-workshop` 与 `user.james-yu.latex-workshop` 两个条目，
    // 同一个扩展装两次就变成两个。
    //
    // 冲突检测：`host.catalog()` 里已有同 id 且**不是升级**（版本不同但来源不同）
    // 时……实际上 ModuleHost 的 install 本身就是「同 id 覆盖」，那是设计。
    // 这里要防的是**归一化后意外撞车**：两个 publisher 只差大小写的不同扩展。
    // 归一化后它们会得到同一个 id —— 那必须在装之前就看出来，而不是让后者静默覆盖前者。
    const moduleId = normalizeModuleId(pkg.publisher, pkg.name);
    const title = pkg.displayName ?? pkg.name;
    const configuration = l2ConfigSchema.parse(l2?.configuration ?? {});
    const manifest = {
      apiVersion: 1, id: moduleId, version: pkg.version,
      title: { zh: title, en: title },
      permissions: l2?.fileWrite ? ["resource.read", "resource.write"] : ["resource.read"],
      contributions: [{
        id: "run", slot: "files.context", capability: "module.run",
        title: { zh: pkg.contributes.commands[0].title, en: pkg.contributes.commands[0].title },
        view: { title: { zh: title, en: title }, fields: [
          { key: "message", title: { zh: "结果", en: "Result" } },
          { key: "statusBarText", title: { zh: "状态", en: "Status" } },
        ] },
      }],
      program: { source: childProgram(source, commandId, l2 ? {
        // 【F009】section 与 moduleId 同一份归一化 —— 否则设置项的 key 与模块 id 会分叉。
        section: moduleId.slice("user.".length), configuration, fileWrite: l2.fileWrite === true,
      } : undefined), timeoutMs: 10_000 },
    };
    const checked = ModuleInstallSchema.parse({ manifest, ...consent });
    // 【F009】归一化撞车检测：同一个归一化 id 若已有**另一个**模块占用，
    // 而它的标题/发布者原值与本次不同，说明是两个不同扩展归一化后相撞。
    // 这时**拒绝并说清**，不让后者静默覆盖前者（覆盖是升级的语义，不是不同扩展的语义）。
    const existing = host.catalog().modules.find((m) => m.id === moduleId);
    if (existing && existing.version !== pkg.version) {
      const sameSource = existing.title?.en === title;
      if (!sameSource) {
        throw Error(
          "VSIX module id collision after normalisation: '" + moduleId +
          "' is already taken by another extension (existing title '" + String(existing.title?.en) +
          "', incoming '" + title + "')",
        );
      }
    }
    await host.install(
      checked.manifest,
      // 【F010】**第二个参数是 `grantedPermissions`，不是 decision。**
      // 传 `undefined` 是刻意的：VSIX 这条路径不做「逐项选择权限」，
      // 它请求的是 `resource.read`（+ 可选 `resource.write`），
      // 两者都在 `host.install` 的「新模型可默认」白名单里，不需要逐项确认。
      // 把 decision 塞进这个位置会让它被当成权限数组，`assertModuleGrants` 会抛一个
      // 与「用户拒绝」毫无关系的错 —— 于是 deny 看起来「生效了」，实际是撞了别的错。
      undefined,
      // 【F010】第三个参数才是 decision。缺省时**显式给 `"allow-once"`**，
      // 而不是靠 `host.install` 的默认值 —— 那让「本函数传了什么」在调用点可见，
      // 也让将来的读者不必翻到 ModuleHost 去确认默认是什么。
      consent.installConsent ?? "allow-once",
    );
    // 【F011】算出「接受了但不会生效」的清单，随实例返回。
    // A 类（声明式）与 B 类（需运行时）都进这里 —— **标记对两类都强制**，
    // 因为 A 类用户永远不会自己发现（见文件顶部那段论证）。
    const ignoredContributions: IgnoredContribution[] = Object.keys(
      (pkg.contributes ?? {}) as Record<string, unknown>,
    )
      .map((section): IgnoredContribution | null => {
        const kind = classifyContribution(section);
        return kind === "declarative" || kind === "runtime" ? { section, kind } : null;
      })
      .filter((x): x is IgnoredContribution => x !== null);

    return new VscodeL1Bridge(host, moduleId, commandId, JSON.stringify(checked.manifest), ignoredContributions, l2);
  }

  /** Prevent a stale adapter from targeting a replaced same-ID extension. */
  private isCurrent(): boolean {
    const installed = this.host.catalog().modules.find(module => module.id === this.moduleId);
    return installed !== undefined && JSON.stringify(installed) === this.installedManifest;
  }

  /** One real ModuleHost invoke (authorization, cancellation and child process); no side-channel execution. */
  async executeCommand(commandId: string, resource: ModuleResource, requestId: string): Promise<ModuleReply> {
    if (commandId !== this.commandId) throw Error("Undeclared VS Code command");
    if (!this.isCurrent()) throw Error("VSIX module removed or replaced; adapter must be reloaded");
    const reply = await this.host.invoke({ moduleId: this.moduleId, contributionId: "run", resource, requestId });
    if (reply.type === "result") {
      if (this.l2) {
        const notifications = l2NotificationsSchema.parse(JSON.parse(String(reply.value.l2Notifications)));
        const diagnostics = l2DiagnosticsSchema.parse(JSON.parse(String(reply.value.l2Diagnostics)));
        for (const notice of notifications) {
          if (!this.l2.notify) throw Error("L2 notification host port unavailable");
          await this.l2.notify(notice);
        }
        for (const diagnostic of diagnostics) {
          if (diagnostic.path !== resource.path) throw Error("L2 diagnostic scope denied");
          if (!this.l2.publishDiagnostics) throw Error("L2 diagnostics host port unavailable");
          await this.l2.publishDiagnostics(diagnostic);
        }
      }
      const text = reply.value.statusBarText;
      const tooltip = reply.value.statusBarTooltip;
      const command = reply.value.statusBarCommand;
      this.bar = typeof text === "string" && text.length > 0
        ? { text, tooltip: typeof tooltip === "string" ? tooltip : "", command: command === this.commandId ? command : null }
        : null;
    }
    return reply;
  }

  /** Host-only DTO (no renderer mapping within this scoped prototype). */
  statusBarItem(): VscodeStatusBarSnapshot | null {
    return this.isCurrent() && this.bar ? { ...this.bar } : null;
  }
}
