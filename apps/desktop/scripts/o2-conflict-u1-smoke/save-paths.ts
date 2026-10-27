/**
 * O2 —— **保存路径归类**（静态断言，不跑 Electron）。
 *
 * 总控要的那个区分（决定修复卡多大）：
 *
 *   - **A 类** 保存请求里**带了**版本参数，但 host 没校验 → 修 host（中等）；
 *   - **B 类** 请求里**压根没有**版本参数，但 host 是唯一写盘者 → 补参数 + 校验（改桥，简单）；
 *   - **C 类** 保存**完全绕过** Mcode 的 host，vendor 主进程自己写盘 → 要么在
 *     Mcode 侧包住那条通道，要么动 vendor（最大）。
 *
 * ## 为什么用静态断言而不是只看一次 grep
 *
 * 这个归类是**下一张卡的工作量判据**。它必须能被重复回答、并且在源码漂移时
 * **自己红** —— 否则下一个人读到的就是一张过期的手抄结论（CLAUDE.md 第五/七条）。
 *
 * 判据只读三处源码，且每条都锚在**只有它才有的原文**上：
 *   1. host 的 `saveOpenedFile`（带 CAS 的唯一实现）的**调用点**有几个；
 *   2. 四条格式保存通道的 handler **由谁注册**（vendor 内部 vs Mcode）；
 *   3. 四条请求类型里有没有版本字段。
 *
 * 这不是「跑一遍看看」，是**结论的机器化**：路径一变，这里红，卡就得重核。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 仓库根。**不用 `__dirname`**：本模块会被 esbuild 打进 journeys bundle
 * （`__dirname` 变成构建目录）也可能被单独打包（变成临时目录）——
 * 两种情况下相对路径都不指向仓库。
 *
 * 【2026-10-27 修复】**也不能写死 `cwd/../..`。**
 *
 * 从前这里假定 cwd 一定是 `apps/desktop`（`run.mjs` 早期版本如此）。而
 * `run.sh` 现在按 T145 的规矩从**仓库根**调用，于是 `cwd/../..` 落到了
 * `work_space/`（不是仓库根）：
 *
 *     O2 save-paths: 读不到 D:\...\work_space\apps\desktop\src\...\documentViewHost.ts
 *
 * 报错文本说"根路径假设不成立"—— 它是对的，但那个假设本身就不该在。
 *
 * 现在：从 cwd **向上逐级找** `packages/contracts/src/ipc/rpcMap.ts` 这个标志
 * 文件。从哪个目录调用都行，找不到才报错（仍然 fail-closed，不静默读别处的
 * 同名文件）。
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "packages", "contracts", "src", "ipc", "rpcMap.ts"))
      && existsSync(join(dir, "apps", "desktop", "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到盘符根了
    dir = parent;
  }
  throw new Error(
    `O2 save-paths: 从 cwd=${process.cwd()} 向上找不到仓库根`
    + `（标志：packages/contracts/src/ipc/rpcMap.ts + apps/desktop/package.json）`,
  );
}
const REPO = findRepoRoot();

function read(relative: string): string {
  const absolute = join(REPO, relative);
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    throw new Error(`O2 save-paths: 读不到 ${absolute}（cwd=${process.cwd()}，repo=${REPO}）—— 归类的根路径假设不成立`);
  }
}

export interface PathClassification {
  format: "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";
  klass: "host-cas" | "vendor-own-guard" | "bypass";
  /** 判据的原文证据（红的时候这就是全部线索）。 */
  evidence: string;
}

export interface ClassificationReport {
  ok: boolean;
  /** host 上带 CAS 的保存实现的调用点数量（应为 1：只有 docs 的 preload 通道）。 */
  hostSaveCallers: number;
  perFormat: PathClassification[];
  detail?: string;
}

/**
 * 归类。**预期**（2026-10-24 实测结论的机器化）：
 *   docs   → host-cas（`mcode:document-view:save` → `saveOpenedFile`）
 *   sheets → vendor-own-guard（`workbook:save` 自己比 `session.sha256`）
 *   slides / pdf / markdown / html → bypass（vendor handler 自己写盘，Mcode 无拦截）
 */
export function classifySavePaths(): ClassificationReport {
  const failures: string[] = [];
  const perFormat: PathClassification[] = [];

  // ── 1) host 的带 CAS 保存实现，只有一个调用点 ──
  const host = read("apps/desktop/src/main/document/documentViewHost.ts");
  const ipc = read("apps/desktop/src/main/ipc/documentView.ts");
  const callers = ipc.split("host.saveOpenedFile(").length - 1;
  if (callers !== 1) failures.push(`host.saveOpenedFile 在 Mcode IPC 层的调用点应为 1，实际 ${callers}`);
  // 实现本身必须仍在（否则归类全塌）。
  if (!host.includes("if (current !== expected)")) {
    failures.push("documentViewHost.ts 里找不到版本比较 `if (current !== expected)` —— CAS 实现变了");
  }

  // ── 2) 四条 vendor 通道：handler 由 vendor 自己的 register*Ipc 注册 ──
  const vendorHandlers: Array<{ format: PathClassification["format"]; file: string; anchor: string; registerFn: string }> = [
    { format: "pdf", file: "genoffice/apps/pdf/src/main/pdf-main.ts", anchor: "ipcMain.handle(PDF_CHANNELS.save,", registerFn: "function registerPdfIpc()" },
    { format: "markdown", file: "genoffice/apps/markdown/src/main/markdown-main.ts", anchor: "MARKDOWN_CHANNELS.save,", registerFn: "function registerMarkdownIpc()" },
    { format: "html", file: "genoffice/apps/html/src/main/html-main.ts", anchor: "HTML_CHANNELS.save,", registerFn: "function registerHtmlIpc()" },
    { format: "slides", file: "genoffice/apps/slides/src/main/slides-main.ts", anchor: "ipcMain.handle('slides:save',", registerFn: "export function registerSlidesIpc()" },
  ];

  // Mcode 侧有没有包过这四条通道（装了记录器/拦截就必须在这里出现；现在是**没有**）。
  const mcodeSaved = read("apps/desktop/src/main/ipc/documentView.ts")
    + read("apps/desktop/src/main/document/genofficeNativeVendor.ts")
    + read("apps/desktop/src/main/ipc/index.ts");

  for (const v of vendorHandlers) {
    const source = read(v.file);
    const hasHandler = source.includes(v.anchor);
    const hasRegister = source.includes(v.registerFn);
    const wrappedByMcode = mcodeSaved.includes(v.anchor.replace("ipcMain.handle(", "").replace(",", ""));
    if (!hasHandler) { failures.push(`${v.format}: 找不到保存 handler 原文 ${v.anchor}`); continue; }
    if (!hasRegister) failures.push(`${v.format}: 找不到 ${v.registerFn} —— 注册点变了，归类需重核`);
    if (wrappedByMcode) {
      failures.push(`${v.format}: Mcode 侧现在出现了对该通道的引用 —— 归类可能已从 bypass 改变，请重核`);
      continue;
    }
    perFormat.push({
      format: v.format,
      klass: "bypass",
      evidence: `${v.file} 的 ${v.anchor} 由 vendor 自己的 ${v.registerFn} 注册；Mcode 的 ipc/documentView.ts + genofficeNativeVendor.ts + ipc/index.ts 里没有它的拦截`,
    });
  }

  // ── 3) 请求类型里有没有版本字段（A/B/C 的外侧判据）──
  const requestShapes: Array<{ format: PathClassification["format"]; file: string; iface: string }> = [
    { format: "pdf", file: "genoffice/apps/pdf/src/shared/ipc.ts", iface: "export interface SavePdfRequest" },
    { format: "markdown", file: "genoffice/apps/markdown/src/shared/ipc.ts", iface: "export interface SaveMarkdownRequest" },
    { format: "html", file: "genoffice/apps/html/src/shared/ipc.ts", iface: "export interface SaveHtmlRequest" },
  ];
  for (const shape of requestShapes) {
    const source = read(shape.file);
    const at = source.indexOf(shape.iface);
    if (at < 0) { failures.push(`${shape.format}: 找不到 ${shape.iface}`); continue; }
    const block = source.slice(at, source.indexOf("}", at) + 1);
    if (/revision|expectedVersion|sha256|etag/i.test(block)) {
      failures.push(`${shape.format}: 请求类型里出现了版本字段 —— 归类从 bypass 变成「带了但没校验」，请重核`);
    }
  }

  // ── 4) 四个保存调用点的守卫接线还在吗（O10 的核心接线）──
  //
  // 这不是「守卫有效」的判据（那要跑 Electron，由 O2 的 4a/4b 覆盖），
  // 是「接线还在」的判据：有人删了一处 `guardedDocumentSave`，O9 的静默覆盖
  // 就会在那个格式上回来，而运行时判据只会在**恰好跑到那个格式**时才红。
  //
  // 锚点用 `format: '<kind>'` —— 本机实测在各自文件里**恰好出现 1 次**
  // （`grep -c "format: 'html'"` 等），是只有那个守卫调用点才有的原文。
  // 锚点不唯一时断言会「因为别处还在」而绿，与没写一样，所以先数数量。
  const guardSites: Array<{ format: string; file: string }> = [
    { format: "html", file: "genoffice/apps/html/src/main/html-main.ts" },
    { format: "markdown", file: "genoffice/apps/markdown/src/main/markdown-main.ts" },
    { format: "pdf", file: "genoffice/apps/pdf/src/main/save-pdf.ts" },
    { format: "slides", file: "genoffice/apps/slides/src/main/slides-main.ts" },
  ];
  for (const site of guardSites) {
    const source = read(site.file);
    const anchor = `format: '${site.format}'`;
    const count = source.split(anchor).length - 1;
    if (count !== 1) {
      failures.push(
        `${site.format}: 守卫调用点锚点 \`${anchor}\` 在 ${site.file} 里出现 ${count} 次（应为 1）—— 接线被删/改名，或锚点不再唯一`,
      );
    }
    if (!source.includes("guardedDocumentSave(")) {
      failures.push(`${site.format}: ${site.file} 里找不到 guardedDocumentSave( —— 保存没走守卫`);
    }
  }

  perFormat.push({
    format: "docs",
    klass: "host-cas",
    evidence: "mcode:document-view:save → host.saveOpenedFile：withOsFileLease 内重算 fileContentVersion 与 expected 比较（documentViewHost.ts）",
  });
  const sheetsMain = read("genoffice/apps/sheets/src/main/sheets-main.ts");
  if (!sheetsMain.includes("currentSha !== session.sha256")) {
    failures.push("sheets: 找不到 `currentSha !== session.sha256` —— 它自己的版本判据变了");
  }
  perFormat.push({
    format: "sheets",
    klass: "vendor-own-guard",
    evidence: "workbook:save 的保存 handler 自己 `sha256File(session.path)` 与 `session.sha256` 比较，不一致抛 errDiskChanged（sheets-main.ts）",
  });

  return {
    ok: failures.length === 0,
    hostSaveCallers: callers,
    perFormat: perFormat.sort((a, b) => a.format.localeCompare(b.format)),
    ...(failures.length === 0 ? {} : { detail: failures.join("；") }),
  };
}
