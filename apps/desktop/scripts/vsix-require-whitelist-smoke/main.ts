/**
 * 【F013】`require` 白名单：从「只有 vscode」到「vscode + path + 受限 fs」。
 *
 * ## 为什么这一步是决定性的
 *
 * 27 个有 main 的真实扩展，源码大小是**断崖分布**：≤24 KiB 有 15 个，≤128 KiB
 * 还是 15 个（中间一个都没有）。**所以放宽 `extension.js` 限额做不了什么** ——
 * 放到 128 KiB 一个都多不了；放到 MB 级会放进 python(2.3MB)、powershell(2.1MB)，
 * 而**那些进来 `require` 白名单照样全拒**。
 *
 * 白名单才是那道墙。
 *
 * ## ⚠️ 一个必须先说清的事实
 *
 * `childL2Snippet` 里有 `const l2Fs = require("node:fs")`，而那段代码生成在
 * 扩展代码的 `new Function` **之外** —— 它用的是子进程的真 `require`，
 * 不受白名单约束。**那是设计使然**（L2 是宿主自己的适配层，`l2Path` 会校验
 * URI 必须等于已授权资源），但**必须写下来**，否则下一个人会以为白名单挡住了所有 fs。
 *
 * ## 这套怎么测
 *
 * **用真实扩展的代码形态**（`require("fs")` + `require("path")`），不是 hello world。
 * 扩展源在子进程里跑，所以断言要落在**返回值 / 抛错**上，不是读源码。
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import { buildZip } from "./zip.js";

// Windows 上无 OS 网络沙箱：本进程内显式接受 JS-only 降级。
//
// ⚠️ **必须在每次调用前重设，不能只在模块顶部设一次。**
// `service.ts:78` 的 `getModuleHost()` 会把 reader 重装成 `getJsOnlyEgressConsent`
// —— 只要这条路径被走到一次，顶部的设置就被覆盖了，之后所有执行都会以
// `egress_isolation_unavailable` 失败。第一版就是这么全组红的，
// 而错误信息看起来像「命令没声明」（因为套件把它包进了 UNDECLARED 那条断言）。
const allowJsOnlyEgress = (): void => { configureJsOnlyEgressConsentReader(() => true); };
allowJsOnlyEgress();

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {}, persist: async () => {}, requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm, persistModulePermissions: async (t) => { perm = t; },
  });
}

/** 造一个带**指定扩展源码**的包。源码是真实的扩展写法，不是 hello world。
 *
 * ⚠️ 命令 id 固定为 `demo.hello`（= `<name>.hello`，F008 之后合法）。
 * 第一版这里生成 `demo.hello` 而调用处写 `acme.demo.hello` —— 两个 id 不一致，
 * `executeCommand` 抛 `Undeclared VS Code command`，而套件把它误读成
 * 「白名单拒绝了某个 require」。**命令 id 只能有一处定义**，下面导出给调用处用。
 */
const COMMAND_ID = "demo.hello";

function zipWithSource(source: string, name = "demo"): Uint8Array {
  const pkg = {
    publisher: "acme", name, version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: [`onCommand:${COMMAND_ID}`],
    contributes: { commands: [{ command: COMMAND_ID, title: "Hello" }] },
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode(source) },
  ], 8);
}

/** 装 + 调一次，返回 { ok, error?, message? }。 */
async function runExtension(source: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  // 每次执行前重设 —— 见文件顶部那段注释（`getModuleHost()` 会覆盖它）。
  allowJsOnlyEgress();
  const dir = mkdtempSync(join(tmpdir(), "mcode-f013-"));
  const target = join(dir, "resource.txt");
  writeFileSync(target, "hello from the resource\n");
  try {
    const h = host();
    const bridge = await VscodeL1Bridge.install(h, zipWithSource(source), {
      confirmReadAccess: true, confirmExecutableCode: true,
    });
    const reply = await bridge.executeCommand(COMMAND_ID, { projectPath: dir, path: target }, "req-1");
    const value = (reply as { value?: { message?: unknown } }).value;
    return { ok: true, message: String(value?.message ?? "") };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("[1] 正控：只 require vscode 的扩展仍能跑");
{
  const r = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      vscode.commands.registerCommand("demo.hello", () => "ok");
    };
  `);
  check("★ 只用 vscode 的扩展跑通", r.ok, { error: r.error });
}

console.log("[2] `path` 能 require（真实扩展普遍用它）");
{
  // 真实扩展的典型写法：path.join 拼路径
  const r = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const path = require("path");
      vscode.commands.registerCommand("demo.hello", (resource) => {
        return path.basename(resource.path);
      });
    };
  `);
  check("★ require('path') 能用", r.ok, { error: r.error });
  check("★ 且 path.basename 返回了正确的文件名", r.message === "resource.txt", { message: r.message });

  const rNode = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const path = require("node:path");
      vscode.commands.registerCommand("demo.hello", (resource) => path.extname(resource.path));
    };
  `);
  check("★ require('node:path') 也能用", rNode.ok, { error: rNode.error });
}

console.log("[3] `fs` 是**受限替身**：能读已授权文件，读不了别的");
{
  // 3a: 读已授权的那个资源 —— 应当成功
  const okRead = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const fs = require("fs");
      vscode.commands.registerCommand("demo.hello", (resource) => {
        return fs.readFileSync(resource.path, "utf8").trim();
      });
    };
  `);
  check("★ 读已授权资源成功", okRead.ok, { error: okRead.error });
  check("★ 读到的内容正确", okRead.message === "hello from the resource", { message: okRead.message });

  // 3b: 读别的文件 —— 必须被拒（这是本卡的核心安全断言）
  const badRead = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const fs = require("fs");
      vscode.commands.registerCommand("demo.hello", () => {
        return fs.readFileSync("/etc/passwd", "utf8");
      });
    };
  `);
  check("★ 读未授权路径被拒", !badRead.ok, { unexpectedly: "读成功了" });
  // ⚠️ **这里有两道防线，断言必须分开**：
  //   ① 我加的 `authorizedPath()`（抛「fs denied: path is not the authorized resource」）
  //   ② 子进程的 Node `--allow-fs-read`（抛「Access to this API has been restricted」）
  //
  // 第一版只断言「拒绝理由是我那句」，变异 M2（去掉 authorizedPath）时它红了一条 ——
  // 但**读仍然是失败的**，因为 ② 还在。所以「被拒」这条一直是绿的，而
  // 「被哪道拒」变了。这正是 F009 那条「断言要落在规则生效的那一层」的同类：
  // **判据必须说清是哪一层拒的**，否则拆掉一层你看不出来。
  check(
    "★ 被**我们自己的**路径检查拒（不是只靠子进程的 --allow-fs-read）",
    !badRead.ok && /fs denied/.test(badRead.error ?? ""),
    { error: (badRead.error ?? "").slice(0, 220) },
  );
  // 并且**不能**是只靠 Node 权限系统 —— 那句说明我们的检查没生效
  check(
    "★ 且不是仅靠 Node 的 --allow-fs-read（那说明第一道没起作用）",
    !badRead.ok && !/Access to this API has been restricted/.test(badRead.error ?? ""),
    { error: (badRead.error ?? "").slice(0, 220) },
  );

  // 3c: 用 `..` 绕 —— 归一化后仍不等于授权路径，应当被拒
  const dotdot = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const fs = require("fs");
      const path = require("path");
      vscode.commands.registerCommand("demo.hello", (resource) => {
        return fs.readFileSync(path.join(resource.path, "..", "..", "etc", "passwd"), "utf8");
      });
    };
  `);
  check("★ 用 .. 绕路径被拒", !dotdot.ok, { unexpectedly: "绕过去了" });
}

console.log("[4] fsCompat **不提供**写/删（写必须走 L2 的审批路径）");
{
  const r = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const fs = require("fs");
      vscode.commands.registerCommand("demo.hello", (resource) => {
        // writeFileSync 不该存在于受限替身上
        if (typeof fs.writeFileSync === "function") return "HAS_WRITE";
        return "NO_WRITE";
      });
    };
  `);
  check("★ 受限 fs 上没有 writeFileSync", r.ok && r.message === "NO_WRITE", { message: r.message, error: r.error });

  const rmCheck = await runExtension(`
    exports.activate = (ctx) => {
      const vscode = require("vscode");
      const fs = require("fs");
      vscode.commands.registerCommand("demo.hello", () => {
        return [typeof fs.unlinkSync, typeof fs.renameSync, typeof fs.mkdirSync].join(",");
      });
    };
  `);
  check("★ 也没有 unlink/rename/mkdir", rmCheck.ok && rmCheck.message === "undefined,undefined,undefined", {
    message: rmCheck.message,
  });
}

console.log("[5] 危险模块仍被拒（白名单是枚举表，不是前缀匹配）");
{
  // 这一组是变异表第 1 条要打红的地方
  for (const mod of ["child_process", "node:child_process", "net", "node:net", "vm", "node:vm", "http", "node:http"]) {
    const r = await runExtension(`
      exports.activate = (ctx) => {
        const vscode = require("vscode");
        const m = require(${JSON.stringify(mod)});
        vscode.commands.registerCommand("demo.hello", () => "should not reach");
      };
    `);
    check(`★ require('${mod}') 被拒`, !r.ok, { unexpectedly: "放行了" });
  }
}

console.log("[6] 真实扩展的代码形态（require fs + path 一起用）");
{
  // 这是真实扩展里最常见的开头几行 —— 不是 hello world
  const realistic = `
    "use strict";
    const vscode = require("vscode");
    const fs = require("fs");
    const path = require("path");

    function readLines(p) {
      return fs.readFileSync(p, "utf8").split(/\\r?\\n/).filter(Boolean).length;
    }

    exports.activate = (ctx) => {
      ctx.subscriptions.push(
        vscode.commands.registerCommand("demo.hello", (resource) => {
          const name = path.basename(resource.path);
          return name + ": " + readLines(resource.path) + " lines";
        })
      );
    };
  `;
  const r = await runExtension(realistic);
  check("★ 真实形态（fs+path+vscode 同时 require）跑通", r.ok, { error: r.error });
  check("★ 结果正确", r.message === "resource.txt: 1 lines", { message: r.message });
}

console.log(`\nvsix-require-whitelist-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
