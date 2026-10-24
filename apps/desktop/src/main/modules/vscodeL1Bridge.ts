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
 * 【F014】顶层字段分两类。**不是逐个枚举那 11 个 —— 每个扩展的字段集都不一样。**
 *
 * 实测本机 29 个扩展，schema 之外共有 **25 个不同的顶层字段**，而 rainbow-csv
 * 只占其中 11 个。只放行那 11 个，下一个扩展照样装不进。
 *
 * ## 分类依据：这个字段会不会改变**行为**
 *
 * - **元数据**（接受，无副作用）：只影响展示 / 发布 / 打包，宿主不读也不该读。
 *   `description`、`license`、`icon`、`keywords`、`categories`、`repository`、
 *   `homepage`、`bugs`、`author`、`scripts`、`devDependencies`、`dependencies`、
 *   `__metadata`、`galleryBanner`、`preview`、`private`、`overrides`、`l10n`、`aiKey`。
 * - **影响行为**（接受**但必须标记**）：宿主若不处理，用户会看到与预期不符的结果。
 *   - `browser`：**web 版入口**，与 `main` 并列。我们不跑 web 版 ——
 *     静默接受会让用户以为「浏览器里也能用」。
 *   - `capabilities`：**不是元数据，是信任声明**（`untrustedWorkspaces` /
 *     `virtualWorkspaces`）。扩展用它在不受信任的工作区里**主动关掉自己**。
 *     **我们不假装尊重它** —— 本宿主的沙箱模型是「一次授权一个资源」，
 *     不是 VS Code 的工作区信任。但那意味着扩展的这些自我保护**不会生效**，
 *     用户需要知道。
 *   - `extensionKind` / `extensionPack` / `extensionDependencies` /
 *     `enabledApiProposals`：影响加载方式或依赖别的扩展，宿主不处理就等于
 *     那些声明落空。
 *
 * **未知字段仍然拒绝** —— 不认识的东西静默接受，等于给一个我们完全不了解的行为开门。
 */
const TOP_LEVEL_METADATA = [
  "description", "license", "icon", "keywords", "categories", "repository",
  "homepage", "bugs", "author", "contributors", "scripts", "devDependencies",
  "dependencies", "peerDependencies", "__metadata", "galleryBanner",
  "preview", "private", "overrides", "l10n", "aiKey", "pricing", "sponsor",
  "markdown",
] as const;

/** 接受但**必须标记**的顶层字段（它们影响行为而我们不处理）。
 *
 * ⚠️ **`extensionPack` / `extensionDependencies` 必须在这一组，不能在元数据那组。**
 * 第一版把它们当元数据放行了 —— 那是错的：VS Code 里 `extensionDependencies`
 * 会让**这个扩展依赖的别人先装**，`extensionPack` 会让**一批扩展被一起装**。
 * 本宿主两个都不做，所以装上之后那些依赖**不存在**，而扩展代码可能直接崩。
 * 用户必须被告知，否则他只会看到「装好了、一用就报错」。
 *
 * 本机 32 个扩展里 **11 个有 `extensionDependencies`、4 个有 `extensionPack`** ——
 * 不是罕见字段。而 `ide.modules.boundary` 的用户文案本来就写着「不安装依赖」。
 *
 * **本卡不实现依赖安装**（那是另一条能力），只保证「接受 + 必须标记」。 */
const TOP_LEVEL_BEHAVIOURAL = [
  "browser", "capabilities", "extensionKind", "enabledApiProposals",
  "extensionPack", "extensionDependencies",
  // 【F014】`activationEvents` 也在这一组：它是**行为类**而不是元数据 ——
  // 我们接受它、但运行时从不读它（本宿主只在命令被调用时激活）。
  // 它不在这里被 schema 当未知字段拒（上面它是已声明的键），
  // 但 `install()` 收集标记时要能说出「这个字段存在但没生效」。
  // 注意：`activationEvents` 是**已声明**的键，所以它**不经过** superRefine 的未知检查 ——
  // 标记由 `install()` 里单独那一行补，见 `fromTopLevel`。
  "activationEvents",
] as const;

/**
 * 【F014】`contributes` 里的贡献点分三类处理。
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
 * 同样没有依据。**
 *
 * 【F015】64 那个数字也没有依据，而且**会拒掉真实扩展**。实测本机：
 *
 * | 命令数 | 扩展 |
 * |---|---|
 * | 74 | `ms-azuretools.vscode-azurefunctions` |
 * | **101** | `ms-azuretools.vscode-containers` |
 * | 71 | `ms-vscode-remote.remote-containers` |
 *
 * 三个超过 64 → 装不进来。这和 F014 撤掉 `activationEvents` 校验是同一类错误：
 * 阈值按想象定，真实输入全撞上。
 *
 * ## 256 的依据 —— **看清楚了再用**
 *
 * **256 = 本机实测最大值 101 的约 2.5 倍余量。它不是生态上限。**
 * 没有扫过市场（那要联网），所以**不能说"没有扩展超过 256"**。
 * 将来撞上第 4 个更大的扩展，**那是放宽这个数字的理由，不是怀疑这条注释的理由**。
 *
 * 上限本身必须保留：一个声称 100 万条命令的清单会在解析时撑爆内存，
 * 而 `z.array` 不设上限就是无界攻击面。**这条的理由是"防内存"，不是"够用就行"。 */
const MAX_COMMANDS = 256;

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
  // 【F014】`.min(1)` 去掉 —— 空数组是**真实存在的形态**：本机 27 个有 commands
  // 的扩展里 `ms-azuretools.vscode-azurecontainerapps`（53 条命令）和
  // `ms-azuretools.vscode-azurevirtualmachines`（10 条）都写着 `[]`。
  // 而那 2 个扩展在 VS Code 里是能用的 —— 因为 **VS Code 4.0 以后 `contributes`
  // 本身就隐式产生激活事件**，`activationEvents` 为空不等于「没有激活路径」。
  activationEvents: z.array(z.string()).max(MAX_ACTIVATION_EVENTS).optional(),
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
})
  // 【F014】顶层从 `.strict()` 改成 `.passthrough()` + 分类。
  // `.strict()` 拒掉了**所有**真实扩展（实测 25 个不同的额外字段）；
  // 全盘 passthrough 又等于什么都不管。所以按「会不会改变行为」分类：
  // 元数据接受，影响行为的接受但标记，**不认识的仍然拒绝**。
  .passthrough()
  .superRefine((value, ctx) => {
    const known = new Set<string>([
      "publisher", "name", "version", "displayName", "main", "engines",
      "activationEvents", "contributes",
      ...TOP_LEVEL_METADATA,
      ...TOP_LEVEL_BEHAVIOURAL,
    ]);
    const unknown = Object.keys(value as Record<string, unknown>).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "VSIX declares top-level field(s) this host does not recognise: " + unknown.join(", ") +
          ". Metadata fields are accepted; behavioural ones (" + TOP_LEVEL_BEHAVIOURAL.join(", ") +
          ") are accepted but reported as not implemented.",
      });
    }
  });

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
/**
 * 【F016】拒绝原因的类型标识。
 *
 * 为什么要一个 `code` 而不是只靠文案：**「尺寸不够」和「结构不支持」对用户意味着
 * 完全不同的下一步动作**，而文案是给英文读者看的句子，机器侧不该靠 `test(/.../)` 去猜。
 *
 * | code | 用户能做什么 |
 * |---|---|
 * | `VSIX_REJECT_TOO_LARGE` | 找更小的版本 / 请作者精简 —— **有下一步** |
 * | `VSIX_REJECT_STRUCTURE` | **什么都做不了，别试了** —— 本宿主不是为这类包设计的 |
 *
 * ⚠️ **不要为了区分而扩大它** —— 只有「用户下一步动作确实不同」的两类才配各占一个 code。
 * 其余失败（CRC 不符、清单非法…）都是「包坏了」，归 `VSIX_REJECT_INVALID`。
 *
 * 定义在本文件内、不导出到契约层：它是 `Error` 的 message/code，不需要新的契约形状。
 */
export type VsixRejectCode = "VSIX_REJECT_TOO_LARGE" | "VSIX_REJECT_STRUCTURE" | "VSIX_REJECT_INVALID";

export class VsixRejectError extends Error {
  constructor(readonly code: VsixRejectCode, message: string) {
    super(message);
    this.name = "VsixRejectError";
  }
}

/** 本宿主支持的结构。拒绝时原样念给用户听 —— 只说「不行」而不说「什么样才行」，
 *  用户无法判断「换个版本能不能装」。 */
const HOST_SHAPE = "this host accepts exactly 2 ZIP entries (extension/package.json + the declared main), up to 128 KiB packed";

/**
 * 【F016】读中央目录，只统计**结构事实**：条目总数与解压后总量。
 *
 * ⚠️ **纯读取**：不碰 local header、不解压、不校验 CRC —— 它只回答
 * 「这个包有几个文件、解压后多大」，用来在**拒绝时**说清事实。
 * **它不是校验**，任何校验都不该用它的结果。
 *
 * 返回 `null` 表示连 EOCD 都读不出来（那是「包坏了」，不是结构问题）。
 */
function describeArchiveShape(bytes: Uint8Array, view: DataView, u16: (n: number) => number, u32: (n: number) => number): { count: number; unpackedTotal: number } | null {
  const end = bytes.length - 22;
  if (end < 0 || u32(end) !== 0x06054b50) return null;
  const count = u16(end + 10);
  const centralSize = u32(end + 12), centralStart = u32(end + 16);
  if (!Number.isSafeInteger(centralStart) || !Number.isSafeInteger(centralSize) ||
      centralStart < 0 || centralStart + centralSize > bytes.length) return null;
  let pos = centralStart;
  let unpackedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || u32(pos) !== 0x02014b50) return { count, unpackedTotal };
    const nameLength = u16(pos + 28), extra = u16(pos + 30), comment = u16(pos + 32);
    unpackedTotal += u32(pos + 24);
    pos += 46 + nameLength + extra + comment;
  }
  return { count, unpackedTotal };
}

/**
 * 【F016】扫源码里**本宿主不会放行**的 require/import —— 只用于「说清为什么不行」。
 *
 * ⚠️ **这是启发式，不是判据，更不是安全边界。**
 * - 正则扫不到 `require(variable)` / 动态 import / 运行时拼出来的模块名；
 * - **扫到就是证据，扫不到不是保证。**
 *
 * 所以：**扫到 → 报出来；扫不到 → 一个字都不说**（绝不写「没有问题」）。
 * 谁把「扫不到」读成「这个包安全」，谁就把它变成了一道假门禁。
 */
function scanUnsupportedImports(source: string): string[] {
  const found = new Set<string>();
  // 只认字面量参数：require("x") / require('x') / import ... from "x" / import("x")
  const patterns = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const id = match[1]!;
      // 相对/绝对路径需要 CommonJS 模块加载器；node 内置除 path/fs 外一律不放行。
      const isRelative = id.startsWith("./") || id.startsWith("../") || id.startsWith("/");
      const allowed = id === "vscode" || id === "path" || id === "node:path" || id === "fs" || id === "node:fs";
      if (isRelative || !allowed) found.add(id);
    }
  }
  return [...found].sort();
}

export function readMinimalVsix(archive: Uint8Array): { packageJson: unknown; source: string } {
  if (archive.length < 100 || archive.length > 128 * 1024) {
    throw new VsixRejectError(
      "VSIX_REJECT_TOO_LARGE",
      // 【F016】这里**必须明说「内部未检查」** —— 因为整包超限时我们连中央目录都还没读，
      // 更不可能知道它 require 了什么。沉默会让用户以为「只是大了点」，
      // 而真实原因往往在包内（rainbow-csv 顶层就要 child_process）。
      "VSIX size out of L1 bounds (" + archive.length + " B packed; " + HOST_SHAPE +
      "). The archive contents were not inspected, so what it requires is unknown.",
    );
  }
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (n: number): number => view.getUint16(n, true);
  const u32 = (n: number): number => view.getUint32(n, true);
  const within = (start: number, length: number): boolean =>
    Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= bytes.length;
  // Local fixture ZIPs have no trailing comment. Other ZIP variants are explicitly unsupported.
  const end = bytes.length - 22;
  // 【F016】条目数不是 2 时，**说清实际结构**而不是只报「不是 2」。
  //
  // 原来的 `"VSIX requires exactly two plain ZIP entries"` 让用户知道「不是 2」，
  // 但不知道是 6 还是 600 —— 而 6 个文件的 Node 程序（rainbow-csv）和
  // 「作者多打了一个文件」是完全不同的处置。所以这里把**能免费读到的结构事实**
  // 全报出来：条目数、解压后总量、以及本宿主支持什么。
  const shape = describeArchiveShape(bytes, view, u16, u32);
  if (u32(end) !== 0x06054b50 || u16(end + 4) !== 0 || u16(end + 6) !== 0 ||
      u16(end + 8) !== 2 || u16(end + 10) !== 2 || u16(end + 20) !== 0) {
    const actual = shape
      ? " (this package has " + shape.count + " entries, " +
        Math.round((shape.unpackedTotal / 1024) * 10) / 10 + " KiB unpacked; " + HOST_SHAPE + ")"
      : " (" + HOST_SHAPE + ")";
    throw new VsixRejectError(
      "VSIX_REJECT_STRUCTURE",
      // 保留 `requires exactly two` 这个子串：既有套件按它断言，且它仍然准确。
      "VSIX requires exactly two plain ZIP entries" + actual,
    );
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
    // 【F016】源码超限时**顺带说清它 require 了什么** —— 因为「超了 5 倍」这个事实
    // 单独看会暗示「换个更小的版本就行」，而真实原因是它需要本宿主不放行的模块。
    //
    // 这里能读到源码（`main` 已解出来），所以扫描是**可以做的**；但它是启发式，
    // 见 `scanUnsupportedImports` 的注释：**扫到就是证据，扫不到不是保证**。
    const unsupported = scanUnsupportedImports(decoder.decode(main));
    const why = unsupported.length > 0
      ? " It also requires modules this host does not allow: " + unsupported.join(", ") +
        ". That is a structural mismatch, not a size difference."
      : "";
    throw new VsixRejectError(
      "VSIX_REJECT_TOO_LARGE",
      // 保留 `main entry exceeds <N> B` 这个子串：既有套件按它断言，且它仍然准确。
      "VSIX main entry exceeds " + SOURCE_LIMIT + " B (got " + main.byteLength + ")" + why,
    );
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
function childL2Snippet(commands: readonly string[], section: string, configuration: Record<string, string | number | boolean>, fileWrite: boolean): string {
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
            // 【F015】白名单，不是单数 —— 理由同上面 registerCommand。
            if (!DECLARED.includes(id) || typeof callback !== "function" || handlers.has(id))
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

/**
 * 【F015】生成子进程里的扩展宿主。
 *
 * ## `commands` 从「一个 id」变成「一张白名单」
 *
 * 从前这里收单数 `command`，于是 `registerCommand("别的已声明命令")` 直接抛
 * `Undeclared or duplicate VS Code command` —— **扩展声明的 24 条命令里 23 条连注册都不行**。
 *
 * 现在收全部已声明命令 id：
 *  - `registerCommand` / `registerTextEditorCommand` 接受**其中任意一条**（白名单，不是放开）；
 *  - **不在清单里的仍然拒**，且错误点名（把「你没声明」和「本宿主不实现」分开）。
 *
 * ⚠️ **这是 L1（注册）。** 注册成功不等于能被调到 —— 见文件底部 `executeCommand` 的注释：
 * 「调用哪条」这个信息**传不进子进程**（只能借 `resource`，而那是授权判定要检查的路径）。
 * 所以子进程最后仍然只跑 `primary` 那一条。**这条边界必须让它可见，不能被注册成功掩盖。**
 */
function childProgram(
  entry: string,
  commands: readonly string[],
  primary: string,
  l2?: { section: string; configuration: Record<string, string | number | boolean>; fileWrite: boolean },
): string {
  // 生成代码里要用到的两句常量先在 TS 侧拼好 —— 直接嵌进模板里会引号打架。
  const primaryJson = JSON.stringify(primary);
  const declaredErrorSrc = [
    "(id) => (DECLARED.includes(id)",
    "  ? \"VS Code command '\" + id + \"' is declared, but this host only runs the first one ('\" + " + primaryJson + " + \"') — other commands can register but cannot be invoked\"",
    "  : \"VS Code command '\" + id + \"' is not declared in this extension's contributes.commands\")",
  ].join("\n");
  return `({
    run: async (resource) => {
      const handlers = new Map();
      const statusBars = [];
      const disposables = [];
      const DECLARED = ${JSON.stringify(commands)};
      const declaredError = ${declaredErrorSrc};
      ${l2 ? childL2Snippet(commands, l2.section, l2.configuration, l2.fileWrite) : "const l2 = null;"}
      const vscode = Object.freeze({
        ...(l2 ? { Uri: l2.Uri, workspace: l2.workspace, languages: l2.languages } : {}),
        commands: Object.freeze({
          ...(l2 ? l2.commands : {}),
          registerCommand: (id, handler) => {
            if (typeof id !== "string" || typeof handler !== "function" || handlers.has(id) || !DECLARED.includes(id)) {
              throw Error(declaredError(id));
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
      // 【F015】登记了哪几条 —— 用来让"能注册不能调用"这条边界**可见**，
      // 而不是让注册成功把失败盖住。下面那句「registered」会随结果返回给宿主。
      const registered = Array.from(handlers.keys());
      const handler = handlers.get(${primaryJson});
      if (!handler) throw Error("Declared VS Code command not registered");
      // Only an already-authorized resource is passed; no untrusted command args.
      const value = await handler(resource);
      const bar = statusBars.find(x => x.visible);
      return {
        message: typeof value === "string" ? value.slice(0, 4096) : JSON.stringify(value ?? null).slice(0, 4096),
        statusBarText: bar ? String(bar.text).slice(0, 4096) : "",
        statusBarTooltip: bar ? String(bar.tooltip).slice(0, 4096) : "",
        statusBarCommand: bar && bar.command === ${primaryJson} ? bar.command : "",
        registeredCount: registered.length,
        registeredCommands: registered.slice(0, 900).join(","),
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
    /** 【F015】这份清单**声明过**的全部命令 id（不只是能跑的第一条）。
     *
     * 只用于**把拒绝的理由说准**：`executeCommand("demo.second")` 时，
     * 「它声明过但跑不了」和「它压根没声明」是两件不同的事，用户要做的事也不同
     * （前者是宿主的限制，后者是扩展的 bug）。 */
    readonly declaredCommands: readonly string[],
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
    //
    // 【F015】上面那条仍然成立，但**边界往外挪了一层**：
    // 现在**所有已声明的命令都能注册**（L1），而**调用时只有第一条真能跑**。
    // 这个"能注册、不能调用"必须对用户可见 —— 见下面 manifest 里那条第 2 条贡献的注释。
    const commandId = pkg.contributes.commands[0]!.command;
    const declaredCommands: readonly string[] = pkg.contributes.commands.map((c) => c.command);
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
    // 【F014】`activationEvents` 的校验**整个撤掉，改成标记**。
    //
    // ## 为什么撤 —— 三层证据
    //
    // **一、运行时根本不读它。** 全仓 `activationEvents` 的消费者只有**这条校验
    // 自己**（`grep -rn activationEvents apps/ packages/` 除 scripts 外只命中本文件）。
    // 本宿主的激活路径是「有人调 `executeCommand` → 跑 `activate()`」，
    // 一律发生在调用时。所以这个字段**不参与任何运行决策** ——
    // 它不是能力边界，是一段没人读的声明。
    //
    // **二、任何「对齐」规则都在拒真实扩展，而不是在挡坏扩展。**
    // 实测本机 27 个有 commands 的扩展：
    //   - 15 个没有 `onCommand:`（它们的 onLanguage:/workspaceContains: 我们不实现）；
    //   - 10 个有 `onCommand:`，**10 个都不含第一条命令**。
    // 如果我按「至少一条 onCommand 指向已声明命令」放宽（卡上的方案 A），
    // 仍会拒掉 9/10；按「必须含第一条」（方案 B）拒掉 10/10。
    // **一条让 100% 真实输入失败的规则，挡不住坏扩展，只挡住用户。**
    //
    // **三、它想防的「静默失效」已经由别的机制说了。** 见下面 `ignoredContributions`
    // 里的 `top-level:activationEvents` —— 用户会收到「本宿主不实现这些激活条件」。
    // 那比安装失败更准确：安装失败只能告诉他「装不上」，说不清「哪部分不工作」。
    //
    // ⚠️ **这条和 F011 的判据一致，不冲突。** F011 说「静默失效比装不上更坏」——
    // 而这里的失效**不是静默的**：它进了安装结果的 `ignoredContributions`，
    // 用户当场就能看到。真正的问题是「不让装」，那是另一件事。
    //
    // ⚠️ 上面 `activationEvents` 的 schema 注解里「运行时目前只认 onCommand:第一条」
    // 这句**仍然是事实**，只是现在它是「不支持，已标记」，不是「不支持，所以拒绝」。
    // 【F003】用统一常量而非字面量 —— 否则改一处忘一处，两道限额会分叉。
    // 这条错误与 `readMinimalVsix` 里那条**不同消息**：那个说「压缩包里的声明的多大」，
    // 这个说「解出来交给运行时的源码多长」，排查时指向不同的层。
    if (source.length > SOURCE_LIMIT) {
      // 【F016 补】这道**正常路径走不到**（`readMinimalVsix` 已在 `:607` 先拦），
      // 所以它一直是裸 `Error`。但「走不到」不是「不会走到」—— 谁改了读取顺序，
      // 它就成了一道没有 code 的漏网，而机器侧又分不出类型。
      // 带 code 是零成本的：同一个 code，只是多一层保险。
      throw new VsixRejectError(
        "VSIX_REJECT_TOO_LARGE",
        "VSIX entry exceeds the L1 source limit (" + SOURCE_LIMIT + " B)",
      );
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
    // 【F015】每条命令的 title 都要进清单 —— 但**只有能过 `slot: "command"` 正则的**。
    //
    // ## 那个正则不是我们定的，是契约里本来就有的
    //
    // `ModuleContributionSchema` 的 `slot: "command"` 变体要求：
    //   /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$/
    //
    // 它**允许大写和点**（`rainbow-csv.CSVLint`、`vscode-containers.compose.down` 都过），
    // 但**首段不许有连字符**。实测本机 884 条真实命令：
    //   - **439 条（49.7%）能过** —— 包括 rainbow-csv 全部 24 条；
    //   - 418 条卡在首段连字符（`latex-workshop.hostPort` 这类）；
    //   - 27 条卡在别处。
    //
    // ## 为什么用这个 slot 而不是 `files.context`
    //
    // `files.context` 的 `id` 是 `LocalId`（`^[a-z][a-z0-9-]*$`）—— **不许大写、不许点**，
    // **884 条命令一条都过不了**（连第一条都过不了；现在它能显示 title 是因为 id 被
    // 硬编码成 `"run"`，命令 id 根本没进那个字段）。
    //
    // 所以每条命令的 title 只能走 `slot: "command"`。**过不了正则的那些，如实不列**
    // —— 不截断、不哈希、不塞假 id。用户看不到它们，但它们**也没有被伪装成能用**。
    //
    // ⚠️ **`contributions` 上限是 12**（`ModuleManifestSchema`），所以最多列 11 条
    // （第 1 条留给 `run`）。这不是我们选的数字，是契约的；超出的命令**不列**，
    // 但它们仍然在 `DECLARED` 白名单里（能注册）。回写区会记这笔账。
    const COMMAND_SLOT_ID = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$/;
    /** `contributions` 上限 12，第 1 条是 `run`，所以命令最多 11 条 —— 契约决定的，不是我们选的。 */
    const MAX_COMMAND_CONTRIBUTIONS = 11;
    // ⚠️ 从**第 2 条**开始 —— 第 1 条已经由上面那个 `run` 贡献承载了 title。
    // 否则第一条会被列两次（实测过一次：titles 变成 ["Alpha","Alpha","Beta","Gamma"]）。
    const extraContributions = pkg.contributes.commands
      .slice(1)
      .filter((c) => COMMAND_SLOT_ID.test(c.command))
      .slice(0, MAX_COMMAND_CONTRIBUTIONS)
      .map((c) => ({
        id: ("cmd-" + c.command.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 59).replace(/-+$/, ""),
        slot: "command" as const,
        command: c.command,
        capability: "module.run",
        title: {
          zh: c.category ? c.category + ": " + c.title : c.title,
          en: c.category ? c.category + ": " + c.title : c.title,
        },
      }));

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
      }, ...extraContributions],
      program: { source: childProgram(source, declaredCommands, commandId, l2 ? {
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
    //
    // 【F014】顶层的行为类字段也进这里 —— 它们同样「接受了但不生效」：
    // `browser`（web 版入口）、`capabilities`（信任声明）等。
    // 单独第一组，因为它们的**位置不同**（顶层而不是 contributes 里），
    // 用 `top-level:` 前缀标出来，让 UI/日志能说清是哪一层。
    const fromContributes: IgnoredContribution[] = Object.keys(
      (pkg.contributes ?? {}) as Record<string, unknown>,
    )
      .map((section): IgnoredContribution | null => {
        const kind = classifyContribution(section);
        return kind === "declarative" || kind === "runtime" ? { section, kind } : null;
      })
      .filter((x): x is IgnoredContribution => x !== null);

    /**
     * 【F014】`activationEvents` 是否**真的有东西不生效**。
     *
     * 不能见到这个字段就标记 —— 那会把「本宿主恰好满足它」的清单误报成有问题。
     * 只有下面两种情形，声明才**部分落空**：
     *
     *   - 声明了 `onCommand:<不是第一条>`：那条命令本宿主不激活；
     *   - 声明了任何**非 `onCommand:`** 的事件（`onLanguage:` / `workspaceContains:`
     *     / `onStartupFinished`…）：本宿主没有这些触发源，一条都不实现。
     *
     * 而 `["onCommand:<第一条命令>"]`（最常见的最小形态）**恰好就是本宿主的激活路径**，
     * 标记它属于误报 —— 用户会收到一条「有不工作的部分」警告，而实际上没有。
     * `activationEvents: []` 同理：没有声明任何条件，就没有东西落空。
     *
     * **误报比漏报更容易被发现，但这条最坏**：假警告会让用户学会忽略所有警告，
     * 连带把真警告（`menus` / `configuration`）一起忽略掉。
     */
    const activationEventsUnmet = (() => {
      const declared = (pkg as Record<string, unknown>).activationEvents;
      if (!Array.isArray(declared)) return false;
      return declared.some((e) => e !== "onCommand:" + commandId);
    })();

    const fromTopLevel: IgnoredContribution[] = Object.keys(pkg as Record<string, unknown>)
      .filter((k) => (TOP_LEVEL_BEHAVIOURAL as readonly string[]).includes(k))
      .filter((k) => k !== "activationEvents" || activationEventsUnmet)
      .map((section): IgnoredContribution => ({ section: "top-level:" + section, kind: "runtime" }));

    const ignoredContributions: IgnoredContribution[] = [...fromContributes, ...fromTopLevel];

    return new VscodeL1Bridge(host, moduleId, commandId, declaredCommands, JSON.stringify(checked.manifest), ignoredContributions, l2);
  }

  /** Prevent a stale adapter from targeting a replaced same-ID extension. */
  private isCurrent(): boolean {
    const installed = this.host.catalog().modules.find(module => module.id === this.moduleId);
    return installed !== undefined && JSON.stringify(installed) === this.installedManifest;
  }

  /** One real ModuleHost invoke (authorization, cancellation and child process); no side-channel execution. */
  async executeCommand(commandId: string, resource: ModuleResource, requestId: string): Promise<ModuleReply> {
    // 【F014】错误信息要说清「哪条命令能跑」—— 卡上的验收判据 5。
    //
    // 从前的 `"Undeclared VS Code command"` 对真实扩展是**误导的**：
    // rainbow-csv 的 24 条命令里有 23 条会走到这里，而那个措辞会让人以为
    // 「扩展声明错了命令」，实际是「本宿主只激活第一条」。
    // `activationEvents` 的校验撤掉之后（见上面那段注释），**这条信息是用户唯一
    // 能知道「为什么点了没反应」的地方**，所以它必须点名那条能跑的命令。
    // 【F015】三种情形必须能分开 —— 这是本卡验收判据 4。
    //
    //   ① 已声明、且是第一条     → 走下去（能跑）
    //   ② 已声明、但不是第一条   → 拒，说清「声明过，但本宿主只跑第一条」
    //   ③ 根本没声明             → 拒，说清「不在 contributes.commands 里」
    //
    // 从前这三条里 ② 和 ③ 都被合并成一句 "Undeclared VS Code command" ——
    // 那对 ② 是**事实错误**的（它明明声明过），会让人去查一件没发生的事。
    if (commandId !== this.commandId) {
      const declaredHere = this.declaredCommands.includes(commandId);
      throw Error(declaredHere
        ? "VS Code command '" + commandId + "' is declared, but this host only runs the first one ('" +
          this.commandId + "') — it can register but cannot be invoked"
        : "VS Code command '" + commandId + "' is not activated in this host — " +
          "only the first declared command ('" + this.commandId + "') is invokable");
    }
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
