/**
 * T16 示例旅程 2 —— 文件副作用：临时 mcode.db 副本 + 临时文档 → 改内容 → 保存
 * → **真重开进程** → 断言改动还在。
 *
 * 这条证明骨架能验「保存」这类最容易假绿的行为：
 *
 *  1. 真 Electron 主进程初始化**真数据库**（`initDb()`，dataRoot 指针指向
 *     `mktemp` 出来的数据根），并建一个指向临时项目目录的项目行 —— 这是
 *     `file:writeFile` 的路径守卫（pathGuard）放行的前提；
 *  2. 页面用**产品真 preload**（`src/preload/index.ts` 构建产物）→ `window.api`
 *     → `ipcRenderer.invoke("file:writeFile")` → 真 `registerFileHandlers`
 *     （mkdir + 跨进程租约 + CAS + 原子替换）；
 *  3. `relaunch` 步骤 `app.exit(77)` —— 启动器换一个**新 OS 进程**，同一 runDir /
 *     同一数据根；新进程先自检「重开前写进去的项目行还在库里」，再读文件；
 *  4. `sideEffect` 断言：sha256 变了、内容是新值；重开后的读取仍拿到新值。
 *
 * 页面是旅程自带的最小页（真 App 在 journey-2 会拖入聊天运行时，与持久化判据无关）；
 * 它只做两件事：代用户点「保存」按钮（按钮 handler 调 `window.api.file.writeFile`），
 * 以及把读回的文本挂到 DOM 供断言。按钮点击仍由 runner 用真鼠标事件派发。
 */
import { defineU1Journey, step } from "../driver/index.js";

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
<title>U1 save journey</title></head>
<body>
  <p id="status">ready</p>
  <button id="save">保存</button>
  <pre id="out"></pre>
<script>
  // 目标文件由启动器经查询串传入（file://…?doc=<absolute path>）。
  const doc = new URLSearchParams(location.search).get('doc');
  const out = document.getElementById('out');
  const status = document.getElementById('status');
  document.getElementById('save').addEventListener('click', async () => {
    status.textContent = 'saving';
    try {
      // 第一步：读回当前内容做 CAS（产品编辑器的同一条链：readFile → 改 → writeFile(expectedVersion)）。
      const read = await window.api.file.readFile({ filePath: doc });
      const next = read.content.replace('alpha', 'beta');
      const written = await window.api.file.writeFile({ filePath: doc, content: next, expectedVersion: read.version ?? undefined });
      status.textContent = written.ok ? 'saved' : 'save-failed:' + JSON.stringify(written);
      // 回读验证：磁盘上的字节经产品通道读回。
      const after = await window.api.file.readFile({ filePath: doc });
      out.textContent = after.content;
    } catch (err) {
      status.textContent = 'error:' + String(err);
    }
  });
  // 重开后的第二趟：页面只负责把文件读回挂到 DOM。
  if (new URLSearchParams(location.search).get('phase') === 'reopen') {
    window.api.file.readFile({ filePath: doc }).then((r) => {
      out.textContent = r.content;
      status.textContent = 'reopened';
    }).catch((err) => { status.textContent = 'error:' + String(err); });
  }
</script>
</body></html>`;

export const fileSideEffect = defineU1Journey({
  name: "file-save-relaunch-persistence",
  launch: {
    page: { file: "file-save.html" },
    preload: "product",
    useRealDb: true,
    assertions: { dom: true, visual: true, sideEffect: true },
  },
  steps: [
    step.waitFor("#save", "save-page-ready"),
    step.recordSideEffect("@doc", "doc-before"),
    step.assertSideEffect("@doc", { contains: "U1 alpha" }, "doc-starts-alpha"),
    step.assertSideEffect("@db", { exists: true }, "db-exists-before-save"),

    // 真鼠标点「保存」：handler 走真 preload → 真 IPC → 真文件写入。
    step.click("#save", "click-save"),
    step.waitFor("#status", "save-settled", { text: "saved", timeoutMs: 15_000 }),
    step.screenshot("saved"),
    step.assertDom("#out", { textContains: "U1 beta" }, "ui-reads-back-beta"),

    // 磁盘事实（不靠页面自报）：文件真的变了。
    step.assertSideEffect("@doc", { sha256ChangedFrom: "doc-before", contains: "U1 beta", notContains: "U1 alpha" }, "disk-doc-rewritten"),
    // mcode.db：生成 1 里 initDb + ProjectRepo.create 已把它落盘（persistNowOrThrow）。
    // 重开后「项目行还在」由 runner 在新进程里直接读库自检（db-reopen-project-row 证据）；
    // 页面对文档的读取也要过 pathGuard（它查的正是重开后的项目行），见下面 assertDom。
    step.assertSideEffect("@db", { exists: true }, "db-exists-after-save"),

    // ★ 真重开：进程退出，启动器换新进程继续。
    step.relaunch("relaunch-after-save"),

    // 新进程第一件事由 runner 做（读库里的项目行，见 db-reopen-project-row 证据）。
    step.waitFor("#status", "reopen-page-ready", { text: "reopened", timeoutMs: 30_000 }),
    // 改动的持久化断言：文件与库都不因重开而回退。
    step.assertSideEffect("@doc", { contains: "U1 beta", notContains: "U1 alpha" }, "doc-still-beta-after-reopen"),
    step.assertSideEffect("@db", { exists: true }, "db-still-exists-after-reopen"),
    step.assertDom("#out", { textContains: "U1 beta" }, "ui-reads-beta-after-reopen"),
    step.screenshot("reopened"),
  ],
});
