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
   * 旅程的**主进程装配钩子**（T7 起）。在 `app.whenReady()` 之后、建窗口之前调用，
   * 拿到本代进程的运行时配置；返回值里的 `dispose` 在旅程结束/重开前调用。
   *
   * 为什么需要：GenOffice 六个编辑器都是 `WebContentsView`（不是 BrowserWindow 页），
   * 打开/保存/关闭走的是 Mcode 的 `DocumentViewHost` + vendor 主进程，而不是页面
   * 自带的 `window.api`。这类装配只能跑在主进程里；把它做成旅程文件里的一个函数，
   * 旅程仍然是声明式步骤，装配细节留在各自的 `launch.setup` 实现。
   *
   * 若钩子返回 `pageFromView`（某个 WebContents），runner 会把**该视图**当作后续
   * `step.*` 的作用对象（截图/点击/DOM 断言都落在编辑器页上，而不是宿主窗口）。
   */
  setup?: (ctx: U1SetupContext) => Promise<U1SetupResult> | U1SetupResult;
  /**
   * 不建宿主窗口（只跑 `setup` 装配出来的视图）。默认 true（普通页面旅程）。
   * 设为 false 时没有 `page.html`，所有 DOM/截图步骤作用在 `setup` 返回的视图上。
   */
  window?: boolean;
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
        /** T7：与早先 `recordSideEffect` 记录**相同**（重开后文件不该被改写）。 */
        sha256UnchangedFrom?: string;
        sha256Equals?: string;
        contains?: string;
        notContains?: string;
      }
    /** 关闭当前 Electron 进程并真正重开一个新的（同一 runDir/数据根）。 */
    | { op: "relaunch"; reason?: string }
    /** Deliberately SIGKILL the *test Electron host OS process* (no dispose/app.exit), then relaunch. */
    | { op: "crashRelaunch"; reason?: string }
    /**
     * 主进程内的一段任意装配/取证（T7 起）。`fn` 只能在**探针主进程**里跑，
     * 收到的 `runtime.setup` 就是 `launch.setup` 的返回值 —— 这样「关闭视图」
     * 「用独立解析器读回磁盘」这类动作不必伪造 DOM 事件。
     *
     * `assert: true` 时 `fn` 必须返回 `{ ok, observed?, detail? }`，结果照常进入
     * 三档判定（kind 归 `sideEffect`，因为它验的是磁盘/宿主事实）。
     */
    | { op: "run"; fn: (runtime: U1StepRuntime) => unknown; assert?: boolean }
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

/* ───────────────────── T7 追加：主进程装配钩子与 run 步骤 ───────────────────── */

/**
 * `launch.setup` 拿到的上下文。全部路径由启动器 mktemp 出来，**绝不碰真实用户数据**；
 * 同时给出宿主窗口（若 `launch.window !== false`）方便把 `WebContentsView` 挂进去。
 */
export interface U1SetupContext {
  /** 本旅程证据目录（绝对路径；截图/DOM 之外的自定义证据也写这里）。 */
  evidenceDir: string;
  /** 本代进程的工作目录（不变，跨重开一致）：`<buildDir>/run/<journey>`。 */
  runDir: string;
  /** 本次启动器为该旅程准备的项目目录（已 mkdir）。 */
  projectDir: string;
  /** 数据根（已 mkdir）。 */
  dataDir: string;
  /** 第几代进程（1 起）。重开后 setup 会**再次**被调用 —— 装配必须可重入。 */
  generation: number;
  /** 宿主窗口；`launch.window === false` 时为 null。 */
  win: import("electron").BrowserWindow | null;
}

/** `launch.setup` 的返回值。 */
export interface U1SetupResult {
  /**
   * 后续 `step.*` 要作用的 WebContents。省略时用宿主窗口的 webContents。
   * 典型用法：返回 vendor `WebContentsView.webContents` —— 截图/点击/DOM 断言
   * 就落在真实编辑器页上。
   */
  pageFromView?: import("electron").WebContents;
  /** 清理（关闭视图、释放会话）。旅程结束与 relaunch 前调用；抛错只记日志。 */
  dispose?: () => void | Promise<void>;
  /**
   * 任意运行时对象（宿主、执行器、临时路径…）。`step.run` 的 `fn` 会收到它 ——
   * 这是「用真宿主读回磁盘」这类断言不必伪造 DOM 的唯一通道。
   */
  runtime?: unknown;
}

/** `step.run` 的 `fn` 拿到的运行时。 */
export interface U1StepRuntime {
  /** 本次启动器为该旅程准备的项目目录。 */
  projectDir: string;
  /** 数据根。 */
  dataDir: string;
  /** 证据目录。 */
  evidenceDir: string;
  /** 第几代进程。 */
  generation: number;
  /** `launch.setup` 返回的 `runtime`（没有则 undefined）。 */
  runtime: unknown;
  /** 宿主窗口（`launch.window === false` 时为 null）。 */
  win: import("electron").BrowserWindow | null;
}

/** `step.run` 的 `fn` 在 `assert: true` 时必须返回的形状。 */
export interface U1RunAssertion {
  ok: boolean;
  /** 证据里记录的实际观察值（PASS 也记录）。 */
  observed?: unknown;
  /** 失败原因（人话）。 */
  detail?: unknown;
}
