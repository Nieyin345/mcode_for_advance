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
  stableDirectoryHash,
  type EngineNodeRegistryFs,
} from "@main/workflowEngines/engineNodeRegistry.js";
import { readdirNames } from "./helpers.js";
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

  /* ══════════ 7b. 真实安装入口：字节 / 目录 + 下载期 sha256 ══════════ */
  console.log("\n7b. installFromBytes / installFromDirectory（下载期哈希 + 原子落盘）");
  {
    const { installBytes, installDir, readTreeReal, mkFailingFs } = await import("./helpers.js");
    void installBytes;
    const bytes = Buffer.from("node package tarball bytes");
    const bytesHash = createHash("sha256").update(bytes).digest("hex");

    // ── 合法包：落盘 + 清单 ──
    {
      const dataDir = join(temp, "install-a");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const result = await registry.installFromBytes(
        installRequest({ name: "node-red-contrib-good", sha256: bytesHash }), bytes);
      check("★ 合法字节包安装成功", result.ok, result);
      const pkgFile = join(dataDir, "node_modules", "node-red-contrib-good", "package.tgz");
      check("★ 包体文件真的落盘", existsSync(pkgFile));
      eq("★ 落盘字节与输入逐字节一致", (await readFile(pkgFile)).equals(bytes), true);
      const state = await registry.readState();
      eq("★ 清单里出现该包且哈希正确",
        state.kind === "ok" ? state.entries.find((e) => e.name === "node-red-contrib-good")?.sha256 : null, bytesHash);
      check("★ 暂存目录已清理（.staging-* 不存在）",
        !existsSync(join(dataDir, "node_modules", `.staging-node-red-contrib-good`)));
    }

    // ── 篡改字节（同长度改一字节）→ 拒绝、零残留 ──
    {
      const dataDir = join(temp, "install-tamper");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const tampered = Buffer.from(bytes);
      tampered[0] = tampered[0]! ^ 0xff; // 同长度改一字节
      const result = await registry.installFromBytes(
        installRequest({ name: "node-red-contrib-evil", sha256: bytesHash }), tampered);
      check("★ 篡改字节被拒（sha256 不符）", result.ok === false && /sha256/.test(result.reason), result);
      check("★ 拒绝路径上包体目录不存在", !existsSync(join(dataDir, "node_modules", "node-red-contrib-evil")));
      check("★ 拒绝路径上没有暂存目录残留", !existsSync(join(dataDir, "node_modules")) || (await readdirNames(join(dataDir, "node_modules"))).every((n) => !n.startsWith(".staging-")));
      eq("★ 拒绝路径上清单无记录", (await registry.readState()).kind, "absent");
    }

    // ── 安装中途失败（模拟写失败）→ 不留半截、清单无记录 ──
    {
      const dataDir = join(temp, "install-fail");
      const realFs = await readTreeReal();
      const failing = mkFailingFs(realFs, dataDir, () => true);
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red", fs: failing });
      const result = await registry.installFromBytes(
        installRequest({ name: "node-red-contrib-fail", sha256: bytesHash }), bytes);
      check("★ 写盘失败时 installFromBytes 报错（不是假成功）", result.ok === false && /落盘失败/.test(result.reason), result);
      check("★ 失败后目标目录不存在（不留半截）", !existsSync(join(dataDir, "node_modules", "node-red-contrib-fail")));
      check("★ 失败后暂存目录已清理", (await readdirNames(join(dataDir, "node_modules"))).every((n) => !n.startsWith(".staging-")));
      eq("★ 失败后清单无记录", (await registry.readState()).kind, "absent");
    }

    // ── 目录包：稳定哈希 ──
    const dirHash = stableDirectoryHash([
      { path: "package.json", bytes: Buffer.from("{\"name\":\"node-red-contrib-dir\"}") },
      { path: "nodes/hello.js", bytes: Buffer.from("module.exports = function(RED){};") },
    ]);
    check("★ 稳定哈希是 64 位 hex", typeof dirHash === "string" && /^[0-9a-f]{64}$/.test(dirHash), dirHash);
    eq("★ 稳定哈希与枚举顺序无关", stableDirectoryHash([
      { path: "nodes/hello.js", bytes: Buffer.from("module.exports = function(RED){};") },
      { path: "package.json", bytes: Buffer.from("{\"name\":\"node-red-contrib-dir\"}") },
    ]), dirHash);
    eq("★ 稳定哈希与路径分隔符写法无关", stableDirectoryHash([
      { path: "package.json", bytes: Buffer.from("{\"name\":\"node-red-contrib-dir\"}") },
      { path: "nodes\\hello.js", bytes: Buffer.from("module.exports = function(RED){};") },
    ]), dirHash);
    eq("★ 改一个文件内容 → 哈希变化", stableDirectoryHash([
      { path: "package.json", bytes: Buffer.from("{\"name\":\"node-red-contrib-dir\"}") },
      { path: "nodes/hello.js", bytes: Buffer.from("module.exports = function(RED){/*x*/};") },
    ]) === dirHash, false);
    eq("★ 空目录 / 重复路径 / 越界路径 → null（调用方必须拒绝）",
      [stableDirectoryHash([]), stableDirectoryHash([
        { path: "a.js", bytes: new Uint8Array(1) }, { path: "a.js", bytes: new Uint8Array(1) },
      ]), stableDirectoryHash([{ path: "../escape.js", bytes: new Uint8Array(1) }])], [null, null, null]);

    {
      const dataDir = join(temp, "install-dir");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const result = await installDir(registry, installRequest({ name: "node-red-contrib-dir", sha256: dirHash! }));
      check("★ 合法目录包安装成功", result.ok, result);
      check("★ 目录内容按相对路径落盘", existsSync(join(dataDir, "node_modules", "node-red-contrib-dir", "nodes", "hello.js")));
      check("★ package.json 也在", existsSync(join(dataDir, "node_modules", "node-red-contrib-dir", "package.json")));
      const state = await registry.readState();
      eq("★ 清单记录目录包的稳定哈希",
        state.kind === "ok" ? state.entries.find((e) => e.name === "node-red-contrib-dir")?.sha256 : null, dirHash);
    }

    // ── 重复安装同名不同哈希 → 显式拒绝 ──
    {
      const dataDir = join(temp, "install-dup");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const first = await registry.installFromBytes(installRequest({ name: "node-red-contrib-dup", sha256: bytesHash }), bytes);
      check("前置：第一次安装成功", first.ok, first);
      const other = Buffer.from("different bytes");
      const otherHash = createHash("sha256").update(other).digest("hex");
      const second = await registry.installFromBytes(installRequest({ name: "node-red-contrib-dup", sha256: otherHash }), other);
      check("★ 同名不同哈希 → 显式拒绝（不静默替换可执行体）", second.ok === false && /卸载/.test(second.reason), second);
      eq("★ 被拒后盘上仍是第一份字节", (await readFile(join(dataDir, "node_modules", "node-red-contrib-dup", "package.tgz"))).equals(bytes), true);
      // 同哈希重装 = 幂等（允许）。
      const again = await registry.installFromBytes(installRequest({ name: "node-red-contrib-dup", sha256: bytesHash }), bytes);
      check("★ 同哈希重装幂等（允许）", again.ok, again);
    }

    // ── 旧调用方没有新端口：安装入口 fail-closed ──
    {
      const dataDir = join(temp, "install-noport");
      const registry = new EngineNodeRegistry({
        dataDir, engineId: "node-red",
        fs: {
          async readFile(path) { return readFile(path, "utf8"); },
          async writeFile(path, text) { await writeFile(path, text, "utf8"); },
          async rename(from, to) { const { rename } = await import("node:fs/promises"); await rename(from, to); },
          async mkdir(path) { await mkdir(path, { recursive: true }); },
          async remove(path) { await rm(path, { recursive: true, force: true }); },
        },
      });
      const result = await registry.installFromBytes(installRequest({ name: "node-red-contrib-noport", sha256: bytesHash }), bytes);
      check("★ 没有写盘端口时安装被拒（fail-closed，不退化成只登记）",
        result.ok === false && /写盘通道/.test(result.reason), result);
    }
  }

  /* ══════════ 8. sha256 计算出口 ══════════ */
  console.log("\n8. sha256 计算出口");
  eq("sha256OfBytes 是 64 位小写 hex", /^[0-9a-f]{64}$/.test(sha256OfBytes(Buffer.from("tarball-bytes"))), true);
  eq("与 node:crypto 结果一致", sha256OfBytes(Buffer.from("tarball-bytes")), SHA);

  /* ══════════ 9. 安装路由：审批是硬前置 ══════════ */
  console.log("\n9. installEngineNode（审批硬前置 / 防自授权 / 升级重批）");
  {
    const { installEngineNode, describeEngineNodeInstall } = await import("@main/workflowEngines/engineNodeInstallRoute.js");

    // 一个真实目录包（内容固定 → 稳定哈希可预期）。
    const dirMetaBase = async (name: string, over: Record<string, unknown> = {}) => {
      const sourceDir = join(temp, `route-src-${name}`);
      await mkdir(join(sourceDir, "nodes"), { recursive: true });
      await writeFile(join(sourceDir, "package.json"), `{"name":"${name}"}`, "utf8");
      await writeFile(join(sourceDir, "nodes", "hello.js"), `module.exports = function(RED){}; // ${name}`, "utf8");
      const { stableDirectoryHash } = await import("@main/workflowEngines/engineNodeRegistry.js");
      const files = [
        { path: "package.json", bytes: new Uint8Array(await readFile(join(sourceDir, "package.json"))) },
        { path: "nodes/hello.js", bytes: new Uint8Array(await readFile(join(sourceDir, "nodes", "hello.js"))) },
      ];
      return {
        sourceDir,
        meta: {
          name, version: "1.0.0", source: `local://${sourceDir}`,
          sha256: stableDirectoryHash(files)!, license: "Apache-2.0",
          capabilities: ["resource.read", "network"], ...over,
        },
      };
    };

    // ── 9a. 审批端口缺失 → fail-closed、零落盘 ──
    {
      const dataDir = join(temp, "route-noapproval");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const { sourceDir, meta } = await dirMetaBase("node-red-contrib-sponsored-1");
      const result = await installEngineNode({ registry, sourceDir, meta });
      check("★ 审批端口缺失 → fail-closed（approval_unavailable）",
        result.ok === false && result.code === "approval_unavailable", result);
      check("★ 审批缺失时包体零落盘", !existsSync(registry.packagePath(meta.name)));
      eq("★ 审批缺失时清单无记录", (await registry.readState()).kind, "absent");
    }

    // ── 9b. 调用方伪造 approvedByUser=true（塞进 meta）→ 审批端口拒绝 → 安装被拒 ──
    {
      const dataDir = join(temp, "route-forged");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const { sourceDir, meta } = await dirMetaBase("node-red-contrib-sponsored-2");
      // 调用方尽力伪造：多余字段塞不进类型，但运行时对象可以带 —— 路由必须无视它。
      const forged = { ...meta, approvedByUser: true } as typeof meta;
      let asked = 0;
      const result = await installEngineNode({
        registry, sourceDir, meta: forged,
        approval: async () => { asked += 1; return false; },
      });
      check("★ 调用方伪造 approvedByUser=true 但审批端口拒绝 → 安装被拒",
        result.ok === false && result.code === "approval_denied", result);
      eq("★ 伪造场景下审批端口真的被问了 1 次（不是直接放行）", asked, 1);
      check("★ 被拒时包体零落盘", !existsSync(registry.packagePath(meta.name)));
      eq("★ 被拒时清单无记录", (await registry.readState()).kind, "absent");
    }

    // ── 9c. 审批卡内容：可执行+能力+network+许可+来源 ──
    {
      const { meta } = await dirMetaBase("node-red-contrib-card");
      const card = describeEngineNodeInstall(meta, "install");
      eq("★ 审批卡带包名/版本", [card.name, card.version], [meta.name, "1.0.0"]);
      eq("★ 审批卡带许可与来源", [card.license, card.source], ["Apache-2.0", meta.source]);
      eq("★ 审批卡带能力声明", card.capabilities, ["resource.read", "network"]);
      eq("★ 声明了 network → 卡片标记 network=true（与 allowNetwork 同一判据）", card.network, true);
      check("★ 首次安装 intent=install", card.intent === "install");
    }

    // ── 9d. 审批通过 → 安装成功、清单记 approvedByUser=true ──
    {
      const dataDir = join(temp, "route-approved");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const { sourceDir, meta } = await dirMetaBase("node-red-contrib-sponsored-3");
      let asked = 0;
      const result = await installEngineNode({
        registry, sourceDir, meta, approval: async () => { asked += 1; return true; },
      });
      check("★ 审批通过 → 安装成功", result.ok, result);
      eq("★ 审批端口恰好被问 1 次", asked, 1);
      check("★ 包体真的落盘", existsSync(join(registry.packagePath(meta.name), "nodes", "hello.js")));
      const state = await registry.readState();
      const entry = state.kind === "ok" ? state.entries.find((e) => e.name === meta.name) : undefined;
      eq("★ 清单记录 approvedByUser=true（由审批端口点头后写入）", entry?.approvedByUser, true);
      eq("★ 清单记录的哈希是目录稳定哈希", entry?.sha256, meta.sha256);
    }

    // ── 9e. 同名不同哈希（升级）→ 拒绝；显式卸载后重装 → **再问一次审批** ──
    {
      const dataDir = join(temp, "route-upgrade");
      const registry = new EngineNodeRegistry({ dataDir, engineId: "node-red" });
      const first = await dirMetaBase("node-red-contrib-sponsored-4");
      /** **共享计数器**：首装 / 被拒升级 / 卸载后重装 三次都记在这里 ——
       *  能直接断言"升级后总数从 1 变 2"，而不是拿两个独立计数器各说各话。 */
      let asked = 0;
      const approve = async (): Promise<boolean> => { asked += 1; return true; };
      const firstResult = await installEngineNode({
        registry, sourceDir: first.sourceDir, meta: first.meta, approval: approve,
      });
      check("前置：首装成功", firstResult.ok, firstResult);
      eq("前置：审批被问 1 次", asked, 1);

      // 同名不同内容 → 换一个哈希。
      const second = await dirMetaBase("node-red-contrib-sponsored-4");
      await writeFile(join(second.sourceDir, "nodes", "hello.js"), "module.exports = function(RED){/*v2*/};", "utf8");
      const { stableDirectoryHash } = await import("@main/workflowEngines/engineNodeRegistry.js");
      const v2Hash = stableDirectoryHash([
        { path: "package.json", bytes: new Uint8Array(await readFile(join(second.sourceDir, "package.json"))) },
        { path: "nodes/hello.js", bytes: new Uint8Array(await readFile(join(second.sourceDir, "nodes", "hello.js"))) },
      ])!;
      const upgrade = await installEngineNode({
        registry, sourceDir: second.sourceDir, meta: { ...second.meta, sha256: v2Hash }, approval: approve,
      });
      check("★ 同名不同哈希直接重装 → 被拒（duplicate，升级必须显式卸载）",
        upgrade.ok === false && upgrade.code === "duplicate", upgrade);
      eq("★ 被拒的升级**没有**触发审批（不给「静默换执行体」留口子）", asked, 1);

      // 显式卸载 → 重装新版：审批必须**再问一次**（不继承旧批准）。
      await registry.uninstall("node-red-contrib-sponsored-4");
      const reinstalled = await installEngineNode({
        registry, sourceDir: second.sourceDir, meta: { ...second.meta, version: "2.0.0", sha256: v2Hash }, approval: approve,
      });
      check("★ 卸载后重装新版成功", reinstalled.ok, reinstalled);
      eq("★ 升级（卸载→重装）要求**再次审批**：审批端口累计被问 2 次（首装 1 + 新版 1）", asked, 2);
      const state = await registry.readState();
      eq("★ 重装后清单版本是 2.0.0",
        state.kind === "ok" ? state.entries.find((e) => e.name === "node-red-contrib-sponsored-4")?.version : null, "2.0.0");
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(`\nengine-node-registry-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
