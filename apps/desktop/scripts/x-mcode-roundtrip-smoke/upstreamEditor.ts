/**
 * T28 —— **把真实的 Node-RED 5.0.8 editor-client `nodes.js` 装进 Node `vm` 里跑**。
 *
 * ## 为什么用真上游源码，而不是重写一份"等价"的序列化
 *
 * T8 缺陷 2 的机制是「上游只导出 `_def.defaults` 里的键」。如果本套件自己再写一遍
 * "只抄 defaults"的逻辑，那个复刻品会**跟着我们的理解一起错**：上游哪天改了
 * `convertNode` 的字段集合，复刻品照样绿。所以这里直接 `vm.runInContext` 加载
 * `node-red/packages/node_modules/@node-red/editor-client/src/js/nodes.js` 的原文
 * （就是编辑器页面真正执行的那一份），只给最小 DOM/jQuery 桩 —— 断言因此把**上游的
 * 实际行为**钉住，而不是把我们的假设钉住。
 *
 * ## 桩的边界（刻意窄）
 *
 * `nodes.js` 顶层只定义 `RED.nodes = (function(){...})()`，不碰 DOM；导入/导出路径里
 * 只在**冲突提示**（`$("<ul>")…`）与几条 `RED.events`/`RED.workspaces` 通知上用到外部
 * 对象。本文件给出"足够让这两条路径跑完"的最小面：
 *
 *   - `$` 是一个可链式调用的空对象工厂（冲突路径会拼 error message，不会真的插 DOM）；
 *   - `RED.events` 是真的事件表（节点 HTML 里的 `registerType` 依赖它广播）；
 *   - `RED.workspaces` 只记录 `add/refresh`（`importNodes` 会调）。
 *
 * 任何**超出这些桩**的上游调用都会抛 —— 那正是我们要的：不静默跳过，显式报出来。
 *
 * ## 节点 HTML 的执行方式与编辑器一致
 *
 * `@node-red/editor-client/src/js/red.js` 的 `appendConfig()` 把节点 `.html` 拆出
 * `<script type="text/javascript">` 块，**逐个在页面上下文里执行**。这里用同一规则
 * 抽取并 `vm.runInContext`，因此「注册脚本写的东西」与「真正编辑器里注册出来的东西」
 * 是同一个执行语义。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";

/** 一个最简可链式 jQuery 桩：任何方法返回自身，`length = 0`。 */
function chainable(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const noop = (): unknown => self;
  for (const name of [
    "attr", "val", "prop", "on", "appendTo", "append", "text", "removeClass", "addClass",
    "hasClass", "show", "hide", "trigger", "css", "data", "each", "html", "insertBefore",
    "prependTo", "children", "find", "remove", "parent", "closest", "is", "toggleClass",
    "slideDown", "slideUp", "slideToggle", "animate", "offset", "width", "height", "focus",
    "blur", "click", "keydown", "keyup", "outerHeight", "position", "scrollTop", "get",
  ]) self[name] = noop;
  self["length"] = 0;
  return self;
}

export interface UpstreamEditor {
  /** 页面上下文里的 `RED` 对象（真上游的 `RED.nodes` 就在它上面）。 */
  RED: {
    nodes: {
      registerType: (type: string, def: Record<string, unknown>) => void;
      getType: (type: string) => Record<string, unknown> | undefined;
      addNodeSet: (set: Record<string, unknown>) => void;
      addWorkspace: (ws: Record<string, unknown>) => void;
      add: (node: Record<string, unknown>) => Record<string, unknown>;
      import: (nodes: unknown, options?: Record<string, unknown>) => { nodes: Array<Record<string, unknown>> };
      createCompleteNodeSet: (opts?: Record<string, unknown>) => Array<Record<string, unknown>>;
      workspace: (id: string) => Record<string, unknown> | undefined;
      node: (id: string) => Record<string, unknown> | undefined;
      eachNode: (cb: (n: Record<string, unknown>) => void) => void;
      dirty: (d?: boolean) => unknown;
    };
    workspaces: {
      show: (id: string) => void;
      active: () => string | number;
      refresh: () => void;
    };
  };
  /** 在页面上下文里执行一段脚本（编辑器执行节点 HTML 的 `<script>` 时用的同一种）。 */
  runScript: (source: string, filename: string) => void;
  /** 抽取 HTML 里所有 `<script type="text/javascript">` 块并按序执行（= `appendConfig`）。 */
  runNodeHtml: (html: string, filename: string) => void;
  /** 页面上下文里 globals（`console` 已被替换为可检查的收集器）。 */
  logs: { errors: string[]; warns: string[] };
}

/** 从仓库根找 vendor 的真实 `nodes.js`（缺失 → 调用方显式 SKIP，不是假绿）。 */
export function upstreamNodesJsPath(repoRoot: string): string {
  return join(repoRoot, "node-red", "packages", "node_modules", "@node-red", "editor-client", "src", "js", "nodes.js");
}

/**
 * 把真上游 `nodes.js` 装进一个新的 vm 上下文。
 *
 * @param sourcePath 真 `nodes.js` 的绝对路径（由 {@link upstreamNodesJsPath} 给出）
 */
export function createUpstreamEditor(sourcePath: string): UpstreamEditor {
  const source = readFileSync(sourcePath, "utf8");
  const logs = { errors: [] as string[], warns: [] as string[] };
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const workspacesAdds: string[] = [];

  const $ = (): ReturnType<typeof chainable> => chainable();
  ($ as unknown as Record<string, unknown>)["extend"] = Object.assign;
  ($ as unknown as Record<string, unknown>)["isEmptyObject"] =
    (value: unknown): boolean => value === null || typeof value !== "object" || Object.keys(value as object).length === 0;

  const RED: Record<string, unknown> = {
    nodes: null,
    settings: {
      theme: (): boolean => false,
      get: (): undefined => undefined,
      nodeDefaults: undefined,
      apiRootUrl: "",
    },
    events: {
      on: (evt: string, fn: (...args: unknown[]) => void): void => {
        const list = handlers.get(evt) ?? [];
        list.push(fn);
        handlers.set(evt, list);
      },
      off: (evt: string, fn: (...args: unknown[]) => void): void => {
        const list = handlers.get(evt);
        if (list === undefined) return;
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      emit: (evt: string, ...args: unknown[]): void => {
        for (const fn of [...(handlers.get(evt) ?? [])]) fn(...args);
      },
    },
    // `RED._` 在冲突提示里拼消息；给稳定可读的 key 即可（本套件不解析提示文字）。
    _: (key: string, opts?: Record<string, unknown>): string =>
      typeof opts === "object" && opts !== null && typeof opts["defaultValue"] === "string"
        ? (opts["defaultValue"] as string)
        : key,
    log: {
      info: (): void => undefined,
      warn: (message: string): void => { logs.warns.push(String(message)); },
      error: (message: string): void => { logs.errors.push(String(message)); },
    },
    notify: (message: unknown, kind?: unknown): { close: () => void } => {
      if (kind === "error") logs.errors.push(String(message));
      else logs.warns.push(String(message));
      return { close: (): void => undefined };
    },
    workspaces: {
      add: (ws: Record<string, unknown>): void => { if (typeof ws["id"] === "string") workspacesAdds.push(ws["id"]); },
      refresh: (): void => undefined,
      remove: (): void => undefined,
      active: (): number => 0,
      contains: (): boolean => true,
      isLocked: (): boolean => false,
      addTab: (): void => undefined,
    },
    editor: {
      validateNode: (node: Record<string, unknown>): boolean => { node["valid"] = true; return true; },
    },
    actions: { invoke: (): void => undefined, add: (): void => undefined },
    utils: {
      sanitize: (value: unknown): string => String(value),
      getPaletteLabel: (): string => "",
      getNodeColor: (): string => "",
      getNodeIcon: (): { module: string; file: string } => ({ module: "", file: "" }),
      createIconElement: (): void => undefined,
      clearNodeColorCache: (): void => undefined,
      getDefaultNodeIcon: (): { module: string; file: string } => ({ module: "", file: "" }),
    },
    text: { bidi: { prepareInput: (): void => undefined }, format: { getHtml: (): string => "", attach: (): void => undefined } },
    popover: { create: (): Record<string, unknown> => ({ close: (): void => undefined }) },
    view: {
      redraw: (): void => undefined,
      selection: (): { nodes: unknown[] } => ({ nodes: [] }),
      calculateNodeDimensions: (): [number, number] => [0, 0],
      getActiveGroup: (): null => null,
      getGroupAtPoint: (): null => null,
    },
    history: { push: (): void => undefined },
    palette: { refresh: (): void => undefined },
    subflow: { removeSubflow: (): void => undefined, subflow: (): undefined => undefined },
    group: { def: undefined, markDirty: (): void => undefined, removeFromGroup: (): void => undefined },
    sidebar: { config: { refresh: (): void => undefined }, info: { refresh: (): void => undefined } },
  };
  const consoleStub = {
    log: (): void => undefined,
    warn: (message: unknown): void => { logs.warns.push(String(message)); },
    error: (message: unknown): void => { logs.errors.push(String(message)); },
    info: (): void => undefined,
  };
  const sandbox: Record<string, unknown> = {
    RED,
    console: consoleStub,
    $,
    jQuery: $,
    localStorage: { getItem: (): null => null, setItem: (): void => undefined },
    setTimeout: (fn: () => void): void => { fn(); },
    clearTimeout: (): void => undefined,
    document: {
      getElementById: (): null => null,
      createElement: (): Record<string, unknown> => ({ className: "" }),
      querySelector: (): null => null,
      querySelectorAll: (): unknown[] => [],
    },
  };
  sandbox["window"] = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: sourcePath });

  const nodes = RED["nodes"] as UpstreamEditor["RED"]["nodes"] | null;
  if (nodes === null || typeof nodes.registerType !== "function" || typeof nodes.createCompleteNodeSet !== "function") {
    throw new Error("T28: 上游 nodes.js 没有暴露预期的 RED.nodes 面（升级后本套件必须先更新）");
  }

  const runScript = (script: string, filename: string): void => {
    vm.runInContext(script, context, { filename });
  };

  return {
    RED: RED as unknown as UpstreamEditor["RED"],
    runScript,
    runNodeHtml: (html: string, filename: string): void => {
      // 与 `red.js` 的 `appendConfig` 同一条抽取规则：只执行 JS 块，其余（模板/帮助）忽略。
      const blocks = [...html.matchAll(/<script\b[^>]*type="text\/javascript"[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((match) => match[1] ?? "");
      blocks.forEach((block, index) => runScript(block, `${filename}#script-${index + 1}`));
    },
    logs,
  };
}

/**
 * 模拟 runtime 通过 `GET /nodes` 交付的 node set 列表里的**一项**。
 *
 * `RED.nodes.registerType` 只接受**已经出现在某个 node set 的 `types` 里**的类型
 * （否则报 `palette.event.unknownNodeRegistered` 并**丢弃整个定义** —— 见
 * `nodes.js` 的 `registerNodeType`）。生产里这份清单来自
 * `<userDir>/mcode-node-pack/package.json` 的 `node-red.nodes`；本套件用同样的形状。
 */
export function addNodeSet(editor: UpstreamEditor, types: readonly string[]): void {
  editor.RED.nodes.addNodeSet({
    id: "mcode-node-pack",
    module: "mcode-node-pack",
    name: "mcode-node-pack",
    version: "2.0.0",
    local: true,
    added: false,
    enabled: true,
    types: [...types],
  });
}

/** 便捷：加载真上游模块并做一次 require 完整性检查（`node-red` 在仓库里时才可用）。 */
export function requireUpstreamAvailable(repoRoot: string): string | null {
  const path = upstreamNodesJsPath(repoRoot);
  try {
    readFileSync(path, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * vendor 里核心节点（inject/watch/switch/function/exec）的 **真上游 HTML**。
 * 只给编辑器侧「注册定义」用到的那一小段面补桩：表单控件、typedInput 校验器、
 * 模块允许列表 —— 这些在无 DOM 的 vm 里只需要"存在且可调"。
 */
export const UPSTREAM_CORE_HTML: ReadonlyArray<{ type: string; path: string }> = [
  { type: "inject", path: "common/20-inject.html" },
  { type: "watch", path: "storage/23-watch.html" },
  { type: "switch", path: "function/10-switch.html" },
  { type: "function", path: "function/10-function.html" },
  { type: "exec", path: "function/90-exec.html" },
];

/** 核心节点 HTML 里注册定义以外的编辑器 API 桩（无 DOM 环境的最小面）。 */
const EDITOR_STUB_SCRIPT = `
  RED.validators = {
    number: function () { return function () { return true; }; },
    typedInput: function () { return function () { return true; }; },
  };
  RED.utils.parseContextKey = function () { return {}; };
  RED.utils.validateTypedProperty = function () { return ""; };
  RED.utils.validatePropertyExpression = function () { return true; };
  RED.utils.parseModuleList = function () { return []; };
  RED.utils.checkModuleAllowed = function () { return true; };
  RED.settings.functionTimeout = RED.settings.functionTimeout || 0;
  RED.settings.functionExternalModules = false;
  RED.actions = RED.actions || { invoke: function () {}, add: function () {} };
  RED.actions.invoke = RED.actions.invoke || function () {};
  RED.library = RED.library || { create: function () { return {}; } };
  RED.popover.tooltip = function () {};
  RED.tabs = RED.tabs || { create: function () { return {}; } };
  RED.tray = RED.tray || { resize: function () {} };
  RED.editor.editJavaScript = function () {};
  RED.editor.createEditor = function () { return { refresh: function () {}, resize: function () {} }; };
`;

/**
 * 在 vm 里执行**真上游核心节点 HTML**，返回实际注册到的类型名列表。
 * 缺一件资产就显式抛（调用方据此把该类型记成"上游未提供"，不静默漏测）。
 *
 * `deferTypes` 里的类型不在这里注册 —— 调用方先跑节点包脚本、再调一次本函数，
 * 用来验证 `registry:node-type-added` 这条晚注册路径在**真上游事件**上真的生效。
 */
export function loadUpstreamCoreNodes(
  editor: UpstreamEditor,
  repoRoot: string,
  options: { types?: readonly string[] } = {},
): string[] {
  const wanted = new Set(options.types ?? UPSTREAM_CORE_HTML.map((entry) => entry.type));
  if (wanted.size === 0) return [];
  editor.runScript(EDITOR_STUB_SCRIPT, "t28-editor-stubs.js");
  const coreRoot = join(repoRoot, "node-red", "packages", "node_modules", "@node-red", "nodes", "core");
  const registered: string[] = [];
  for (const entry of UPSTREAM_CORE_HTML) {
    if (!wanted.has(entry.type)) continue;
    const path = join(coreRoot, ...entry.path.split("/"));
    editor.runNodeHtml(readFileSync(path, "utf8"), path);
    registered.push(entry.type);
  }
  return registered;
}

/** `node-red` 在仓库里时取它的版本（证据里写清楚验的是哪一版）。 */
export function upstreamVersion(repoRoot: string): string | null {
  try {
    const requireFromRepo = createRequire(join(repoRoot, "package.json"));
    const packageJson = requireFromRepo("node-red/packages/node_modules/node-red/package.json") as { version?: string };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    try {
      const raw = readFileSync(join(repoRoot, "node-red", "packages", "node_modules", "node-red", "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      return null;
    }
  }
}
