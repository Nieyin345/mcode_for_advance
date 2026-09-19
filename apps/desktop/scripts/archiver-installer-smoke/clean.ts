/**
 * 干净机器那一趟:**这台机器上一个内核来源都探不到**时,`listRuntimes` 交出去的东西
 * 对不对。它和 main.ts 是两趟**独立的 node**,不在一个 bundle 里 —— 因为“干净机器”
 * 这个现场靠的是 **bundle 旁边没有 `node_modules`**(见 run.sh),而 main.ts 那一趟
 * 非有不可(`await import("tar")` 是运行期从 bundle 的位置解析的)。两者不能同时成立。
 *
 * ## 它钉的是哪一条
 *
 * `listRuntimes` 里 `updateAvailable` 的判据。它曾经写成:
 *
 *     updateAvailable: activeVersion !== expected[agent]   // ← 没有 `!== null`
 *
 * 于是一台刚装好、什么都没下的机器上 `activeVersion` 是 `null`,而 `null !== "0.3.258"`
 * 为真 —— 每张卡片都摆着一个“有更新可用”,点下去只是开始一次首装。现在那句里有的
 * `activeVersion !== null` 就是唯一的防护。
 *
 * ⚠️ **这一趟非有不可**:main.ts 那趟跑在这台开发机上,三个 agent 的 dev fallback
 * 全都探得到,`activeVersion` 永远不是 null —— 那条断言在那儿是**空转**的。
 *
 * Run: scripts/archiver-installer-smoke/run.sh(第二趟)
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentState } from "@contracts/ipc";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

// 与 main.ts 同款:一个空的临时 runtimes 根(不注册的话 installer 会落到
// app.getPath("userData") —— 那个替身会抛,所以这里注册是为了“不该走到”而不是“兜底”)。
const RUNTIMES = mkdtempSync(join(tmpdir(), "mcode-runtime-clean-"));
const { setManagedRuntimeRoot, getManagedRuntimeRoot } = await import("@main/runtimes/managedRuntimeRoots.js");
setManagedRuntimeRoot(RUNTIMES);
assert.equal(getManagedRuntimeRoot(), RUNTIMES, "clean: runtimes 根没注册上");

const { listRuntimes } = await import("@main/runtimes/runtimeInstaller.js");

console.log("\n丙 干净机器(bundle 旁边没有 node_modules:三个 probe 都探不到)");

const list: RuntimeAgentState[] = await listRuntimes();

check("三张卡片都在", list.length === 3, list.map((r) => r.agent));
check("★ 这一趟的前提:三个 agent 一个来源都探不到",
  list.every((r) => r.source === null && r.activeVersion === null && r.activePath === null),
  list.map((r) => [r.agent, r.source, r.activeVersion]));
check("★ 没有 managed 副本 ⇒ installed 全 false", list.every((r) => r.installed === false));
check("★ installedVersion 全 null", list.every((r) => r.installedVersion === null));
check("★ diskBytes 全 0", list.every((r) => r.diskBytes === 0));
check("★ installPath 全 null", list.every((r) => r.installPath === null));

// ——— 这条是整套里唯一会真红的一次性判据 ———
// 把 listRuntimes 的 `activeVersion !== null && activeVersion !== expected[agent]`
// 改回 `activeVersion !== expected[agent]`,这一条立刻红,而其它全绿。
check("★★ 干净机器上 updateAvailable 必须是 false(null 不是“有更新”)",
  list.every((r) => r.updateAvailable === false), list.map((r) => [r.agent, r.updateAvailable]));

// 判据本身的不变式:可更新 ⟺ 真的加载着的那份不是钉版。
check("★ updateAvailable 不变式(== activeVersion !== null && != expected)",
  list.every((r) => r.updateAvailable === (r.activeVersion !== null && r.activeVersion !== r.expectedVersion)));

// expectedVersion 走的是**真** package.json(见 stubs/electron-clean.ts 的 getAppPath),
// 所以它必须等于三个包在 apps/desktop/package.json 里的钉版 —— 不是代码里的兜底常量。
check("★ expectedVersion 三个都非空(真读到了 package.json,不是兜底常量)",
  list.every((r) => typeof r.expectedVersion === "string" && r.expectedVersion.length > 0),
  list.map((r) => [r.agent, r.expectedVersion]));
check("★ lastError 全是空串(是“没装”,不是“装坏了”)",
  list.every((r) => r.lastError === ""), list.map((r) => r.lastError));
check("★ installing 全 false", list.every((r) => r.installing === false));

console.log(`\narchiver-installer smoke (clean): ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
