/**
 * T16 —— 真 Electron U1 旅程骨架的**类型契约**。
 *
 * 这一层只描述数据形状，不碰 Electron / 磁盘。执行侧在 `runner.ts`（在真 Electron
 * 主进程里跑的探针 bundle），构建与进程编排在 `build.mjs`（普通 Node 启动器）。
 * 后续任务卡（T7 GenOffice、T8 Node-RED、ARC-005 V4）import `driver/index.ts`
 * 的 `defineU1Journey` / `step`，并提供一条 registry 条目，就得到「启动真 Electron
 * → 声明式步骤 → 每步留证」的全部能力。
 *
 * ## 与 ARC-005 visual baseline 的边界（写死）
 *
 * `arc005-visual-baseline` 验证「某个 DOM 在某个 viewport 下长什么样」：摆好 39 个
 * 场景、拍 PNG + JSON、诚实标注 fixture 类型。它**不操作用户手势、不重开进程、
 * 不断言副作用**，也没有「旅程 PASS/FAIL」的概念。
 *
 * 本骨架验证「用户点 A → 输入 B → 看到 C → 保存 → 重开还在」：真 BrowserWindow、
 * 真 `capturePage()`、真 `webContents.sendInputEvent` 点击、真 `insertText` 键入、
 * 真 OS 子进程重开。截图只是每步证据之一，判据是 `dom` / `visual` / `sideEffect`
 * 三档断言。**禁止**拿 arc005 的 fixture 截图冒充 U1 旅程证据。
 */

/** 断言分档。三种都能按步骤单独开关：某一步声明了哪种断言就跑哪种。 */
export type U1AssertionKind = "dom" | "visual" | "sideEffect";

/**
 * 一步的证据单元。字段与任务卡「每步都有证据」逐项对应。
 * 失败时同样落盘（`status:"FAIL"` + `detail` 带实际值）。
 */
export interface U1Evidence {
  journey: string;
  /** 步骤名（`step.*` 的 `name`，缺省 `NN:<op>`）。 */
  step: string;
  /** 动作描述（click/type/relaunch …）；纯断言步骤写断言操作名。 */
  action: string;
  /** 断言描述；纯动作步骤为 null。 */
  assertion: string | null;
  kind: U1AssertionKind | "action";
  status: "PASS" | "FAIL";
  /** 断言实际观察值（PASS 时也记录，便于复核）。 */
  observed?: unknown;
  /** 失败原因（实际值 / 期望值 / 抛错栈）。PASS 时省略。 */
  detail?: unknown;
  /** 该档断言被关闭（`launch.assertions.<kind> = false`）：只取证不断言。
   *  `observed.actualStatus` 记录真实结果，status 恒 PASS。 */
  skipped?: boolean;
  /** 该步截图（相对证据根目录），无截图时 null。 */
  screenshot: string | null;
  /** DOM 快照摘要（title/url/可见文本摘要/节点数/HTML 哈希）；完整 HTML 另存。 */
  domSnapshot: unknown | null;
  /** ISO 时间戳。 */
  at: string;
  /** 本步所在 Electron 进程的 PID（重开后变化 = 真换进程）。 */
  pid: number;
  /** 第几代进程（1 起）。 */
  generation: number;
  durationMs?: number;
}

/** `launch` 配置：一切路径由启动器 mktemp/mkdir 出来，绝不碰真实用户数据根。 */
export interface U1LaunchOptions {
  /**
   * 旅程页面来源：
   * - `"bundle"`：本套件 `build.mjs` 打的真 App bundle（`build/page.html`）；
   * - `{ file: string }`：build 目录内的页面文件名（可带 `@` 前缀 → 构建期模板）。
   */
  page?: "bundle" | { file: string };
  /** BrowserWindow 尺寸；默认 1280×800。 */
  size?: { width: number; height: number };
  /**
   * preload：
   * - `"product"`：加载**真实** `src/preload/index.ts` 的 bundle（真 contextBridge
   *   白名单 → 真 IPC 通道）；
   * - `"none"`（默认）：页面自带脚本（如 journey-1 的 api-stub）。
   */
  preload?: "product" | "none";
  /**
   * 是否初始化**真实主进程数据库**（`initDb()` + 真实 `ProjectRepo`，落在启动器的
   * mktemp 数据根）。journey-2 用它证明「保存 → 重开 → 还在」走的是真持久化。
   */
  useRealDb?: boolean;
  /** 每一步默认等待上限，默认 10s。 */
  defaultTimeoutMs?: number;
  /**
   * 三档断言的独立开关（缺省全开）。关掉的档**仍然执行并记录实际结果**
   *（`observed.actualStatus`），但永不判 FAIL、证据标 `skipped: true` ——
   * 即「只取证不断言」。这是任务卡要求的「每种都能单独开关」。
   */
  assertions?: { dom?: boolean; visual?: boolean; sideEffect?: boolean };
}

/**
 * 一步 = { 动作, 等待, 断言, 证据 }。声明式：不写 Electron 样板。
 * 所有 `step.*` 工厂只返回数据，不执行；执行在 `runner.ts` 统一做。
 *
 * 路径占位：`file` / 页面字段里的 `@doc` / `@db` / `@projectDir` 由 runner 用
 * 启动器传入的环境变量解析（旅程文件因此不硬编码任何临时路径）。
 */
interface StepBase {
  /** 可选步骤名（证据与 failBecause 用它定位）。 */
  name?: string;
}

export type U1Step = StepBase &
  (
    | { op: "navigate"; url: string }
    | { op: "click"; selector: string; text?: string; button?: "left" | "right" }
    | { op: "type"; selector: string; text: string; clear?: boolean }
    | { op: "press"; key: string; modifiers?: Array<"shift" | "control" | "alt"> }
    | { op: "waitFor"; selector: string; text?: string; timeoutMs?: number }
    | { op: "waitForGone"; selector: string; timeoutMs?: number }
    | { op: "sleep"; ms: number }
    | { op: "eval"; expression: string }
    | {
        op: "assertDom";
        selector: string;
        /** `false` = 断言元素**不存在**（与 `count:0` 同义但更直白）。默认 true。 */
        exists?: boolean;
        text?: string;
        textContains?: string;
        count?: number;
        /** 默认 true：只把「真正可见」（client rects > 0）的命中当候选。 */
        visible?: boolean;
        attribute?: { name: string; value?: string };
        timeoutMs?: number;
      }
    | { op: "assertEvaluated"; expression: string; expected: unknown; timeoutMs?: number }
    | { op: "screenshot"; shot: string }
    /** visual 档：本次截图必须与早先命名的截图**字节不同**（界面真的变了）。 */
    | { op: "assertScreenshotChanged"; shot: string; baseline: string }
    /** sideEffect 档：记录文件当前 sha256 + 字节数，供后续对比。 */
    | { op: "recordSideEffect"; file: string; key?: string }    /** sideEffect 档：直接断言磁盘事实。 */
    | {
        op: "assertSideEffect";
        file: string;
        exists?: boolean;
        sha256ChangedFrom?: string;
        sha256Equals?: string;
        contains?: string;
        notContains?: string;
      }
    /** 关闭当前 Electron 进程并真正重开一个新的（同一 runDir/数据根）。 */
    | { op: "relaunch"; reason?: string }
  );

/** `recordSideEffect` 的落盘快照（跨重开保存在 state.json 里）。 */
export interface SideEffectRecord {
  path: string;
  sha256: string | null;
  bytes: number | null;
  at: string;
}

export interface U1Journey {
  name: string;
  /** `"pass"`（默认）：任何步骤 FAIL 即旅程失败。`"fail"`：旅程**必须**失败，
   * 且必须命中 `failBecause` —— 这是「故意失败」示例旅程的自检钩子，防止把
   * 「骨架自己崩了」当成预期失败。 */
  expect?: "pass" | "fail";
  failBecause?: (evidence: U1Evidence[]) => boolean;
  launch?: U1LaunchOptions;
  steps: U1Step[];
}

export interface U1JourneyResult {
  name: string;
  expect: "pass" | "fail";
  /** 步骤的字面结果：是否所有步骤 PASS。**变异验证看这个字段**（红→绿）。 */
  literalStatus: "PASS" | "FAIL";
  /** 按声明判定的结论：expect:"pass" 要看 literalStatus；expect:"fail" 要看
   * literalStatus 为 FAIL 且 failBecause 成立。 */
  status: "PASS" | "FAIL";
  expectation: "all-pass" | "expected-failure" | "unexpected-failure";
  reason?: string;
  /** 真正失败的那一步（无失败则 null）。 */
  failedStep: string | null;
  steps: U1Evidence[];
  evidenceDir: string;
  durationMs: number;
  /** 真实 OS 进程数（relaunch 次数 + 1）。 */
  generations: number;
  /** 每一代进程的 PID（证明重开不是「同进程刷新」）。 */
  pids: number[];
}

/** 启动器 → 探针的运行时配置（全部来自环境变量，见 build.mjs）。 */
export interface U1GenerationConfig {
  journeyIndex: number;
  evidenceDir: string;
  buildDir: string;
  runDir: string;
  generation: number;
  stepOffset: number;
  stateFile: string;
}
