/**
 * F023: the Theia extension host actually boots on Windows, a real extension
 * runs end to end, and the install-time permission report distinguishes
 * extensions that spawn processes from ones that don't.
 *
 * ## What this suite is allowed to claim
 *
 * - The host **process** starts and the MessagePack handshake completes
 *   (`$init` answered). The transport is `stdio[4]` with `'overlapped'` —
 *   the shape `vendor/theia/.../hosted-plugin-process.js:130` says Windows needs.
 * - An extension's `activate()` runs, its commands reach the parent's command
 *   table, a command invoked **from the parent** executes **in the extension**
 *   and its **return value comes back**.
 * - `window.activeTextEditor` is driven by an explicit editors-and-documents
 *   delta, and is `null` (not `{}`) when nothing is open.
 * - The permission report is a **static lower bound**: it says "at least these",
 *   never "only these".
 *
 * ## What it deliberately does NOT cover (printed every run — see NOT-COVERED)
 *
 * `TextEditor.edit` / undo stack (F024); most `workspace`/`window` APIs (F025+);
 * runtime sandboxing (the user chose install-time disclosure, not isolation).
 *
 * ## Fixtures vs. the real extension
 *
 * The five assertions run against **synthetic fixtures** (`fixtures/*`) so the
 * suite does not depend on which extensions happen to be installed on the
 * machine. `THEIA_SMOKE_REAL_EXT` may point at a real extension directory; when
 * set, one extra group reports how far that extension gets. That group is
 * informational — a real extension exhausting an unimplemented API is a
 * `NOT-COVERED` boundary, not a regression.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TheiaHost, TheiaHostError } from "@main/modules/theiaHost/host.js";
import { prepareTheiaEdits } from "@main/modules/theiaHost/editorTransactions.js";
import { buildExtensionPermissionReport } from "@main/modules/theiaPermissionReport.js";
import { buildInstallConsentPrompt, decideInstall } from "@main/modules/theiaHost/installConsent.js";

// ⚠️ **不能用 `import.meta.url` 推仓库根**：esbuild 打包后它指向**输出文件**
// （`/tmp/mcode-theia-host-boot.XXXX/smoke.mjs`），于是 `../../../../vendor/theia`
// 会算到 `C:\Users\Nieyin\vendor\theia` —— 一个不存在的路径，而 skip 分支会把它
// 当成「CI 里没取 vendor」，**静默跳过、退出 0**。这正是「套件启动前退出看起来像
// 全绿」那一类。所以根路径由 `run.sh` 用环境变量**显式传进来**，缺了就直接报错。
const REPO_ROOT = process.env.MCODE_SMOKE_REPO_ROOT;
const HERE = process.env.MCODE_SMOKE_SUITE_DIR;
if (!REPO_ROOT || !HERE) {
  console.error(
    "theia-host-boot-smoke: MCODE_SMOKE_REPO_ROOT / MCODE_SMOKE_SUITE_DIR 没设 —— 请通过 run.sh 运行，不要直接 node 这个文件。",
  );
  process.exit(2);
}
const THEIA_ROOT = process.env.MCODE_SMOKE_THEIA_ROOT || path.join(REPO_ROOT, "vendor", "theia");
const FIXTURES = path.join(HERE, "fixtures");

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function skip(name: string, why: string): void {
  total++;
  console.log(`  skip ${name} (${why})`);
}

const NOT_COVERED = [
  "NOT-COVERED: 真实 Monaco undo/redo UI（F025，F024 仅验证 owner 事务回调）",
  "NOT-COVERED: workspace 与 window 的大部分 API（F025+）",
  "NOT-COVERED: 运行时沙箱 —— 用户选择了安装时告知，不是隔离",
];

/** 临时目录：宿主的 logs / workspace-storage / global-storage 写在这里，**不落用户数据根**。 */
function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "mcode-f023-"));
}

async function main(): Promise<void> {
  console.log("theia-host-boot-smoke: F023");
  for (const line of NOT_COVERED) console.log(line);

  /* ── 前置：地基在不在 ──────────────────────────────────────────── */
  const hostJs = path.join(THEIA_ROOT, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
  const vscodeInit = path.join(THEIA_ROOT, "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js");
  if (!existsSync(hostJs) || !existsSync(vscodeInit)) {
    // F024: missing build prerequisites are a HARD ERROR, not a green 0/0 skip.
    console.error(`theia-host-boot-smoke: BUILD_REQUIRED — 缺 ${!existsSync(hostJs) ? hostJs : vscodeInit}`);
    console.error("先构建 vendor/theia 的 plugin-ext 和 plugin-ext-vscode；本次没有运行任何测试。");
    process.exitCode = 2;
    return;
  }

  /* ── 第 1 组：宿主能起来 + 失败要有明确错误 ─────────────────────── */
  console.log("\n[1] 宿主启动与握手");
  const storage1 = tempRoot();
  const host = new TheiaHost({
    theiaRoot: THEIA_ROOT,
    extensionDir: path.join(FIXTURES, "spawn-ext"),
    storageRoot: storage1,
    onLog: () => undefined,
  });
  try {
    await host.start();
    check("宿主进程启动且 MessagePack 握手完成（$init 有应答）", true);
  } catch (e) {
    check("宿主进程启动且 MessagePack 握手完成（$init 有应答）", false, e instanceof Error ? e.message : e);
    await host.dispose();
    rmSync(storage1, { recursive: true, force: true });
    console.log(`theia-host-boot-smoke: ${total - failures}/${total} 通过`);
    for (const line of NOT_COVERED) console.log(line);
    process.exit(1);
  }

  // 失败路径必须带自己的 code —— “起不来”和“起来但扩展崩了”要能分开
  const bogusStorage = tempRoot();
  const bogus = new TheiaHost({
    theiaRoot: THEIA_ROOT,
    extensionDir: path.join(bogusStorage, "no-such-extension"),
    storageRoot: bogusStorage,
    onLog: () => undefined,
  });
  const bogusOutcome = await bogus
    .start()
    .then(() => ({ ok: true as const }))
    .catch((e: unknown) => ({ ok: false as const, error: e }));
  check(
    "扩展目录不存在时抛出带 code 的明确错误（不是超时/不是静默）",
    botom(bogusOutcome) === "extension-manifest-invalid",
    botom(bogusOutcome),
  );
  await bogus.dispose();
  rmSync(bogusStorage, { recursive: true, force: true });

  /* ── 第 2 组：真实扩展端到端（五步） ──────────────────────────── */
  console.log("\n[2] 端到端：五步逐步断言");
  let handle;
  try {
    handle = await host.activate();
  } catch (e) {
    check("扩展 activate() 跑通", false, e instanceof Error ? e.message : e);
  }
  if (handle) {
    // 步骤 1：宿主读到了 package.json（id 来自清单）
    check("步骤 1：宿主读到了扩展清单（id = publisher.name）", handle.id === "mcode-smoke.spawn-ext", handle.id);
    // 步骤 2：activate() 没崩（能走到这里就是没崩；再把激活错误显式数一遍）
    check("步骤 2：activate() 跑完且没有未捕获异常", handle.activationErrors.length === 0, handle.activationErrors.map((e) => e.message.slice(0, 120)));
    // 步骤 3：命令出现在命令表里。
    // **判据钉在具体命令上，不钉在「表非空」上** —— 「表里有东西」在只注册了一条
    // 无关命令时也成立。变异 M4（登记后立刻删掉）证明过：只写 `length > 0`
    // 会让它红得比预期少。
    const commands = await handle.commands();
    check("步骤 3：扩展注册的命令进了命令表", commands.includes("mcodeSmoke.spawnEcho"), commands.slice(0, 6));
    // 负控：清单声明了但没注册的命令**不该**出现 —— 否则“出现在表里”是假的
    check(
      "步骤 3 负控：只在 package.json 声明、没有 registerCommand 的命令不出现在表里",
      !commands.includes("mcodeSmoke.declaredOnly"),
      commands,
    );
    // 步骤 4 + 5：从 Mcode 侧调用 → 扩展执行 → 返回值回到 Mcode 侧
    const result = await handle
      .executeCommand<{ echo: string; greeting: string; appName: string; active: unknown }>("mcodeSmoke.spawnEcho")
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    const value = result as { echo?: string; greeting?: string; appName?: string; error?: string };
    check("步骤 4：从 Mcode 侧调用，扩展侧真的执行了（子进程 stdout 回到这里）", value.echo === "pong", value);
    // **第 4 步的「注册」判据也要有**：能调用 ≠ 在表里。
    // 一个只删了父进程镜像、宿主侧 handler 还在的实现，能过第 4 步但第 3 步该红；
    // 反过来，宿主侧 handler 没了但镜像还在的实现，第 3 步绿、这里该红。
    // 两条合起来才排除了「假装注册成功」。
    check(
      "步骤 4b：能调用的命令也在命令表里（不是绕过表直接调 handler）",
      commands.includes("mcodeSmoke.spawnEcho"),
      { inTable: commands.includes("mcodeSmoke.spawnEcho"), callWorked: value.echo === "pong" },
    );
    check("步骤 5：返回值跨进程回到 Mcode 侧（对象字段完整）", value.appName === "Mcode", value);
    check(
      "步骤 5b：清单里的配置默认值被送进了宿主（getConfiguration 拿到 default）",
      value.greeting === "hello-from-manifest-default",
      value.greeting,
    );
    // 未知命令要明确失败
    const unknown = await handle.executeCommand("nope.not.a.command").then(
      () => "resolved",
      () => "rejected",
    );
    check("未知命令被明确拒绝（不是静默成功）", unknown === "rejected", unknown);
  }

  /* ── 第 3 组：activeTextEditor（只读） ─────────────────────────── */
  console.log("\n[3] activeTextEditor：读与受控编辑事务");
  if (handle) {
    const bridge = host.editors();
    const before = await bridge.activeTextEditor();
    // 负控：没有编辑器时必须是 null，不是 {}、不是抛错
    check("负控：没有打开编辑器时返回 null（不是 {}、不是抛错）", before === null, before);
    check("负控：没有编辑器时 visibleTextEditors 为空数组", (await bridge.visibleTextEditors()).length === 0);

    const file = path.join(storage1, "paper.tex");
    writeFileSync(file, "line-1\nline-2\nline-3\n", "utf8");
    const text = "line-1\nline-2\nline-3";
    await bridge.setActive({
      filePath: file,
      languageId: "latex",
      text,
      selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } },
    });
    const active = await bridge.activeTextEditor();
    // 正控：内容逐字节一致
    check("正控：activeTextEditor 读到预先写死的内容", active?.text === text, active?.text?.length);
    check("正控：selection 是 0-based 且与传入一致", active?.selection?.start.line === 1 && active?.selection?.end.character === 4, active?.selection);
    check("正控：visibleTextEditors 至少包含当前这一个", (await bridge.visibleTextEditors()).length === 1);
    // 从扩展侧读一次 —— 证明这不是我们自己的缓存，而是宿主里那份文档
    if (handle) {
      const extView = await handle
        .executeCommand<{ active: string | null }>("mcodeSmoke.spawnEcho")
        .then((v) => v.active)
        .catch(() => "ERR");
      check("宿主侧 vscode.window.activeTextEditor 读到同一份内容", extView === text, extView);
    }

    // F024: no real editor owner => extension edits MUST fail rather than pretend success.
    const noOwner = await handle.executeCommand<boolean>("mcodeSmoke.editActive", "X").catch(() => "ERR");
    check("没有真实编辑器写入回调时 edit 返回 false（不能假成功）", noOwner === false, noOwner);
    check("拒绝写入后文本不变", (await bridge.activeTextEditor())?.text === text);

    const history: string[] = [];
    const commits: string[] = [];
    let ownerText = text;
    await bridge.setActive({
      filePath: file,
      languageId: "latex",
      text,
      applyEdits: async transaction => {
        if (transaction.beforeText !== ownerText || transaction.filePath !== file) return false;
        history.push(ownerText); // this synthetic owner models a single undo group
        ownerText = transaction.afterText;
        commits.push(`${transaction.version}:${transaction.undoStopBefore}:${transaction.undoStopAfter}`);
        return true;
      },
    });
    const applied = await handle.executeCommand<boolean>("mcodeSmoke.editActive", "NEW");
    check("Theia TextEditor.edit 获得真实 editor-owner 的确认", applied === true, applied);
    check("写入确实到达编辑器 owner 且不是仅修改宿主缓存", ownerText === "NEW\nline-2\nline-3", ownerText);
    check("宿主侧文档事件更新后读取的是新文本", (await handle.executeCommand<{active: string}>("mcodeSmoke.spawnEcho")).active === ownerText);
    check("事务携带版本与 undoStop 边界", commits.length === 1 && commits[0] === "1:true:true", commits);
    check("模拟 owner 记录了可撤销的原始文本", history[0] === text);

    const overlap = await handle.executeCommand<boolean>("mcodeSmoke.overlapEdit").then(
      v => ({ ok: true, value: v }), e => ({ ok: false, error: String(e) })
    );
    check("重叠范围被拒绝且不触碰 editor owner", !overlap.ok || ("value" in overlap && overlap.value === false), overlap);
    check("重叠编辑拒绝后文本与历史不变", ownerText === "NEW\nline-2\nline-3" && commits.length === 1);
    // Fail-closed on a refused editor transaction.
    await bridge.setActive({ filePath: file, languageId: "latex", text, applyEdits: async () => false });
    const declined = await handle.executeCommand<boolean>("mcodeSmoke.editActive", "NOT-APPLIED");
    check("编辑器拒绝事务时扩展得到 false", declined === false, declined);
    check("编辑器拒绝事务时文档不更新", (await bridge.activeTextEditor())?.text === text);
    await bridge.setActive(null);
    check("关闭后 activeTextEditor 回到 null", (await bridge.activeTextEditor()) === null);
  }

  /* ── F024: 编辑事务纯函数边界 / 不依赖真实宿主状态 ───────────────── */
  console.log("\n[3b] 编辑事务：多范围、UTF-16、非法输入");
  const opts = { undoStopBefore: true, undoStopAfter: true };
  const multi = prepareTheiaEdits("a😀b\nsecond", [
    { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 }, text: "X" },
    { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 }, text: "last" },
  ], opts);
  check("多范围原子应用，emoji 按 UTF-16 列处理", multi?.text === "aXb\nlast", multi);
  check("变更从末尾倒序，原文本偏移有效", multi?.changes[0]?.rangeOffset === 5 && multi?.changes[1]?.rangeOffset === 1, multi?.changes);
  const overlapEdits = prepareTheiaEdits("abcdef", [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: "X" },
    { range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 5 }, text: "Y" },
  ], opts);
  check("纯事务：重叠范围全拒，不部分应用", overlapEdits === null);
  check("纯事务：越界坐标拒绝", prepareTheiaEdits("a", [
    { range: { startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 2 }, text: "Z" },
  ], opts) === null);
  check("纯事务：明确改变 EOL 尚未适配则拒绝", prepareTheiaEdits("a", [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: "Z" },
  ], { ...opts, setEndOfLine: 2 }) === null);

  /* ── 第 4 组：权限报告（正控 + 负控） ─────────────────────────── */
  console.log("\n[4] 安装时的权限报告（静态下限）");
  const spawnReport = await buildExtensionPermissionReport(path.join(FIXTURES, "spawn-ext"));
  const cleanReport = await buildExtensionPermissionReport(path.join(FIXTURES, "clean-ext"));
  // 正控：真的 require("child_process") → true
  check("正控：require(\"child_process\") 的扩展 → spawnsProcesses: true", spawnReport.spawnsProcesses === true, spawnReport);
  // 负控：只 require("vscode") → false。**没有这一条，一个恒 true 的报告也能全绿。**
  check("负控：只 require(\"vscode\") 的扩展 → spawnsProcesses: false", cleanReport.spawnsProcesses === false, cleanReport);
  check("负控：只 require(\"vscode\") 的扩展 → network: false", cleanReport.network === false, cleanReport);
  check("正控：evidence 里有 文件:行号", spawnReport.evidence.length > 0 && spawnReport.evidence.every((e) => /:\d+$/.test(e)), spawnReport.evidence);
  check("正控：evidence 指到了 extension.js 的具体行", spawnReport.evidence.some((e) => e.includes("extension.js:")), spawnReport.evidence);
  check("confidence 恒为 static-lower-bound（不是“只有这些”）", spawnReport.confidence === "static-lower-bound");
  check("limits 里写明了漏报来源", spawnReport.limits.some((l) => l.includes("混淆")), spawnReport.limits);
  // 注释掉的 require 不算证据 —— 报告要剥注释
  const commentedDir = tempRoot();
  mkdirSync(commentedDir, { recursive: true });
  writeFileSync(path.join(commentedDir, "package.json"), JSON.stringify({ name: "commented", publisher: "p", version: "1.0.0", main: "./e.js" }));
  writeFileSync(
    path.join(commentedDir, "e.js"),
    ['"use strict";', 'const vscode = require("vscode");', '// const cp = require("child_process");', '/* const net = require("net"); */', "void vscode;"].join("\n"),
  );
  const commentedReport = await buildExtensionPermissionReport(commentedDir);
  check("负控：注释掉的 require 不算命中（剥注释后扫描）", commentedReport.spawnsProcesses === false && commentedReport.network === false, commentedReport);
  rmSync(commentedDir, { recursive: true, force: true });

  // 安装同意（任务四第 2、3 点）：问一次 → 用户点 → 装；装完不再问
  const prompt = buildInstallConsentPrompt(spawnReport);
  check("同意提示列出了起进程能力", prompt.capabilities.some((c) => c.capability === "spawnsProcesses"), prompt.capabilities.map((c) => c.capability));
  check("同意提示的 headline 明说这是下限", prompt.headline.includes("至少"), prompt.headline);
  check("同意提示带着 disclosure（不是保护，是知情同意）", prompt.disclosure.includes("知情同意"), prompt.disclosure.slice(0, 40));
  check("用户可见的 disclosure 不包含原样 Markdown 标记", !prompt.disclosure.includes("**"), prompt.disclosure);
  check("同意提示带着 evidence 出处", prompt.capabilities[0]?.evidence.length > 0, prompt.capabilities[0]);
  const cleanPrompt = buildInstallConsentPrompt(cleanReport);
  check("负控：干净扩展的提示不含起进程能力", !cleanPrompt.capabilities.some((c) => c.capability === "spawnsProcesses"), cleanPrompt.capabilities);
  check("用户同意 → install", decideInstall(prompt, true) === "install", decideInstall(prompt, true));
  check("用户拒绝 → decline（不装）", decideInstall(prompt, false) === "decline", decideInstall(prompt, false));
  check("没有报告 → needs-report（fail-closed，不是静默安装）", decideInstall(undefined, true) === "needs-report", decideInstall(undefined, true));

  /* ── 第 5 组：真实扩展（可选，信息性） ────────────────────────── */
  const realExt = process.env.THEIA_SMOKE_REAL_EXT;
  if (realExt && existsSync(realExt)) {
    console.log("\n[5] 真实扩展（信息性，不算失败）");
    const realStorage = tempRoot();
    const realHost = new TheiaHost({ theiaRoot: THEIA_ROOT, extensionDir: realExt, storageRoot: realStorage, onLog: () => undefined });
    try {
      await realHost.start();
      const real = await realHost.activate();
      console.log(`  info 真实扩展 ${real.id}：注册 ${(await real.commands()).length} 条命令，激活错误 ${real.activationErrors.length} 条`);
      for (const e of real.activationErrors.slice(0, 4)) console.log(`  info   [${e.level}] ${e.source}: ${e.message.slice(0, 160)}`);
    } catch (e) {
      console.log(`  info 真实扩展未能完整激活（${e instanceof Error ? e.message : String(e)}）—— 这是 NOT-COVERED 边界，不是失败`);
    } finally {
      await realHost.dispose();
      rmSync(realStorage, { recursive: true, force: true });
    }
  } else {
    skip("真实扩展（THEIA_SMOKE_REAL_EXT 未设置）", "只跑合成夹具");
  }

  await host.dispose();
  rmSync(storage1, { recursive: true, force: true });

  console.log(`\ntheia-host-boot-smoke: ${total - failures}/${total} 通过`);
  for (const line of NOT_COVERED) console.log(line);
  process.exit(failures === 0 ? 0 : 1);
}

function botom(o: { ok: true } | { ok: false; error: unknown }): string {
  if (o.ok) return "resolved";
  return o.error instanceof TheiaHostError ? o.error.code : o.error instanceof Error ? o.error.message : String(o.error);
}

main().catch((e) => {
  console.error("theia-host-boot-smoke crashed:", e);
  for (const line of NOT_COVERED) console.log(line);
  process.exit(1);
});
