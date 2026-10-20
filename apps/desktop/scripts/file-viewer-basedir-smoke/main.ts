/**
 * file-viewer-basedir-smoke — 【MC-086】资料库目录 linked 条目里的 Markdown，图片 baseDir
 * 必须是**该 md 文件自己**所在目录，而不是条目根的父目录。
 *
 * ## 盯的是什么
 *
 * 目录 linked 条目(Obsidian 笔记树那种)在 `FileViewer` 里翻进 `folder/docs/demo.md` 时，
 * `loadViewData` 走 `library.entryPath` 拿到的 `p.path` 是**条目根目录**(`.../folder`)。
 * 从前 `baseDir = dirname(p.path)` —— 即 `.../`(条目根的**父目录**)，于是正文里
 * `![](images/1.png)` 被解析到错误层级(目录越深越离谱)，图片裂/指向错文件。
 *
 * ## 判据
 *
 * 直接驱动 `loadViewData`(导出的纯取数函数，只依赖 `api.library.*`，无头换桩)：
 * `baseDir` 必须等于 `dirname(条目根 + relPath)` = 那份 md 自己的目录；`absPath` 与
 * `baseDir` 指向**同一个**文件源(不是两处各拼一份)。
 *
 * Run: scripts/file-viewer-basedir-smoke/run.sh
 */
import "./prelude.js";
import { joinPath, dirname } from "@renderer/lib/path.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/**
 * `api` 在 `lib/api.ts` 里是 **import 时求值一次** 的常量(`window.api ?? createWebApi()`)。
 * 所以必须在 import 组件**之前**把 `window.api` 装好,而且之后靠**改内部函数**切换行为
 * (换 `window.api` 对象没用 —— 组件已经抓住了旧引用)。
 */
const calls: Array<{ fn: string; input: unknown }> = [];
const stub = {
  library: {
    readFile: async (input: { id: string; relPath?: string; which?: string }) => {
      calls.push({ fn: "readFile", input });
      if (state.uiDirectory) {
        return input.relPath
          ? { content: { type: "binary" as const, mime: "application/pdf", base64: "JVBERi0xLjQ=" } }
          : { content: { type: "dir" as const, files: [{ name: "chapter.pdf", isDir: false }] } };
      }
      return { content: { type: "text" as const, text: "# md\n![](images/1.png)" } };
    },
    entryPath: async (input: { id: string; which?: string }) => {
      calls.push({ fn: "entryPath", input });
      return { path: state.entryRoot };
    },
    openFile: async () => ({ ok: true }),
  },
  file: {
    readFile: async () => ({ content: "# hi" }),
    readBinary: async () => ({ dataUrl: "" }),
  },
  shell: { openFile: async (_args?: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true }) },
  setting: { set: () => Promise.resolve({ ok: true }), get: () => Promise.resolve(null) },
};
const state = { entryRoot: "", uiDirectory: false };
(globalThis as Record<string, unknown>).window = { api: stub };

const { FileViewer, loadViewData } = await import("@renderer/components/library/FileViewer.js");
const { useFileViewStore, setFileOpenGuard } = await import("@renderer/stores/fileViewStore.js");
const { __mount, __render, __flush, __nodes } = await import("./fakeReact.js");

const ROOT = "D:\\lib\\my-tree"; // 条目根(linked 目录)
const currentChild = (): string | null => {
  const target = useFileViewStore.getState().target;
  return target?.source.kind === "library" ? target.source.relPath ?? null : null;
};

console.log("\n【MC-086】目录 linked 里翻进子文件 → baseDir 是 md 自己的目录");
{
  // ① 目录根下的 md:folder/demo.md → baseDir 应等于条目根
  state.entryRoot = ROOT;
  const r = await loadViewData({ source: { kind: "library", ref: "li_1" }, name: "demo.md" }, "demo.md");
  eq("① baseDir 是条目根(md 就在根下)", (r.data as { baseDir?: string }).baseDir, ROOT);
  eq("① absPath 指向那份 md", r.absPath, joinPath(ROOT, "demo.md"));

  // ② 嵌套 md:folder/docs/demo.md → baseDir 必须是 folder/docs,不是 folder 的父目录
  const r2 = await loadViewData({ source: { kind: "library", ref: "li_1" }, name: "demo.md" }, "docs/demo.md");
  eq("★ ② 嵌套 baseDir 是 md 自己所在目录(docs)", (r2.data as { baseDir?: string }).baseDir, joinPath(ROOT, "docs"));
  check("★ ② 不是条目根的父目录(旧 bug 的产物)", (r2.data as { baseDir?: string }).baseDir !== "D:\\lib", (r2.data as { baseDir?: string }).baseDir);
  const mdAbs2 = r2.absPath as string | undefined;
  eq("② absPath 与 baseDir 指向同一文件源(dirname(absPath)==baseDir)", mdAbs2 ? dirname(mdAbs2) : undefined, (r2.data as { baseDir?: string }).baseDir);

  // ③ 更深一层 → 依然跟住 md 自己
  const r3 = await loadViewData({ source: { kind: "library", ref: "li_1" }, name: "demo.md" }, "a/b/c/demo.md");
  eq("★ ③ 三层深 baseDir 仍跟住 md(a/b/c)", (r3.data as { baseDir?: string }).baseDir, joinPath(ROOT, "a/b/c"));

  // ④ 正控:项目来源(非 library)那条路用 dirname(filePath),不受本次改动影响
  const r4 = await loadViewData({ source: { kind: "project", ref: "D:\\proj\\sub\\x.md" }, name: "x.md" }, null);
  eq("④ 项目 md 的 baseDir 仍是它自己所在目录", (r4.data as { baseDir?: string }).baseDir, "D:\\proj\\sub");
}

console.log("\n【ARC-007】目录选文件和子PDF返回必须走文件预览唯一导航");
{
  state.uiDirectory = true;
  state.entryRoot = ROOT;
  const rootTarget = { source: { kind: "library" as const, ref: "linked-tree" }, name: "my-tree" };
  useFileViewStore.setState({ target: rootTarget, dirty: false });
  __mount(() => FileViewer({ target: useFileViewStore.getState().target! }));
  await __flush();
  const folderEntry = __nodes().find(n => n.type === "button" && JSON.stringify(n.props.children).includes("chapter.pdf"));
  check("directory view presents the nested child entry", typeof folderEntry?.props.onClick === "function");
  (folderEntry?.props.onClick as (() => void) | undefined)?.();
  __render(); // React's first commit for the new target, before async fetch settles
  check("★★ old directory children must not paint under a newly selected PDF target",
    !__nodes().some(n => n.type === "button" && JSON.stringify(n.props.children).includes("chapter.pdf")),
    __nodes().filter(n => n.type === "button").map(n => n.props.title ?? n.props.children));
  check("★★ clicking a directory child must make it a distinct store navigation target",
    useFileViewStore.getState().target?.source.kind === "library" &&
    currentChild() === "chapter.pdf",
    useFileViewStore.getState().target);
  // Render the navigated PDF as a real FileViewer root, then simulate an
  // unsaved vendor annotation. The child must expose a way back to its folder,
  // and back must ask the SAME dirty-confirmation owner as any other exit.
  useFileViewStore.setState({
    target: { source: { kind: "library", ref: "linked-tree", relPath: "chapter.pdf" }, name: "my-tree" },
    dirty: true,
  });
  __render();
  await __flush();
  check("nested child title is its own filename, not the library root",
    __nodes().some(n => n.type === "span" && n.props.title === "chapter.pdf"));
  const buttons = __nodes().filter(n => n.type === "button");
  const back = buttons.find(n => typeof n.props.title === "string" && typeof n.props.onClick === "function");
  check("★★ a nested PDF has an explicit return-to-parent control", typeof back?.props.onClick === "function");
  let prompted = 0;
  let resume: (() => void) | undefined;
  setFileOpenGuard((_next, proceed) => { prompted++; resume = proceed; });
  (back?.props.onClick as (() => void) | undefined)?.();
  check("★★ returning from unsaved child PDF waits for the central leave dialog",
    prompted === 1 && useFileViewStore.getState().target?.source.kind === "library" &&
    currentChild() === "chapter.pdf",
    { prompted, current: useFileViewStore.getState().target });
  resume?.();
  check("confirmed return restores directory root target, clearing child's dirty marker",
    useFileViewStore.getState().target?.source.kind === "library" &&
    currentChild() === null &&
    useFileViewStore.getState().dirty === false, useFileViewStore.getState());
  state.uiDirectory = false;
  setFileOpenGuard(null);
}
console.log("\n【ARC-005】迟到外部打开失败不能污染新的 FileViewer 目标");
{
  const projectA = { source: { kind: "project" as const, ref: "D:\\proj\\old-A.md" }, name: "old-A.md" };
  const projectB = { source: { kind: "project" as const, ref: "D:\\proj\\new-B.md" }, name: "new-B.md" };
  let resolveOld!: (result: { ok: boolean; error?: string }) => void;
  stub.shell.openFile = () => new Promise(resolve => { resolveOld = resolve; });
  useFileViewStore.setState({ target: projectA, dirty: false });
  __mount(() => FileViewer({ target: useFileViewStore.getState().target! }));
  await __flush();
  const external = __nodes().find(n => n.type === "button" &&
    typeof n.props.title === "string" && typeof n.props.onClick === "function");
  check("project file renders an external-open control", !!external);
  (external?.props.onClick as (() => void) | undefined)?.();
  useFileViewStore.getState().open(projectB);
  __render();
  await __flush();
  resolveOld({ ok: false, error: "OLD_A_ONLY_OPEN_FAILURE" });
  await __flush();
  check("★★ stale A external-open failure must not appear under B",
    !__nodes().some(n => JSON.stringify(n.props.children ?? "").includes("OLD_A_ONLY_OPEN_FAILURE")),
    { target: useFileViewStore.getState().target?.name,
      oldErrorVisible: __nodes().some(n => JSON.stringify(n.props.children ?? "").includes("OLD_A_ONLY_OPEN_FAILURE")) });
  // Even if the target remains the same, late failure of request #1 must not
  // overwrite a newer successful request #2 triggered in the same UI frame.
  let attempt = 0;
  let failFirst!: (result: { ok: boolean; error?: string }) => void;
  let succeedSecond!: (result: { ok: boolean; error?: string }) => void;
  stub.shell.openFile = () => new Promise(resolve => {
    attempt++;
    if (attempt === 1) failFirst = resolve;
    else succeedSecond = resolve;
  });
  useFileViewStore.setState({ target: projectA, dirty: false });
  __mount(() => FileViewer({ target: useFileViewStore.getState().target! }));
  await __flush();
  const trigger = __nodes().find(n => n.type === "button" &&
    typeof n.props.title === "string" && typeof n.props.onClick === "function")?.props.onClick as (() => void) | undefined;
  trigger?.(); trigger?.();
  succeedSecond({ ok: true });
  await __flush();
  failFirst({ ok: false, error: "SUPERSEDED_FIRST_LAUNCH" });
  await __flush();
  check("★★ obsolete first open must not overwrite newer successful launch",
    attempt === 2 && !__nodes().some(n => JSON.stringify(n.props.children ?? "").includes("SUPERSEDED_FIRST_LAUNCH")),
    { attempt });
  stub.shell.openFile = async () => ({ ok: true });
}
console.log(`\nfile-viewer-basedir-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
