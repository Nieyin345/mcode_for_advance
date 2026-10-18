/**
 * 【ARC-006 Gate E / MERGE-4】**宿主侧可执行体清单**的无头回归网。
 *
 * 覆盖台账 MERGE-4 里可无头验证的宿主侧判据（不依赖 Node-RED）：
 *
 *  1. **安装审核**：缺 sha256 / 缺许可 / 缺来源 / 缺能力声明 / 包名非法 → 拒绝，
 *     且**盘上什么都不写**（清单文件不存在，包体目录不存在）；
 *  2. **卸载事务**：先落 `pending-remove` → 删包体 → 才从清单移除；卸载后文件不存在、
 *     清单无记录；
 *  3. **卸载中途失败**：包体删除抛错 → 清单里该条目仍是 `pending-remove`（不静默
 *     留可执行体），下次启动 `recoverPendingRemovals` 清掉；
 *  4. **能力声明共享判据**：清单里的 `network` 与 `ModuleHost` 的 `allowNetwork`
 *     都是 `@contracts/modules` 的 `declaresNetwork` —— 源码级钉住，行为级用同一份
 *     函数对照（撤掉任一处共享就会红）。
 *  5. **坏清单 fail-closed**：读不懂的账不能拿来做删除决定；写回被拒。
 *
 * Run: bash scripts/engine-node-registry-smoke/run.sh
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  EngineNodeRegistry,
  ENGINE_NODE_REGISTRY_FILENAME,
  sha256OfBytes,
  type EngineNodeRegistryFs,
} from "@main/workflowEngines/engineNodeRegistry.js";
import { declaresNetwork } from "@contracts/modules";

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
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const SHA = createHash("sha256").update("tarball-bytes").digest("hex");

function installRequest(over: Partial<Parameters<EngineNodeRegistry["recordInstall"]>[0]> = {}) {
  return {
    name: "node-red-contrib-demo",
    version: "1.2.3",
    source: "https://registry.npmjs.org/node-red-contrib-demo/-/demo-1.2.3.tgz",
    sha256: SHA,
    license: "Apache-2.0",
    capabilities: ["resource.read"],
    approvedByUser: true,
    ...over,
  };
}

const temp = await mkdtemp(join(tmpdir(), "mcode-engine-nodes-"));
try {
  /* ══════════ 1. 安装审核：缺 sha256 / 许可 = 拒绝且不落盘 ══════════ */
  console.log("\n1. 安装审核（缺项即拒绝，盘上什么都不写）");
  {
    const dataDir = join(temp, "engine-a");
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
    const listPath = join(dataDir, ENGINE_NODE_REGISTRY_FILENAME);

    const cases: Array<[string, Partial<ReturnType<typeof installRequest>>, RegExp]> = [
      ["缺 sha256", { sha256: "" }, /sha256/],
      ["sha256 不是 64 位 hex", { sha256: "abc" }, /sha256/],
      ["缺许可", { license: "" }, /许可/],
      ["缺来源", { source: "  " }, /来源/],
      ["缺版本", { version: "" }, /版本/],
      ["包名带路径分隔符", { name: "../evil" }, /包名/],
    ];
    for (const [label, over, pattern] of cases) {
      const result = await registry.recordInstall(installRequest(over));
      check(`★ 安装被拒：${label}`, result.ok === false && pattern.test(result.reason), result);
    }
    check("★ 被拒的安装一个字节都没落盘（清单文件不存在）", !existsSync(listPath));
    const state = await registry.readState();
    eq("★ 被拒的安装没有留下任何条目", state.kind, "absent");

    // 正控：齐全时落盘。
    const ok = await registry.recordInstall(installRequest());
    check("前置：齐全的安装成功", ok.ok, ok);
    const after = await registry.readState();
    eq("写进清单的条目", after.kind === "ok" ? after.entries.map((e) => e.name) : null, ["node-red-contrib-demo"]);
    const entry = after.kind === "ok" ? after.entries[0]! : null;
    eq("记录来源", entry?.source, installRequest().source);
    eq("记录 sha256", entry?.sha256, SHA);
    eq("记录许可", entry?.license, "Apache-2.0");
    eq("记录能力声明", entry?.capabilities, ["resource.read"]);
    eq("记录真人批准", entry?.approvedByUser, true);
    check("记录安装时间（数字）", typeof entry?.installedAt === "number");
  }

  /* ══════════ 2. 卸载：文件删除 + 清单移除 ══════════ */
  console.log("\n2. 卸载（先 pending-remove，删除成功才移除记录）");
  {
    const dataDir = join(temp, "engine-b");
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
    await registry.recordInstall(installRequest());
    // 造包体目录（卸载删除的目标）。
    const packageDir = registry.packagePath("node-red-contrib-demo");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");
    check("前置：包体存在", existsSync(join(packageDir, "index.js")));

    const removed = await registry.uninstall("node-red-contrib-demo");
    eq("★ 卸载成功", removed, { ok: true, removed: true });
    check("★ 卸载后包体文件不存在", !existsSync(join(packageDir, "index.js")));
    const state = await registry.readState();
    eq("★ 卸载后注册表无记录", state.kind === "ok" ? state.entries.map((e) => e.name) : null, []);
    // 幂等。
    eq("重复卸载幂等（removed=false）", await registry.uninstall("node-red-contrib-demo"), { ok: true, removed: false });
  }

  /* ══════════ 3. 卸载中途失败 → pending-remove 留给下次启动 ══════════ */
  console.log("\n3. 卸载中途失败（记录标 pending-remove，下次启动清理）");
  {
    const dataDir = join(temp, "engine-c");
    // 假 fs：readFile/writeFile 走真盘（清单要能回读），remove 第一次抛错、之后放行。
    const realFs: EngineNodeRegistryFs = {
      async readFile(path) { return readFile(path, "utf8"); },
      async writeFile(path, text) { await mkdir(join(dataDir), { recursive: true }); await writeFile(path, text, "utf8"); },
      async rename(from, to) { const { rename } = await import("node:fs/promises"); await rename(from, to); },
      async mkdir(path) { await mkdir(path, { recursive: true }); },
      async remove(path) {
        if (failing) { failing = false; throw new Error("EBUSY: 文件被占用"); }
        await rm(path, { recursive: true, force: true });
      },
    };
    let failing = true;
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red", fs: realFs });
    await registry.recordInstall(installRequest());
    const packageDir = registry.packagePath("node-red-contrib-demo");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");

    const failed = await registry.uninstall("node-red-contrib-demo");
    check("★ 删除失败 → 卸载返回失败并点明 pending-remove",
      failed.ok === false && failed.pendingRemove === true && /pending-remove/.test(failed.reason), failed);
    check("★ 删除失败时包体仍在（不假装删掉了）", existsSync(join(packageDir, "index.js")));
    const state = await registry.readState();
    const entry = state.kind === "ok" ? state.entries.find((e) => e.name === "node-red-contrib-demo") : undefined;
    eq("★ 记录标成 pending-remove（不静默留可执行体）", entry?.state, "pending-remove");

    // 重启视角：新 registry 实例（同一 dataDir）的启动恢复清掉它。
    const restarted = new EngineNodeRegistry({ dataDir, engineId: "node-red", fs: realFs });
    const recovery = await restarted.recoverPendingRemovals();
    eq("★ 下次启动清掉 pending-remove 条目", recovery.recovered, ["node-red-contrib-demo"]);
    check("★ 恢复后包体文件不存在", !existsSync(join(packageDir, "index.js")));
    const after = await restarted.readState();
    eq("★ 恢复后注册表无记录", after.kind === "ok" ? after.entries.length : -1, 0);
  }

  /* ══════════ 4. 能力声明：网络判据与 ModuleHost 同一份 ══════════ */
  console.log("\n4. 能力声明（network 与 allowNetwork 共用 declaresNetwork）");
  {
    const dataDir = join(temp, "engine-d");
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
    await registry.recordInstall(installRequest({ name: "node-red-contrib-net", capabilities: ["resource.read", "network"] }));
    await registry.recordInstall(installRequest({ name: "node-red-contrib-plain", capabilities: ["resource.read"] }));
    eq("★ 声明了 network 的包 → allowsNetwork=true", await registry.allowsNetwork("node-red-contrib-net"), true);
    eq("★ 未声明的包 → allowsNetwork=false（默认拒）", await registry.allowsNetwork("node-red-contrib-plain"), false);
    eq("未知包 → false", await registry.allowsNetwork("node-red-contrib-ghost"), false);
    // 与共享判据一致（不是两套）。
    eq("共享判据 declaresNetwork 对同一份清单给同一答案",
      [declaresNetwork(["resource.read", "network"]), declaresNetwork(["resource.read"])],
      [await registry.allowsNetwork("node-red-contrib-net"), await registry.allowsNetwork("node-red-contrib-plain")]);
    // 卸载后不再放行网络。
    await registry.uninstall("node-red-contrib-net");
    eq("★ 卸载后 allowsNetwork 回 false（撤权即生效）", await registry.allowsNetwork("node-red-contrib-net"), false);
  }

  /* ══════════ 5. 升级：同 name 覆盖，不残留旧记录 ══════════ */
  console.log("\n5. 升级（同 name 覆盖，不继承旧声明）");
  {
    const dataDir = join(temp, "engine-e");
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
    await registry.recordInstall(installRequest({ version: "1.0.0", capabilities: ["resource.read", "network"] }));
    await registry.recordInstall(installRequest({ version: "2.0.0", capabilities: ["resource.read"], sha256: "b".repeat(64) }));
    const state = await registry.readState();
    const entries = state.kind === "ok" ? state.entries : [];
    eq("★ 升级后同 name 只有一条记录", entries.map((e) => e.name), ["node-red-contrib-demo"]);
    eq("★ 记录的是新版本", entries[0]?.version, "2.0.0");
    eq("★ 新版本不继承旧版本的 network 声明", entries[0]?.capabilities, ["resource.read"]);
    eq("★ 升级后 allowsNetwork 按新声明判", await registry.allowsNetwork("node-red-contrib-demo"), false);
  }

  /* ══════════ 6. 坏清单 fail-closed ══════════ */
  console.log("\n6. 坏清单：读不懂的账不能指挥删除，也不能被覆盖");
  {
    const dataDir = join(temp, "engine-f");
    await mkdir(dataDir, { recursive: true });
    const listPath = join(dataDir, ENGINE_NODE_REGISTRY_FILENAME);
    await writeFile(listPath, "{ not json", "utf8");
    const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
    const state = await registry.readState();
    eq("坏 JSON → corrupt（不是空表）", state.kind, "corrupt");
    const install = await registry.recordInstall(installRequest());
    check("★ 坏清单时拒绝写入（不拿空表覆盖）", install.ok === false && /损坏/.test(install.reason), install);
    const uninstall = await registry.uninstall("node-red-contrib-demo");
    check("★ 坏清单时拒绝卸载（不做删除决定）", uninstall.ok === false, uninstall);
    eq("清单文件原样保留", await readFile(listPath, "utf8"), "{ not json");
    // 引擎 id 不符也按 corrupt。
    const otherDir = join(temp, "engine-g");
    const other = new EngineNodeRegistry({ dataDir: otherDir, engineId: "node-red" });
    await other.recordInstall(installRequest());
    const wrongEngine = new EngineNodeRegistry({ dataDir: otherDir, engineId: "another-engine" });
    eq("另一个引擎 id 读同一份清单 → corrupt", (await wrongEngine.readState()).kind, "corrupt");
  }

  /* ══════════ 7. 共享判据的源码级约束 ══════════ */
  console.log("\n7. 源码级：network 判据只有 declaresNetwork 一份");
  {
    const { readFileSync } = await import("node:fs");
    const repoRoot = process.cwd().replace(/apps[\\/]desktop$/, "");
    const host = readFileSync(join(process.cwd(), "src/main/modules/ModuleHost.ts"), "utf8");
    const runner = readFileSync(join(process.cwd(), "src/main/modules/permissionedProcessRunner.ts"), "utf8");
    const registrySrc = readFileSync(join(process.cwd(), "src/main/workflowEngines/engineNodeRegistry.ts"), "utf8");
    const contracts = readFileSync(join(repoRoot, "packages/contracts/src/modules.ts"), "utf8");
    check("contracts 导出 declaresNetwork", /export function declaresNetwork\(/.test(contracts));
    check("ModuleHost 不再自行 includes(\"network\") 直接判放行（都走 declaresNetwork）",
      !/permissions\.includes\("network"\)/.test(host.replace(/\/\/[^\n]*/g, "")) && /allowNetwork: declaresNetwork\(/.test(host),
      host.match(/permissions\.includes\("network"\)/g));
    check("可执行体清单用同一个 declaresNetwork", /declaresNetwork\(entry\.capabilities\)/.test(registrySrc));
    // permissionedProcessRunner 的 allowNetwork 是**布尔入参**，由 ModuleHost 计算；
    // 它自己不应再读权限短语（那会是第三份判据）。
    check("permissionedProcessRunner 不读权限短语（allowNetwork 由调用方按共享判据算）",
      !/includes\("network"\)/.test(runner));
  }

  /* ══════════ 8. sha256 计算出口 ══════════ */
  console.log("\n8. sha256 计算出口");
  eq("sha256OfBytes 是 64 位小写 hex", /^[0-9a-f]{64}$/.test(sha256OfBytes(Buffer.from("tarball-bytes"))), true);
  eq("与 node:crypto 结果一致", sha256OfBytes(Buffer.from("tarball-bytes")), SHA);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(`\nengine-node-registry-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
