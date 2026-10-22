/**
 * 【T18】**扩展安装权限卡**的回归网 —— 允许一次 / 始终允许 / 拒绝。
 *
 * ## 本套要钉死的安全属性（每一条都对应卡片的验收判据）
 *
 * 1. **拒绝 = 不写盘**：`install(..., "deny")` 在**任何**持久化之前抛出；清单
 *    文件、权限决策表、能力注册表三处都保持原样。拒绝绝不能是"先装了再禁用"。
 * 2. **允许一次 = 本次运行有效**：决策记录带本次 bootId；**模拟重启**后的下一个
 *    宿主（不同 bootId）对它判失效 —— 菜单调用被拒，且 `catalog` 把它列进
 *    `moduleStaleConsents`（供 UI 重新询问），但**不是**有效授权。
 * 3. **始终允许 = 跨重启有效**：模拟重启后同一扩展照常可调，不再询问。
 * 4. **权限集变化 = 重新询问**：在「始终允许」之后把清单加一条新权限 →
 *    不带新决策的安装被拒；旧决策无法放行新权限。
 * 5. **未知权限 = 拒绝安装**：清单里出现 `MODULE_PERMISSION_NAMES` 之外的值 →
 *    manifest schema 直接拒（fail-closed），什么都不写。
 * 6. **决策表损坏 = fail-closed**：坏 JSON / 形状不对 → 宿主拒绝执行与修改。
 * 7. **不绕过 ModuleHost**：安装卡给出决策之后，每次 `invoke` 仍走授权检查；
 *    安装确认**不是**永久执行授权（撤掉一条 grant，下一次 invoke 立刻被拒）。
 * 8. **`allow-always` 只认桌面发送方**：`resolveInstallDecision` 对没有真实
 *    渲染端 `sender.id` 的调用（Agent / 扩展委托 / 面板桥）把 `allow-always`
 *    收窄成 `allow-once` —— 自动化通道不能铸造跨重启授权。
 *
 * 全部只碰内存/临时目录；`persist` 与两份授权表都用注入的桩。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { resolveModuleResource } from "@main/modules/fileCapabilities.js";
import { configureJsOnlyEgressConsentReader } from "@main/modules/permissionedProcessRunner.js";
import { ModuleManifestSchema, type ModuleManifest } from "@contracts/modules";
import { ModulePermissionArchiveSchema } from "@contracts/modulePermissions";
import { ModuleCatalogSchema } from "@contracts/moduleCapability";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { resolveInstallDecision } from "@main/modules/installConsentPolicy.js";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
const eq = (name: string, actual: unknown, expected: unknown): void => {
  check(name, () => assert.deepEqual(actual, expected));
};

// 本套**只验安装决策**,不验沙箱:Windows 上执行可执行扩展需要用户显式同意 JS-only
// 降级。这里在**本进程内**打开它(与 module-app-call-smoke 同一做法),套件结束复原。
configureJsOnlyEgressConsentReader(() => true);
const temp = await mkdtemp(join(tmpdir(), "mcode-t18-"));
try {
  const root = join(temp, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  const target = join(root, "a.txt");
  await writeFile(target, "t18\n");

  /** 假清单：`files.read` + `files.write`；写一个能返回结果的能力。 */
  const manifest: ModuleManifest = ModuleManifestSchema.parse({
    apiVersion: 1, id: "user.t18-demo", version: "1.0.0",
    title: { zh: "安装卡测试", en: "Install card fixture" },
    permissions: ["files.read", "files.write"],
    contributions: [{
      id: "run", slot: "files.context",
      title: { zh: "运行", en: "Run" },
      capability: "module.run",
      view: { title: { zh: "结果", en: "Result" }, fields: [{ key: "ok", title: { zh: "好", en: "ok" } }] },
    }],
    program: { source: "({ run: async () => ({ ok: 1 }) })" },
  });

  /** 内存里的三个落点：模块清单 / 权限决策表 / 能力注册表由宿主自己管。 */
  interface Fixture {
    host: ModuleHost;
    modules: ModuleManifest[];
    archive: string | null;
    persistCalls: number;
  }
  function makeHost(bootId: string, seedArchives?: { archive?: string | null; modules?: ModuleManifest[] }): Fixture {
    const fx: Fixture = { host: null as unknown as ModuleHost, modules: seedArchives?.modules ?? [], archive: seedArchives?.archive ?? null, persistCalls: 0 };
    fx.host = new ModuleHost({
      authorize: async (resource) => { await resolveModuleResource(resource, (p) => p === root); },
      persist: async (manifests) => { fx.modules = [...manifests]; fx.persistCalls += 1; },
      readModulePermissions: () => fx.archive,
      persistModulePermissions: async (text) => { fx.archive = text; },
      verifyProgram: async () => ({ ok: true }),
      bootId,
    });
    return fx;
  }
  /** 直接注册模块派生的能力（生产由 prepareProgramBindings 做；这里走同一份 install）。 */
  const invokeArgs = (requestId: string) => ({
    moduleId: manifest.id, contributionId: "run", requestId,
    resource: { projectPath: root, path: target },
  });

  /* ── ① 拒绝 = 不写盘 ── */
  const denied = makeHost("boot-A-0001");
  const beforeDenied = { modules: denied.modules.length, archive: denied.archive, persist: denied.persistCalls };
  await check("① 拒绝安装:先于任何持久化抛出明确错误", async () => {
    await assert.rejects(denied.host.install(manifest, manifest.permissions, "deny"), /拒绝/);
  });
  await eq("① 拒绝安装:清单文件一次都没写(persist 调用数不变)", denied.persistCalls, beforeDenied.persist);
  await eq("① 拒绝安装:权限决策表原样(仍为 null)", denied.archive, beforeDenied.archive);
  await eq("① 拒绝安装:目录里没有这个模块", denied.host.catalog().modules.some((m) => m.id === manifest.id), false);
  await check("① 拒绝安装:能力未注册 —— invoke 报「模块或贡献不可用」", async () => {
    await assert.rejects(denied.host.invoke(invokeArgs("deny-invoke")), /模块或贡献不可用/);
  });

  /* ── ② 允许一次 = 本次运行有效,重启后重新询问 ── */
  const once = makeHost("boot-B-0002");
  await check("② 允许一次:本次安装成功", async () => { await once.host.install(manifest, manifest.permissions, "allow-once"); });
  const recordOnce = ModulePermissionArchiveSchema.parse(JSON.parse(once.archive!)).modules[manifest.id];
  await eq("② 允许一次:决策记录标成 session 且绑定本次 bootId", { duration: recordOnce?.duration, bootId: recordOnce?.bootId }, { duration: "session", bootId: "boot-B-0002" });
  await eq("② 允许一次:目录里带 duration:session(UI 可显示「仅本次」)", once.host.catalog().modulePermissions?.[manifest.id]?.duration, "session");
  await check("② 允许一次:本次进程内 invoke 可执行", async () => {
    const reply = await once.host.invoke(invokeArgs("once-1"));
    assert.equal(reply.type, "result");
  });
  // **模拟重启**：同一份持久存档,新宿主 + 新 bootId。
  const rebooted = makeHost("boot-C-0003", { archive: once.archive, modules: once.modules });
  // 恢复清单(生产是 service.ts 启动时 restore)。restore 不重写决策表。
  rebooted.host.restore(JSON.parse(JSON.stringify(manifest)));
  await eq("② 重启后:同一扩展的 menu 授权失效(modulePermissions = null)", rebooted.host.catalog().modulePermissions?.[manifest.id], null);
  await eq("② 重启后:失效记录出现在 moduleStaleConsents(reason:restart,带原授权子集)",
    rebooted.host.catalog().moduleStaleConsents?.[manifest.id]?.granted, ["files.read", "files.write"]);
  await check("② 重启后:直接 invoke 被拒(旧会话授权不能放行)", async () => {
    await assert.rejects(rebooted.host.invoke(invokeArgs("after-restart")), /重新授权|没有有效的安装权限授权|权限/);
  });
  await check("② 重启后:不带新决策再 install 被拒(不能静默续期)", async () => {
    // 两条 fail-closed 守卫都会接住它:逐项授权缺失(新权限模型)或「允许一次已过期」。
    await assert.rejects(rebooted.host.install(manifest), /重新确认授权|必须在安装时逐项确认授权/);
  });
  await check("② 重启后:带「允许一次」的重新安装成功,菜单恢复可用", async () => {
    await rebooted.host.install(manifest, manifest.permissions, "allow-once");
    const reply = await rebooted.host.invoke(invokeArgs("re-consented"));
    assert.equal(reply.type, "result");
  });

  /* ── ③ 始终允许 = 跨重启有效 ── */
  const always = makeHost("boot-D-0004");
  await check("③ 始终允许:安装成功", async () => { await always.host.install(manifest, manifest.permissions, "allow-always"); });
  const recordAlways = ModulePermissionArchiveSchema.parse(JSON.parse(always.archive!)).modules[manifest.id];
  await eq("③ 始终允许:决策记录为 persistent(不带 bootId)", { duration: recordAlways?.duration, bootId: recordAlways?.bootId }, { duration: "persistent", bootId: undefined });
  const rebootedAlways = makeHost("boot-E-0005", { archive: always.archive, modules: always.modules });
  rebootedAlways.host.restore(JSON.parse(JSON.stringify(manifest)));
  await eq("③ 始终允许:重启后目录仍显示已授权(不再询问)", rebootedAlways.host.catalog().modulePermissions?.[manifest.id]?.duration, "persistent");
  await eq("③ 始终允许:重启后没有 stale 记录", rebootedAlways.host.catalog().moduleStaleConsents?.[manifest.id], undefined);
  await check("③ 始终允许:重启后 invoke 直接可用", async () => {
    const reply = await rebootedAlways.host.invoke(invokeArgs("always-restart"));
    assert.equal(reply.type, "result");
  });

  /* ── ④ 权限集变化 = 重新询问 ── */
  const upgraded = { ...manifest, version: "1.1.0", permissions: [...manifest.permissions, "session.send"] as ModuleManifest["permissions"] };
  const upgradeHost = makeHost("boot-F-0006", { archive: always.archive, modules: always.modules });
  upgradeHost.host.restore(JSON.parse(JSON.stringify(manifest)));
  await check("④ 加一条新权限后:不带新决策的安装被拒(旧决策不放行新权限)", async () => {
    await assert.rejects(upgradeHost.host.install(upgraded), /重新逐项同意授权|重新确认授权|必须在安装时逐项确认授权/);
  });
  await eq("④ 加新权限的安装失败后:旧版本仍在", upgradeHost.host.catalog().modules.find((m) => m.id === manifest.id)?.version, "1.0.0");
  await check("④ 同一指纹同版本重装(no-op,原授权子集)不被判为过期授权", async () => {
    // 清单没变、持久授权仍有效 → 不会命中「重启后失效」那条;宿主照常要求逐项授权入参。
    await upgradeHost.host.install(manifest, manifest.permissions);
    assert.equal(upgradeHost.host.catalog().modules.find((m) => m.id === manifest.id)?.version, "1.0.0");
  });
  await check("④ 重新逐项同意后:新版本安装成功", async () => { await upgradeHost.host.install(upgraded, upgraded.permissions, "allow-always"); });
  const newRecord = ModulePermissionArchiveSchema.parse(JSON.parse(upgradeHost.archive!)).modules[manifest.id];
  await eq("④ 新决策绑定新版本与新指纹", { v: newRecord?.manifestVersion, perms: newRecord?.granted }, { v: "1.1.0", perms: upgraded.permissions });

  /* ── ⑤ 未知权限 = 拒绝安装 ── */
  const unknown = { ...manifest, permissions: ["files.read", "made.up.permission"] };
  await check("⑤ 未知权限:manifest schema 直接拒(fail-closed)", async () => {
    assert.equal(ModuleManifestSchema.safeParse(unknown).success, false);
    await assert.rejects(makeHost("boot-G-0007").host.install(unknown, manifest.permissions, "allow-once"));
  });

  /* ── ⑥ 决策表损坏 = fail-closed ── */
  const corrupt = makeHost("boot-H-0008", { archive: "{ 这不是合法 JSON" });
  await check("⑥ 坏决策表:安装被拒且原字节不被覆盖", async () => {
    await assert.rejects(corrupt.host.install(manifest, manifest.permissions, "allow-always"), /授权表损坏/);
    assert.equal(corrupt.archive, "{ 这不是合法 JSON");
  });
  const corruptShape = makeHost("boot-I-0009", { archive: JSON.stringify({ version: 1, modules: { [manifest.id]: { granted: ["files.read"], grantedAt: "not-a-date" } } }) });
  await check("⑥ 形状不对的决策表:同样 fail-closed", async () => {
    await assert.rejects(corruptShape.host.install(manifest, manifest.permissions, "allow-always"), /授权表损坏/);
    assert.equal(corruptShape.archive, JSON.stringify({ version: 1, modules: { [manifest.id]: { granted: ["files.read"], grantedAt: "not-a-date" } } }));
  });

  /* ── ⑦ 安装确认 ≠ 永久执行授权(不绕过 ModuleHost)── */
  const revoked = makeHost("boot-J-0010");
  await revoked.host.install(manifest, manifest.permissions, "allow-always");
  await check("⑦ 安装后 invoke 可用", async () => { assert.equal((await revoked.host.invoke(invokeArgs("before-revoke"))).type, "result"); });
  await revoked.host.setPermissions({ moduleId: manifest.id, grantedPermissions: ["files.read"] });
  await check("⑦ 用户撤销 files.write 后:下一次 invoke 立刻被拒(安装卡不是永久授权)", async () => {
    await assert.rejects(revoked.host.invoke(invokeArgs("after-revoke")), /没有 files.write 权限/);
  });
  await check("⑦ setPermissions 写的是持久决策(不是会话级)", () => {
    const rec = ModulePermissionArchiveSchema.parse(JSON.parse(revoked.archive!)).modules[manifest.id];
    assert.equal(rec?.duration, "persistent");
  });

  /* ── ⑧ allow-always 只认桌面发送方 ── */
  await check("⑧ 无渲染端发送方(Agent/扩展委托/面板桥)→ allow-always 收窄为 allow-once", () => {
    assert.equal(resolveInstallDecision({ installConsent: "allow-always" }, {}), "allow-once");
    assert.equal(resolveInstallDecision({ installConsent: "allow-always" }, null), "allow-once");
    assert.equal(resolveInstallDecision({ installConsent: "allow-always" }, { sender: { id: "not-a-number" } }), "allow-once");
  });
  await check("⑧ 真实桌面发送方(sender.id 正整数)→ 保留 allow-always", () => {
    assert.equal(resolveInstallDecision({ installConsent: "allow-always" }, { sender: { id: 7 } }), "allow-always");
  });
  await check("⑧ deny 在任何入口都保持 deny;缺省是 allow-once", () => {
    assert.equal(resolveInstallDecision({ installConsent: "deny" }, { sender: { id: 7 } }), "deny");
    assert.equal(resolveInstallDecision({}, { sender: { id: 7 } }), "allow-once");
    assert.equal(resolveInstallDecision({}, {}), "allow-once");
  });

  /* ── ⑨ 目录形状:两份新分面都过冻结 schema ── */
  await check("⑨ catalog 带 moduleStaleConsents 时通过 ModuleCatalogSchema", () => {
    const catalog = rebooted.host.catalog();
    assert.ok(ModuleCatalogSchema.safeParse(catalog).success, JSON.stringify(ModuleCatalogSchema.safeParse(catalog).error?.issues));
  });

  /* ── ⑩ 安装契约:installConsent 值域收敛 ── */
  await check("⑩ 契约只接受三态字符串;其他值被拒", () => {
    const base = { manifest, confirmReadAccess: true as const, grantedPermissions: [...manifest.permissions], confirmExecutableCode: true as const };
    for (const good of ["allow-once", "allow-always", "deny", undefined]) {
      assert.equal(ModuleInstallSchema.safeParse({ ...base, ...(good === undefined ? {} : { installConsent: good }) }).success, true, String(good));
    }
    for (const bad of ["allow", "always", true, 1]) {
      assert.equal(ModuleInstallSchema.safeParse({ ...base, installConsent: bad }).success, false, String(bad));
    }
  });

  /* ── ⑪ 旧存档兼容:没有 duration 的记录按 persistent ── */
  await check("⑪ 旧存档(无 duration 字段)按 persistent 处理,可跨「重启」", async () => {
    const legacyArchive = JSON.stringify({ version: 1, modules: {
      [manifest.id]: {
        granted: [...manifest.permissions], grantedAt: new Date().toISOString(),
        manifestVersion: manifest.version,
        // 与宿主当前指纹一致(通过一次安装拿到)。
        fingerprint: (() => {
          const probe = ModulePermissionArchiveSchema.parse(JSON.parse(always.archive!)).modules[manifest.id]!;
          return probe.fingerprint;
        })(),
      },
    } });
    const legacy = makeHost("boot-K-0011", { archive: legacyArchive, modules: always.modules });
    legacy.host.restore(JSON.parse(JSON.stringify(manifest)));
    assert.equal(legacy.host.catalog().modulePermissions?.[manifest.id]?.duration, "persistent");
    assert.equal((await legacy.host.invoke(invokeArgs("legacy"))).type, "result");
  });
} finally {
  configureJsOnlyEgressConsentReader(null);
  await rm(temp, { recursive: true, force: true });
}

console.log(`module-install-consent-smoke: ${passed} pass, ${failed} fail`);
if (failed) process.exitCode = 1;
