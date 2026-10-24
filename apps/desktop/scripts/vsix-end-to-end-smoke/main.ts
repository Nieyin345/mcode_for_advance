/**
 * 【F005】闭环五环：装 → 出现在列表 → 命令能调用 → 结果正确 → 能卸载。
 *
 * ## 两件证据，缺一不可
 *
 * **A. 真实扩展 × 真实拒绝。** `mechatroner.rainbow-csv-3.24.1` 用它自己的
 * `package.json` + `extension.js` 打包，**第一道墙是源码限额**（136 516 > 24 576）。
 * 这是「当前能力边界」的证据，不是失败。
 *
 * **B. 同构缩小版 × 五环全通。** 「同构」指：同样的 `publisher.name` 前缀、
 * 同样的 `activationEvents` 形式、同样走 **DEFLATE**、同样的两文件布局。
 * **不是随手造个最小包** —— 结构不同的包走通了，只证明「我们的格式能跑」。
 *
 * ## 第 4 环为什么让扩展去读文件数行
 *
 * 「有 value 字段」「非空字符串」都不算结果正确 —— 那种断言在扩展返回
 * `"ok"` 常量时也绿。这里让扩展真的读被授权的那个文件、数行数，
 * **而文件是我们造的、行数我们事先知道**，所以期望值不是从实现里抄的。
 *
 * ## 第 5 环的负控
 *
 * `isCurrent()` 是「卸载/替换后旧 adapter 不许再执行」的唯一防线。
 * 没有断言时，「卸载了但旧 bridge 还能调用」会静默存在 —— 而它意味着
 * 用户以为关掉了某个扩展，它的代码却还在跑。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  configureEgressConsentStoragePath,
  getJsOnlyEgressConsent,
  setJsOnlyEgressConsent,
} from "../../src/main/modules/egressConsent.js";
import { configureJsOnlyEgressConsentReader } from "../../src/main/modules/permissionedProcessRunner.js";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { VscodeL1Bridge } from "../../src/main/modules/vscodeL1Bridge.js";
import { buildZip } from "../vsix-deflate-smoke/zip.js";

let passed = 0, failed = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + label); }
  catch (error) { failed++; console.error("FAIL " + label, error); }
}

const REAL_EXT = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1");

const makeHost = (root: string) => new ModuleHost({
  authorize: async (r) => {
    if (!r.path.startsWith(root)) throw Error("scope_denied");
  },
  persist: async () => {},
  resolveResource: async (r) => r.path,
  verifyProgram: async (source, names, timeout) => {
    const { verifyPermissionedProgram } = await import("../../src/main/modules/permissionedProcessRunner.js");
    return verifyPermissionedProgram(source, names, timeout);
  },
});

/**
 * 同构缩小版：**结构照真实扩展抄**，只把两样东西缩小 ——
 * 源码体积（绕开 24 KiB）和贡献点数量（本宿主只支持 `commands`）。
 *
 * 命令名保留 `rainbow-csv.` 段，让前缀规则走**和真实扩展同一条路径**；
 * 真实扩展用的是 `rainbow-csv.CSVLint`（没有 publisher 前缀），
 * 那是另一道墙，单独断言（见 [0-B]）。
 */
const FIXTURE_PUBLISHER = "mechatroner";
const FIXTURE_NAME = "rainbow-csv-fixture";
const FIXTURE_COMMAND = `${FIXTURE_PUBLISHER}.${FIXTURE_NAME}.countLines`;

const fixtureManifest = {
  publisher: FIXTURE_PUBLISHER,
  name: FIXTURE_NAME,
  version: "3.24.1",
  displayName: "Rainbow CSV (structure-preserving fixture)",
  main: "./extension.js",
  engines: { vscode: "^1.95.0" },
  // 真实扩展声明多条，本宿主只要「含 onCommand:第一条」
  activationEvents: ["onLanguage:csv", `onCommand:${FIXTURE_COMMAND}`],
  contributes: {
    commands: [{ command: FIXTURE_COMMAND, title: "Count Lines" }],
  },
};

/**
 * 真实读文件、数行数 —— 期望值来自我们造的文件，不是从实现里抄的。
 *
 * ⚠️ **不能用 `require("node:fs")`**：子进程的 `require` 只放行 `"vscode"`
 * （`vscodeL1Bridge.ts:438` 的 `requireCompat`）。这是 F002 列的第六道墙，
 * 本卡不越过它 —— 真实扩展也确实要走 `vscode.workspace.fs` 这条路。
 */
const fixtureEntry = `
exports.activate = function (context) {
  const vscode = require("vscode");
  const status = vscode.window.createStatusBarItem();
  status.text = "fixture ready";
  status.tooltip = "counts lines";
  status.command = ${JSON.stringify(FIXTURE_COMMAND)};
  status.show();
  context.subscriptions.push(vscode.commands.registerCommand(${JSON.stringify(FIXTURE_COMMAND)},
    async (resource) => {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resource.path));
      const text = new TextDecoder().decode(bytes);
      const lines = text.length === 0 ? 0 : text.split("\\n").length;
      return "lines=" + lines;
    }));
};`;

const fixtureZip = (method: 0 | 8 = 8) => buildZip([
  { name: "extension/package.json", data: Buffer.from(JSON.stringify(fixtureManifest)) },
  { name: "extension/extension.js", data: Buffer.from(fixtureEntry) },
], method);

const temp = await mkdtemp(join(tmpdir(), "mcode-f005-"));
configureEgressConsentStoragePath(join(temp, "js-only-egress-consent.json"));
configureJsOnlyEgressConsentReader(getJsOnlyEgressConsent);

try {
  await setJsOnlyEgressConsent(true);

  /* ───────── 0. 真实扩展：当前能力边界 ───────── */
  console.log("[0] 真实扩展 mechatroner.rainbow-csv-3.24.1");

  await test("★ 0-A 真实扩展被拒不早于源码限额（136516 > 24576）", async () => {
    const host = makeHost(temp);
    const zip = buildZip([
      { name: "extension/package.json", data: await readFile(join(REAL_EXT, "package.json")) },
      { name: "extension/extension.js", data: await readFile(join(REAL_EXT, "extension.js")) },
    ], 8);
    // 真实源码 136 KB → 在 readMinimalVsix 就撞源码限额。
    // 断言**报的是限额**，不是笼统失败：这正是「被哪道限制拒的」。
    await assert.rejects(
      VscodeL1Bridge.install(host, zip, { confirmReadAccess: true, confirmExecutableCode: true }),
      /main entry exceeds 24576 B/,
    );
    assert.equal(host.catalog().modules.length, 0, "被拒时不许有任何安装副作用");
  });

  await test("★ 0-B 即使源码够小，真实清单仍被贡献点检查拒（9 个贡献点）", async () => {
    const host = makeHost(temp);
    // 用真实 package.json + 缩小源码：源码墙过了，下一道墙才露出来。
    const zip = buildZip([
      { name: "extension/package.json", data: await readFile(join(REAL_EXT, "package.json")) },
      { name: "extension/extension.js", data: Buffer.from("exports.activate=()=>{};") },
    ], 8);
    await assert.rejects(
      VscodeL1Bridge.install(host, zip, { confirmReadAccess: true, confirmExecutableCode: true }),
      /contribution|colors|menus|Unrecognized|unrecognized/i,
    );
    assert.equal(host.catalog().modules.length, 0);
  });

  await test("★ 0-C 真实扩展的第一条命令没有 publisher.name 前缀（第三道墙）", async () => {
    const pkg = JSON.parse(await readFile(join(REAL_EXT, "package.json"), "utf8"));
    const first = pkg.contributes.commands[0].command as string;
    const prefix = pkg.publisher + "." + pkg.name + ".";
    assert.equal(first, "rainbow-csv.CSVLint");
    assert.equal(first.startsWith(prefix), false,
      "真实扩展的命令名不带 mechatroner. 前缀 —— 这是与宿主规则的冲突，不是扩展的错");
  });

  /* ───────── 1–5. 同构缩小版：五环 ───────── */
  const host = makeHost(temp);
  const path = join(temp, "data.csv");
  // 5 行（最后一行没有换行）：期望值 = 5
  await writeFile(path, "a,b\nc,d\ne,f\ng,h\ni,j");
  const resource = { projectPath: temp, path };

  let bridge: VscodeL1Bridge;

  console.log("[1] 装");
  await test("★ 1 同构缩小版（DEFLATE）装进去，返回 bridge 实例", async () => {
    bridge = await VscodeL1Bridge.install(host, fixtureZip(8),
      { confirmReadAccess: true, confirmExecutableCode: true },
      // 只读 L2 ports：给扩展 `vscode.workspace.fs` 这条唯一的文件访问路径。
      // `fileWrite: false` —— 本卡不需要写，也不该为了测试多要权限。
      { fileWrite: false });
    assert.ok(bridge instanceof VscodeL1Bridge);
  });

  console.log("[2] 出现在列表");
  await test("★ 2 catalog 里有 user.mechatroner.rainbow-csv-fixture（不是「有东西」）", async () => {
    const ids = host.catalog().modules.map((m) => m.id);
    assert.ok(ids.includes("user.mechatroner.rainbow-csv-fixture"), "实际：" + JSON.stringify(ids));
    assert.ok(host.catalog().capabilities.some((c) => c.id === `module.${FIXTURE_PUBLISHER}.${FIXTURE_NAME}.run`),
      "能力目录里应有它的 run 能力");
  });

  console.log("[3] 命令能调用");
  await test("★ 3 executeCommand 走通并返回 result", async () => {
    const reply = await bridge.executeCommand(FIXTURE_COMMAND, resource, randomUUID());
    assert.equal(reply.type, "result");
  });

  console.log("[4] 结果正确");
  await test("★ 4 扩展真实读文件数的行数 = 5（不是空壳，不是常量）", async () => {
    const reply = await bridge.executeCommand(FIXTURE_COMMAND, resource, randomUUID());
    assert.equal(reply.type, "result");
    if (reply.type !== "result") return;
    // 文件内容 "a,b\nc,d\ne,f\ng,h\ni,j" 共 5 行，是我们写进 temp 的。
    assert.equal(reply.value.message, "lines=5");
    assert.equal(reply.value.statusBarText, "fixture ready");
    // 反向对照：写一个 3 行的文件，结果必须跟着变 —— 证明它真的在读数。
    const other = join(temp, "three.csv");
    await writeFile(other, "x\ny\nz");
    const again = await bridge.executeCommand(FIXTURE_COMMAND,
      { projectPath: temp, path: other }, randomUUID());
    assert.equal(again.type, "result");
    if (again.type === "result") assert.equal(again.value.message, "lines=3",
      "换个文件结果必须跟着变，否则它没在读这个文件");
  });

  console.log("[5] 能卸载");
  await test("★ 5 卸载后 catalog 里没有它，且旧 bridge 拒绝执行", async () => {
    await host.remove("user.mechatroner.rainbow-csv-fixture");
    assert.equal(host.catalog().modules.some((m) => m.id === "user.mechatroner.rainbow-csv-fixture"), false);
    assert.equal(host.catalog().capabilities.some((c) => c.id === `module.${FIXTURE_PUBLISHER}.${FIXTURE_NAME}.run`), false);
    // 负控：这是 isCurrent() 那道防线的唯一证明。
    await assert.rejects(
      bridge.executeCommand(FIXTURE_COMMAND, resource, randomUUID()),
      /removed or replaced/,
    );
  });

  await test("★ 5-B 卸载后旧 bridge 也不许报成功（对照组：移除前它是能跑的）", async () => {
    // 这条断言存在的前提是第 4 环已经证明「移除前同一个 bridge、同一个 resource 能跑」。
    // 所以这里的拒绝不能是「因为这个命令从来就跑不了」。
    await assert.rejects(bridge.executeCommand(FIXTURE_COMMAND, resource, randomUUID()));
  });

  /* ───────── 补充：STORE 路径仍可用（正控） ───────── */
  await test("★ 正控：STORE 打包的同构包同样能走完五环（F002 没弄坏旧路径）", async () => {
    const h2 = makeHost(temp);
    const b2 = await VscodeL1Bridge.install(h2, fixtureZip(0),
      { confirmReadAccess: true, confirmExecutableCode: true }, { fileWrite: false });
    const reply = await b2.executeCommand(FIXTURE_COMMAND, resource, randomUUID());
    assert.equal(reply.type, "result");
    if (reply.type === "result") assert.equal(reply.value.message, "lines=5");
    await h2.remove("user.mechatroner.rainbow-csv-fixture");
  });
} finally {
  configureJsOnlyEgressConsentReader(null);
  configureEgressConsentStoragePath(null);
  await rm(temp, { recursive: true, force: true });
}

console.log(`\nvsix-end-to-end-smoke: ${passed}/${passed + failed} 通过`);
if (failed) process.exitCode = 1;
