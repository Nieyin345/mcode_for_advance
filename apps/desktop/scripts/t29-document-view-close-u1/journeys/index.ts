/**
 * T29 —— 旅程注册表（`electron-u1/build.mjs --registry=`），覆盖五个 vendor 编辑器关闭保护。
 *
 * 复用 T7 的 `editorSetup(kind)`（同一份 harness / 生产宿主 / 真 vendor 视图），
 * 外加两件本套件自己的端口：
 *
 *  1. **确定性消息框**（`dialog-port.ts`）：脏视图关闭时 vendor 的
 *     `request*Close` 弹「保存 / 放弃 / 取消」，这里换成可编程应答并记录调用；
 *  2. **生产关闭守卫的装配**：T7 的 harness 不调用生产 `ipc/index.ts`，所以
 *     它没有 `setVendorCloseGuard` —— 这正是 T7 看到旧缺陷的原因之一。
 *     本套件在 harness 装配后注入**与生产同一份**的转发
 *     （`genofficeNativeVendor.ts` 的 `requestNativeViewClose`），并把
 *     `setup` 包一层，让每条旅程都能从 runtime 拿到 dialog 端口。
 *
 * 注意：本模块会被**普通 Node**（build.mjs 读旅程名）与**真 Electron** 两种进程
 * 加载 —— 顶层不 import 任何 `electron`。dialog 端口与 vendor 转发都在
 * `app.whenReady()` 之后的 setup 里惰性 require。
 */
import type { U1SetupContext, U1SetupResult } from "../../electron-u1/driver/index.js";
import type { DialogPort } from "../dialog-port.js";

interface T29Runtime {
  harness: import("../../t7-genoffice-u1/harness.js").GenofficeHarness;
  fixtures: import("../../t7-genoffice-u1/fixtures.js").FixturePaths;
  kind: "pdf" | "markdown" | "html" | "sheets" | "slides";
  docId: string;
  webContentsId: number;
  /** 本进程的确定性消息框端口（断言「关闭前确实弹过三选一」）。 */
  dialog: DialogPort;
}

/**
 * 把 T7 的 `editorSetup(kind)` 包成 T29 版本：
 *  - 装 dialog 端口；
 *  - 给生产宿主补上**生产装配同一条**的 vendor 关闭守卫；
 *  - runtime 里带上 dialog 端口。
 */
function t29Setup(kind: T29Runtime["kind"]) {
  return async (ctx: U1SetupContext): Promise<U1SetupResult> => {
    // 惰性 require：本模块在普通 Node 下只被读名字，不能触发 electron 导入。
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { installDialogPort } = require("../dialog-port.js") as typeof import("../dialog-port.js");
    const { editorSetup } = require("../../t7-genoffice-u1/editor-flow.js") as typeof import("../../t7-genoffice-u1/editor-flow.js");
    const { requestNativeViewClose } = require("@main/document/genofficeNativeVendor.js") as
      typeof import("@main/document/genofficeNativeVendor.js");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const dialogPort = installDialogPort(2 /* 默认「取消」：没人确认就不丢改动 */);
    const base = await editorSetup(kind)(ctx);
    const runtime = base.runtime as T29Runtime;
    // 生产装配（`ipc/index.ts`）做的同一件事：把关闭请求转给 vendor 的
    // `request*Close`。没有这一行，宿主对原厂编辑器 fail-closed（旧形态）。
    runtime.harness.host.setVendorCloseGuard(({ editor, webContents }) =>
      requestNativeViewClose(editor, webContents));
    runtime.dialog = dialogPort;
    return {
      pageFromView: base.pageFromView,
      runtime,
      dispose() {
        dialogPort.restore();
        base.dispose?.();
      },
    };
  };
}

interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass";
}

const KINDS = ["pdf", "markdown", "html", "sheets", "slides"] as const;
export const journeyNames = KINDS.map((kind) => `t29-close-${kind}-after-unsaved-guard`);

const loaders: Record<string, () => { t29Journeys: Array<{ name: string; launch: unknown; steps: unknown[] }> }> = {
  "t29-close-pdf-after-unsaved-guard": () => require("./close-journeys.js"),
  "t29-close-markdown-after-unsaved-guard": () => require("./close-journeys.js"),
  "t29-close-html-after-unsaved-guard": () => require("./close-journeys.js"),
  "t29-close-sheets-after-unsaved-guard": () => require("./close-journeys.js"),
  "t29-close-slides-after-unsaved-guard": () => require("./close-journeys.js"),
};

/** 旅程表：读 `steps`/`launch` 时才加载旅程模块，并把 `launch.setup` 换成
 *  T29 包装版（旅程文件里的 `editorSetup(kind)` 只管声明编辑器类型）。 */
export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const found = mod.t29Journeys.find((j) => j.name === name);
      if (!found) throw new Error(`T29: journey 模块里没有 ${name}`);
      const launch = found.launch as { setup: (ctx: U1SetupContext) => Promise<U1SetupResult> };
      const kind = /^t29-close-(pdf|markdown|html|sheets|slides)-/.exec(name)![1] as T29Runtime["kind"];
      materialized = {
        name,
        launch: { ...launch, setup: t29Setup(kind) },
        steps: found.steps,
        expect: "pass" as const,
      };
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return "pass" as const; },
  };
});

/**
 * ready 之前的特权注册 —— 与 T7 注册表、生产 `main/index.ts` 同一调用
 * （`registerGenofficeNativeScheme()` 一次注册三个 scheme）。
 */
export function beforeReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.registerGenofficeNativeScheme();
}

/** ready 之后：`genoffice-app://` 请求处理器（与生产同一条）。 */
export function afterReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.installGenofficeNativeProtocol();
}
