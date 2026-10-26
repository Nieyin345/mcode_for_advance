/**
 * 端到端：真扩展 → 真 Theia 子进程 → 调 `mcode.*` → 拿到返回值。
 *
 * ## 为什么需要这套
 *
 * `ext-mcode-bridge-smoke` 验的是桥的**逻辑**（注入桩）。但「扩展真的能调 Mcode」
 * 还差三件只有真进程才能证明的事：
 *
 *  1. `$executeCommand("mcode.xxx")` 真的从**子进程**到了主进程的桥；
 *  2. 返回值真的**回过子进程**给扩展代码；
 *  3. 内置命令表（`mcode.file.*`）与 RPC 派发在真链路上都通。
 *
 * 这套用真实扩展 fixture（两个 ZIP 条目 → 解到临时目录）+ 真 `TheiaHost`。
 *
 * ## 它不验什么
 *
 * - 真实 Electron 窗口（这里是 Node 进程内的 Theia，不是渲染端）；
 * - 真实 `panelApiCall` 的权限分档（用注入的 dispatch 桩代替，那层的分档由
 *   `policy.ts` 自己的套件守）；
 * - VSIX 安装的审批流程（`theia-installed-smoke` 覆盖）。
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TheiaHost } from "@main/modules/theiaHost/host.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

const repoRoot = process.env.MCODE_SMOKE_REPO_ROOT ?? process.cwd();
// ⚠️ `MCODE_THEIA_ROOT` 优先 —— 这样同一套件既能验开发态的 `vendor/theia`，
// 也能验打包用的 `.tmp/theia-release`（`theia-staging-smoke` 产出）。
//
// 第一版没读它，于是「用 staging 跑一遍」实际跑的是 vendor/theia：
// 结论看起来对，但验的不是我以为的那个东西。
const theiaRoot = [process.env.MCODE_THEIA_ROOT, join(repoRoot, "vendor/theia"), resolve(repoRoot, "../../vendor/theia")]
  .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
  .find(candidate => {
    try { return require("node:fs").existsSync(join(candidate, "packages/plugin-ext/lib/hosted/node/plugin-host.js")); }
    catch { return false; }
  });

if (!theiaRoot) {
  console.log("  skip  vendor/theia 未构建 —— 这套需要真 Theia 运行时");
  console.log("NOT-COVERED: 真扩展 → Theia → mcode.* 的端到端（vendor/theia 缺失，本次未验证）");
  process.exitCode = 0;
} else {
  const work = mkdtempSync(join(tmpdir(), "mcode-ext-e2e-"));
  try {
    await run(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log("");
  console.log("NOT-COVERED: 真实 Electron 渲染端、真实 panelApiCall 权限分档、VSIX 安装审批（分别由 theia-installed-smoke / policy 套件 / theia-installed-smoke 覆盖）");
  console.log(`ext-mcode-e2e-smoke: ${total - failed}/${total} 通过`);
  if (failed > 0) process.exitCode = 1;
}

async function run(work: string): Promise<void> {
  /* ───────── 造一个真扩展 ───────── */
  const extensionDir = join(work, "demo-ext");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    name: "mcode-e2e",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.80.0" },
    main: "./extension.js",
    contributes: {
      commands: [
        { command: "test.mcode-e2e.call", title: "Call Mcode" },
        { command: "test.mcode-e2e.builtin", title: "Call builtin" },
      ],
    },
  }, null, 2), "utf8");

  // 扩展代码：调两条 `mcode.*`，把返回值塞进 statusBar 文本 —— 这样宿主能读到。
  writeFileSync(join(extensionDir, "extension.js"), `
const vscode = require("vscode");
exports.activate = function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("test.mcode-e2e.call", async () => {
      const bar = vscode.window.createStatusBarItem();
      try {
        const reply = await vscode.commands.executeCommand("mcode.e2e.echo", { hello: "from-extension" });
        bar.text = JSON.stringify(reply);
      } catch (error) {
        bar.text = "ERR:" + (error && error.message ? error.message : String(error));
      }
      bar.show();
      return bar.text;
    }),
    vscode.commands.registerCommand("test.mcode-e2e.builtin", async () => {
      const bar = vscode.window.createStatusBarItem();
      try {
        const reply = await vscode.commands.executeCommand("mcode.file.info", { path: ${JSON.stringify(join(extensionDir, "package.json"))} });
        bar.text = JSON.stringify(reply);
      } catch (error) {
        bar.text = "ERR:" + (error && error.message ? error.message : String(error));
      }
      bar.show();
      return bar.text;
    }),
  );
};
`, "utf8");

  /* ───────── 起真宿主 ───────── */
  const storage = join(work, "storage");
  mkdirSync(storage, { recursive: true });

  const dispatched: Array<{ method: string; input: unknown; approved: boolean }> = [];
  const host = new TheiaHost({
    theiaRoot: theiaRoot as string,
    extensionDir,
    storageRoot: storage,
    // 注入的 dispatch 桩：模拟 `panelApiCall` 的只读直通。
    mcodeDispatch: async (method, input, approved) => {
      dispatched.push({ method, input, approved });
      return { ok: true, result: { echo: method, received: input, approved } };
    },
    // 内置命令表：`mcode.file.info` 真的本地执行。
    builtinLookup: (id) => id === "mcode.file.info"
      ? {
          id,
          summary: "e2e builtin",
          run: async ({ path }: { path: string }) => ({ bytes: 12345, modifiedAt: 1, path }),
        }
      : undefined,
    knownRoot: () => true,
  });

  try {
    await host.start();
    const handle = await host.activate();
    const commands = await handle.commands();
    check("★ 扩展激活并注册了命令", commands.includes("test.mcode-e2e.call"), { commands });
    // ⚠️ 钉住「用的是我以为的那个 Theia」——
    // 否则指定 `MCODE_THEIA_ROOT=.tmp/theia-release` 时悄悄回退到 vendor/theia，
    // 结论看起来对，但验的不是那个东西。
    check("★ 用的就是指定的 Theia 检出（没有静默回退）",
      !process.env.MCODE_THEIA_ROOT || theiaRoot === process.env.MCODE_THEIA_ROOT,
      { theiaRoot, requested: process.env.MCODE_THEIA_ROOT });

    /* ───────── [1] mcode.* 真的走通 ───────── */
    console.log("[1] 扩展调 mcode.e2e.echo");
    const reply1 = await handle.executeCommand<unknown>("test.mcode-e2e.call");
    check("★ 命令执行返回", reply1 !== undefined, { reply1 });
    check("★ 主进程真的收到了 mcode.* 派发", dispatched.length === 1, { dispatched });
    check("★ 派发的 method 剥掉了前缀", dispatched[0]?.method === "e2e.echo", { dispatched });
    check("★ 入参原样到达主进程", JSON.stringify(dispatched[0]?.input) === JSON.stringify({ hello: "from-extension" }), { dispatched });
    check("★ 只读档没有带 approved", dispatched[0]?.approved === false, { dispatched });
    // 返回值回到扩展代码（statusBar 快照能读到）

    /* ───────── [2] 内置命令真的就地执行 ───────── */
    console.log("[2] 扩展调 mcode.file.info（内置）");
    const before = dispatched.length;
    const reply2 = await handle.executeCommand<unknown>("test.mcode-e2e.builtin");
    check("★ 命令执行返回", reply2 !== undefined, { reply2 });
    check("★ 内置命令**没有**落 RPC 派发", dispatched.length === before, { dispatched });
    check("★ 返回值里有内置命令算出的 bytes", String(reply2).includes("12345"), { reply2 });

    /* ───────── [3] 未知命令：报错不静默 ───────── */
    //
    // ⚠️ 这里原来断言「未知命令返回 undefined（VS Code 的宽容面）」，**那是错的**。
    // 真机实测（Theia 1.76 `command-registry.js:84`）：
    //   `Command: <id> does not exist.` — 扩展侧收到的是**拒绝**，不是 undefined。
    // 这个区别对扩展作者是要紧的：`await executeCommand("mcode.xxx")` 在方法名写错时
    // **会抛**，所以「静默返回 undefined 让你以为成功了」不是这里的行为。
    // 旧断言从没跑到过（vendor 坏了时整套 skip），所以它一直没红。
    console.log("[3] 未知命令明确报错（不是静默 undefined）");
    let unknownError: unknown = undefined;
    try { await handle.executeCommand<unknown>("latex-workshop.hostPort"); }
    catch (error) { unknownError = error; }
    check("★ 未知命令以错误拒绝，而不是返回 undefined", unknownError !== undefined, { unknownError });
    check("★ 错误信息点名了那个命令 id（扩展作者能据此修）",
      String(unknownError).includes("latex-workshop.hostPort"), { unknownError });
    check("★ 拒绝走的是 command-failed，不是超时或崩溃",
      (unknownError as { code?: string } | undefined)?.code === "command-failed" ||
      /command-failed/.test(String(unknownError)), { unknownError });

    /* ───────── [4] 桥的内部失败也不能静默 ───────── */
    //
    // `mcode.*` 的边界：**方法本身不存在**时，桥要明确报错。
    // 这与 [3] 是两件事 —— [3] 是「Theia 不认识这个命令」，
    // [4] 是「Theia 认识，但桥那边没有这个方法」。
    console.log("[4] 桥里的方法不存在时明确报错");
    const before4 = dispatched.length;
    let bridgeError: unknown = undefined;
    try {
      await handle.executeCommand<unknown>("mcode.no.such.method");
    } catch (error) { bridgeError = error; }
    check("★ 桥的方法不存在时拒绝", bridgeError !== undefined, { bridgeError });
    check("★ 没有把它当成一次成功派发", dispatched.length === before4, { dispatched });
  } finally {
    await host.dispose().catch(() => {});
  }
}
