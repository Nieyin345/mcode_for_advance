import {
  PUBLIC_MCP_ENABLED_SETTING_KEY,
  PUBLIC_MCP_SESSION_ID_SETTING_KEY,
} from "@contracts/ipc/settings";
import {
  addPublicMcpProjectLink,
  initPublicMcp,
  publicMcpCredentialFor,
  publicMcpProjectIdForSession,
  publicMcpSandboxRoot,
  regeneratePublicMcpProjectLinkSecret,
  removePublicMcpProjectLink,
  revalidatePublicMcpCredential,
  setPublicMcpEnabled,
  startPublicMcpTunnel,
  setPublicMcpTunnelConfig,
  configurePublicMcpRuntime,
} from "../../src/main/providers/bridge/publicMcpSession.js";
import { resetRepositories, SessionRepo, SettingRepo } from "./stubs/repositories.js";
import { extrasForTest, resetServer, serverCounts, setStartFailure, storeForTest } from "./stubs/publicMcpServer.js";
import { resetTunnel, tunnelStops, tunnelCalls } from "./stubs/tunnelManager.js";

function equal(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  console.log(`  ✓ ${label}`);
}
async function rejects(label: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { console.log(`  ✓ ${label}`); return; }
  throw new Error(`${label}: expected rejection`);
}

console.log("public MCP session lifecycle smoke");
resetRepositories(); resetServer(); resetTunnel();
SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "deleted-session");
await rejects("missing project rejects enable", () => setPublicMcpEnabled(true));
equal("failed provisioning rolls enabled back", SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY), "off");
equal("dangling synthetic session id is cleared", SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY), "");
equal("failed provisioning closes any partial server", serverCounts().stops, 1);
equal("failed provisioning closes any tunnel", tunnelStops(), 1);

resetRepositories([{ id: "project-1", name: "Project", path: "/tmp/project", archived: false }]);
resetServer(); resetTunnel(); setStartFailure(true);
await rejects("listen failure rejects enable", () => setPublicMcpEnabled(true));
equal("listen failure rolls enabled back", SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY), "off");
equal("listen was attempted once", serverCounts().starts, 1);
equal("listen failure closes partial server", serverCounts().stops, 1);

resetRepositories([{ id: "project-1", name: "Project", path: "/tmp/project", archived: false }]);
resetServer(); resetTunnel();
await setPublicMcpEnabled(true);
equal("successful enable remains persisted", SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY), "on");
equal("successful enable starts once", serverCounts().starts, 1);

/* ── 多项目并行:每个项目一条链接 —— 各自的密钥 / 合成会话 / 沙箱根 ── */
resetRepositories([
  { id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false },
  { id: "p-b", name: "Beta", path: "/tmp/beta", archived: false },
]);
resetServer(); resetTunnel();
initPublicMcp();
await setPublicMcpEnabled(true);
const store = storeForTest();
addPublicMcpProjectLink("p-a");
addPublicMcpProjectLink("p-b");
addPublicMcpProjectLink("p-a"); // 重复添加不换密钥、不多一条
const links = store.listProjectLinks() as { projectId: string; secret: string }[];
equal("two project links", links.length, 2);
equal("link secrets differ", links[0]!.secret !== links[1]!.secret, true);
equal("link secret is full length", links[0]!.secret.length, 64);
const sa = store.linkSessionId("p-a") as string;
const sb = store.linkSessionId("p-b") as string;
equal("each link has its own session", Boolean(sa && sb && sa !== sb), true);
equal("link session is reused", store.linkSessionId("p-a"), sa);
equal("link session belongs to its project", SessionRepo.get(sa)?.projectId, "p-a");
equal("link session title names the project", SessionRepo.get(sb)?.title, "ChatGPT 直连 · Beta");
equal("link session is bypass", SessionRepo.get(sa)?.permissionMode, "bypassPermissions");
// ★ 「模式不可覆盖」这条规矩对**每条**链接都成立(与默认链接 `ensureSyntheticSession` 同一条)。
//   从前项目链接用一张只增不减的 `armedLinkSessions` 判"钉过没",用户改一次模式后就再也
//   不钉回去了。判据:注入一个记录调用的运行时,**第二次**取同一链接会话时仍须再钉一次。
{
  const pins: string[] = [];
  configurePublicMcpRuntime({
    setSessionPermissionMode: (id, mode) => void pins.push(`${id}:${mode}`),
    bindSession: () => {},
    broadcastSessionChanged: () => {},
  });
  pins.length = 0;
  store.linkSessionId("p-a"); // 第一次(已存在):必须钉
  store.linkSessionId("p-a"); // 第二次:仍必须钉(不可覆盖 = 每次都钉)
  equal("★ 每次取链接会话都重新钉 bypass(不可覆盖)", pins.filter((x) => x === `${sa}:bypassPermissions`).length, 2);
  configurePublicMcpRuntime(null);
}
equal("sandbox root of link A", publicMcpSandboxRoot(sa), "/tmp/alpha");
equal("sandbox root of link B", publicMcpSandboxRoot(sb), "/tmp/beta");
equal("unrelated session has no sandbox", publicMcpSandboxRoot("sess-other"), null);
equal("delegate resolves link project", publicMcpProjectIdForSession(sb), "p-b");

/* ── MC-062:授权快照与复验 ──
 * 鉴权时固化的快照带规范根 + 授权修订号;删链接/轮换密钥后复验必须变红(fail closed),
 * 而不是让在途请求带着失效根继续。 */
const credA = publicMcpCredentialFor("p-a");
equal("★ 有效链接的凭据快照带规范根", credA?.canonicalRoot, "/tmp/alpha");
equal("★ 有效链接快照复验通过", revalidatePublicMcpCredential(credA!), null);
const credDefault = publicMcpCredentialFor(null);
equal("★ 默认链接快照带默认项目根", credDefault?.canonicalRoot, "/tmp/alpha");
equal("★ 默认链接快照复验通过", revalidatePublicMcpCredential(credDefault!), null);
equal("不存在的项目 → 无凭据快照(fail closed)", publicMcpCredentialFor("nope"), null);

const view = extrasForTest().projectLinks() as { projectId: string; projectName: string; missing: boolean }[];
equal("status view lists links", view.map((v) => v.projectName).join(","), "Alpha,Beta");
const oldSecret = links[0]!.secret;
regeneratePublicMcpProjectLinkSecret("p-a");
const regenerated = (store.listProjectLinks() as { projectId: string; secret: string }[]).find((l) => l.projectId === "p-a")!;
equal("regenerate changes the secret", regenerated.secret !== oldSecret, true);
equal("regenerate keeps the session", store.linkSessionId("p-a"), sa);
equal("★ 轮换密钥后旧快照复验变红(授权已变更)", typeof revalidatePublicMcpCredential(credA!), "string");
removePublicMcpProjectLink("p-b");
equal("remove drops the link", (store.listProjectLinks() as unknown[]).length, 1);
equal("removed link session no longer sandboxed as a link", publicMcpSandboxRoot(sb), null);
// 撤销 mcode 那条链接的凭据也已失效(它的会话不再解析出根)→ 复验变红。
equal("★ 撤销的链接不再有凭据快照", publicMcpCredentialFor("p-b"), null);
SettingRepo.set("publicMcp.projectLinks", "{not json");
equal("corrupt links setting = no links", (store.listProjectLinks() as unknown[]).length, 0);
SettingRepo.set("publicMcp.projectLinks", JSON.stringify([{ projectId: "p-a", secret: "short", sessionId: null }]));
equal("too-short secret is ignored", (store.listProjectLinks() as unknown[]).length, 0);
await setPublicMcpEnabled(false);
equal("disable persists off", SettingRepo.get(PUBLIC_MCP_ENABLED_SETTING_KEY), "off");
equal("disable stops tunnel", tunnelStops() > 0, true);
equal("disable stops server", serverCounts().stops > 0, true);
SettingRepo.set("publicMcp.agentDelegate", "1");
equal("legacy delegate flag does not advertise public delegation", extrasForTest().tunnelConfig().agentDelegate, false);
const beforeMode = SettingRepo.get("publicMcp.tunnelMode");
await rejects("legacy clients cannot re-enable delegation", () => setPublicMcpTunnelConfig({ mode: "external", hostname: "fixture.invalid", agentDelegate: true }));
equal("rejected delegate update does not change tunnel config", SettingRepo.get("publicMcp.tunnelMode"), beforeMode);
resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
resetServer(); resetTunnel(); initPublicMcp();
await setPublicMcpEnabled(false);
startPublicMcpTunnel();
equal("disabled endpoint cannot launch a tunnel", tunnelCalls().length, 0);
await setPublicMcpTunnelConfig({ mode: "quick", hostname: "" });
const enabledStatus = await setPublicMcpEnabled(true);
equal("enable status reflects actual backend flag", enabledStatus.enabled, true);
startPublicMcpTunnel();
equal("quick mode starts a quick tunnel", tunnelCalls()[0]?.config.mode, "quick");
equal("quick tunnel targets the actual listener", tunnelCalls()[0]?.port, enabledStatus.port);
SettingRepo.set("publicMcp.mobileHostname", "mobile-fixture.invalid");
await setPublicMcpTunnelConfig({ mode: "named", hostname: "https://named-fixture.invalid/", token: "isolated-fixture-token", fixedPort: 17331 });
equal("named mode rebinds the listener", serverCounts().starts, 2);
equal("named mode restarts the active tunnel", tunnelCalls()[1]?.config.mode, "named");
equal("named tunnel uses configured port", tunnelCalls()[1]?.port, 17331);
equal("hostname is normalized before use", tunnelCalls()[1]?.config.hostname, "named-fixture.invalid");
equal("MCP config does not overwrite mobile hostname", SettingRepo.get("publicMcp.mobileHostname"), "mobile-fixture.invalid");
await setPublicMcpTunnelConfig({ mode: "external", hostname: "external-fixture.invalid", fixedPort: 17331 });
startPublicMcpTunnel();
equal("external mode never spawns a managed tunnel", tunnelCalls().length, 2);
equal("changing to external stops the old managed tunnel", tunnelStops() >= 3, true);
await setPublicMcpTunnelConfig({ mode: "external", hostname: "external-fixture.invalid", clearToken: true });
equal("clear token really removes the stored token", extrasForTest().tunnelConfig().tokenHint, "");
const disabledStatus = await setPublicMcpEnabled(false);
equal("disable returns backend off", disabledStatus.enabled, false);
equal("disable returns no listening port", disabledStatus.port, 0);

/* ── MC-089:淘汰 / 释放的留存审计要**跨重启可回读**(不只是进程内有界环)──
 *
 * 台账 remaining 点名「留存审计是进程内有界环,未落盘持久化(重启即失)」。本段证:
 * 淘汰(受控保留忙 owner)与明确释放两种事件都经**持久出口**落进设置表,清掉进程内
 * 环(模拟重启)后仍读得回来。走真实生产路径:真 `initPublicMcp` 装配的持久出口
 * (上面第 136 行已 initPublicMcp)→ 真 issueClientSession 真淘汰 + 真探针/计数/释放器
 * → 断言落盘。 */
{
  const settingsStore = SettingRepo;
  const {
    issueClientSession,
    rememberSyntheticOwner,
    pruneOrphanedOwners,
    releaseOwnerResources,
    retentionAuditLog,
    registerOwnerWorkProbe,
    registerOwnerResourceCounter,
    registerOwnerResourceReleaser,
    __setMaxIssuedForTest,
    __resetPublicClientSessions,
  } = await import("../../src/main/providers/bridge/publicClientSessions.js");
  const { publicMcpRetentionAudit } = await import("../../src/main/providers/bridge/publicMcpSession.js");

  // 清一张白纸(上面前几段可能已写过审计)。
  settingsStore.set("publicMcp.retentionAudit", "");
  __resetPublicClientSessions();
  equal("起步:持久审计为空", publicMcpRetentionAudit().length, 0);

  __setMaxIssuedForTest(3);
  const orphan = issueClientSession("cred-doomed");
  rememberSyntheticOwner("sess_audit_persist", orphan);
  // 只多签发 3 条(刚好把 issued 顶到 4 > 上限 3)→ orphan 被真淘汰,且它仍在**有界**
  // 的 `evicted`(上限 3)里 —— 否则再多签发会让 `evicted` 先把最早的 orphan 顶掉,
  // 留存报告就查不到它当初的凭据了(那是在测「淘汰集有界」而不是「凭据随淘汰留存」)。
  for (let i = 0; i < 3; i += 1) issueClientSession("cred-churn"); // 真淘汰 orphan
  // 该 owner 名下"还有活资源"—— 注册真探针 / 计数(与 agentTools 同一注册姿势)。
  const offProbe = registerOwnerWorkProbe((id) => id === orphan);
  const offCounter = registerOwnerResourceCounter((id) =>
    id === orphan ? { processes: 2, searches: 0, ssh: 0 } : { processes: 0, searches: 0, ssh: 0 },
  );
  const releaseCalls: string[] = [];
  const offReleaser = registerOwnerResourceReleaser((id) => void releaseCalls.push(id));

  pruneOrphanedOwners();
  const afterPrune = publicMcpRetentionAudit();
  const retained = afterPrune.at(-1);
  equal("★ 淘汰留存事件已**落盘**(durable 审计读到 retained-busy)", retained?.kind, "retained-busy");
  equal(
    "★ …且带当初的凭据(运维看得见哪条链接死了)",
    retained?.kind === "retained-busy" ? retained.keptBusy.find((k) => k.ownerId === orphan)?.credentialId : undefined,
    "cred-doomed",
  );
  equal(
    "★ …且带活资源计数",
    retained?.kind === "retained-busy" ? retained.keptBusy.find((k) => k.ownerId === orphan)?.resources.processes : undefined,
    2,
  );

  // 模拟重启:清掉进程内有界环 —— 持久那份必须还在。
  __resetPublicClientSessions();
  equal("重启后进程内环已清空", retentionAuditLog().length, 0);
  const survived = publicMcpRetentionAudit();
  equal(
    "★ 重启后持久审计仍在(不随进程内环消失)",
    survived.some((e) => e.kind === "retained-busy" && e.keptBusy.some((k) => k.ownerId === orphan)),
    true,
  );

  // 明确释放也留账(released 事件同样落盘)。
  const rel = releaseOwnerResources(orphan);
  equal("释放成功", rel.reason, "released");
  equal("释放器真的被调了(资源被终止一次)", releaseCalls.includes(orphan), true);
  const releasedEvt = publicMcpRetentionAudit().at(-1);
  equal("★ 明确释放事件也已落盘(durable 审计读到 released)", releasedEvt?.kind, "released");
  equal("★ …带被释放的 owner", releasedEvt?.kind === "released" ? releasedEvt.ownerId : undefined, orphan);

  offProbe();
  offCounter();
  offReleaser();
  __setMaxIssuedForTest(null);
  __resetPublicClientSessions();
  settingsStore.set("publicMcp.retentionAudit", "");
}

/* ── ★ MC-034 验收条件「失败释放」:释放器抛错必须如实分类,不谎报成功、不冒用 no-releaser ──
 *
 * 台账验收条件点名要模拟「失败释放」。从前 `releaseOwnerResources` 在释放器抛错时返回
 * `reason: "no-releaser"` —— 运维看到它会去查"释放器接没接上",实际该查的是"接了但杀不掉";
 * 而且它与真正的 no-releaser 混在一起,**无法从返回值区分**。这里钉:
 *  ① 失败报 `release-failed`(不是 released,也不是 no-releaser);
 *  ② 归属记录**不回收**(下次还能再试),`evicted` 里的原始凭据也**不能**被抹掉;
 *  ③ 失败后把释放器换成能成功的 → 同一 owner 第二次能真的释放并留 `released` 审计,
 *     且审计里的 `credentialId` 仍是**原始凭据** —— 这就是「忙 owner 的凭据身份直到资源
 *     安全释放都可溯源」的终态(MC-034 的保证跨过失败重试)。 */
{
  const {
    issueClientSession,
    rememberSyntheticOwner,
    pruneOrphanedOwners,
    releaseOwnerResources,
    registerOwnerWorkProbe,
    registerOwnerResourceReleaser,
    registerRetentionAuditSink,
    __setMaxIssuedForTest,
    __trackedOwnerCount,
    __resetPublicClientSessions,
  } = await import("../../src/main/providers/bridge/publicClientSessions.js");

  __resetPublicClientSessions();
  __setMaxIssuedForTest(1);
  const owner = issueClientSession("cred-fail-release");
  rememberSyntheticOwner("sess_fail_release", owner);
  const offProbe = registerOwnerWorkProbe((id) => id === owner); // 恒忙,确保它被受控保留
  for (let i = 0; i < 3; i += 1) issueClientSession(`cred-fail-churn-${i}`); // 真淘汰 owner
  const keptBusy = pruneOrphanedOwners().keptBusyDetails.find((k) => k.ownerId === owner);
  equal("★ MC-034·失败释放(前置):忙 owner 被保留且凭据可溯源", keptBusy?.credentialId, "cred-fail-release");

  const auditEvents: Array<{ kind: string; credentialId: string | null }> = [];
  const offSink = registerRetentionAuditSink((e) => {
    if (e.kind === "released") auditEvents.push({ kind: e.kind, credentialId: e.credentialId });
  });
  // 第一个释放器:抛错(模拟进程杀不掉 / SSH 关闭异常)。
  const offFailing = registerOwnerResourceReleaser(() => {
    throw new Error("fixture: terminator failed");
  });
  const failed = releaseOwnerResources(owner);
  equal("★ MC-034·失败释放:报 release-failed(不谎报 released)", failed.reason, "release-failed");
  equal("★ MC-034·失败释放:released=false", failed.released, false);
  equal("★ MC-034·失败释放:失败不冒用 no-releaser(两种原因必须可分)", failed.reason !== "no-releaser", true);
  equal("★ MC-034·失败释放:归属不回收(下次还能再试)", __trackedOwnerCount(), 1);
  equal("★ MC-034·失败释放:失败时不发 released 审计(不假装释放了)", auditEvents.length, 0);
  // 凭据映射也必须还在 —— 失败后重新问一次 probe/审计面。
  equal(
    "★ MC-034·失败释放:失败后原始凭据仍可溯源(evicted 未被动过)",
    pruneOrphanedOwners().keptBusyDetails.find((k) => k.ownerId === owner)?.credentialId,
    "cred-fail-release",
  );
  // 第二次:能成功的释放器接上 → 真释放,且审计带原凭据。
  offFailing();
  const offOk = registerOwnerResourceReleaser(() => {});
  const ok = releaseOwnerResources(owner);
  equal("★ MC-034·失败释放:换掉失败释放器后重试成功", ok.reason, "released");
  equal("★ MC-034·失败释放:成功释放的审计带原始凭据(跨失败重试仍可溯源)", auditEvents.at(-1)?.credentialId, "cred-fail-release");
  equal("★ MC-034·失败释放:成功后归属回收", __trackedOwnerCount(), 0);

  offProbe();
  offOk();
  offSink();
  __setMaxIssuedForTest(null);
  __resetPublicClientSessions();
}

/* ── ★ 复核(2026-10-17):`evicted` 的界与清理路径 —— 忙 owner 转闲后到底谁删条目? ──
 *
 * **被复核的怀疑**(不照单全收):「`evicted` 只在 owner 仍忙时才被处理;忙 owner 后来
 * 闲下来、资源释放后,**没有任何路径**删它的条目 → 持续 `initialize` churn 下
 * `evicted` 无界增长(内存泄漏),而 `issued` 有上限」。
 *
 * 读源码后该怀疑**不成立**,逐条对应:
 *  - 忙 owner 的条目被**保留**是 MC-034 的有意行为:淘汰集容量裁剪跳过仍忙的
 *    (`publicClientSessions.ts:90-94`);
 *  - 转闲后,**每次 `initialize` 都会跑**的 `pruneOrphanedOwners` 在同一分支里
 *    `owners.delete` + `evicted.delete`(`publicClientSessions.ts:510-514`,
 *    调用点 `mcpEndpoint.ts:356`)—— 条目会被删,不是「只涨不落」;
 *  - 不在归属表里的(合成会话已被删的)空闲条目由签发时的容量裁剪兜底(同 :90-94);
 *  - 全部仍忙时确实**没有**裁剪路径 —— 这是有意的;此时超上限的部分恰好等于
 *    「仍忙的 owner 数」,它们转闲后的下一次签发就把它裁回上限。
 *
 * 本段把上面几条钉成断言。`evicted` 是模块私有 Map,这里只用**既有**可观察面证明
 * 条目去留,不为此加测试后门:
 *  - `pruneOrphanedOwners().keptBusyDetails[].credentialId`(归属表里的 owner);
 *  - `releaseOwnerResources` 的 `released` 审计事件里的 `credentialId` —— 读的就是
 *    `evicted.get(ownerId) ?? null`(publicClientSessions.ts:340),条目没了就是 null。
 *
 * 本段用**局部收集器**而不是逐条 throw:一次运行报出所有红断言(变异验证时能同时
 * 看到「哪几条红了」),最后统一失败。
 */
{
  const {
    issueClientSession,
    rememberSyntheticOwner,
    forgetSyntheticSession,
    pruneOrphanedOwners,
    releaseOwnerResources,
    registerOwnerWorkProbe,
    registerOwnerResourceReleaser,
    registerRetentionAuditSink,
    __setMaxIssuedForTest,
    __resetPublicClientSessions,
  } = await import("../../src/main/providers/bridge/publicClientSessions.js");

  /** 局部收集器:`equal` 会在第一条就 throw,这里要一次看全。 */
  const failures: string[] = [];
  const verify = (label: string, actual: unknown, expected: unknown): void => {
    if (actual === expected) { console.log(`  ✓ ${label}`); return; }
    const msg = `${label}: expected ${String(expected)}, got ${String(actual)}`;
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  };

  __resetPublicClientSessions();
  __setMaxIssuedForTest(2);

  /* ① 生产路径:忙 owner 被淘汰 → 转闲 → 每次 initialize 都会跑的 prune 把条目删掉。 */
  {
    let busyNow = new Set<string>();
    const offProbe = registerOwnerWorkProbe((id) => busyNow.has(id));
    const released: Array<string | null> = [];
    const offSink = registerRetentionAuditSink((e) => { if (e.kind === "released") released.push(e.credentialId); });
    const offReleaser = registerOwnerResourceReleaser(() => {});

    const busy = issueClientSession("cred-idle-later");
    rememberSyntheticOwner("sess_idle_later", busy);
    busyNow = new Set([busy]);
    for (let i = 0; i < 5; i += 1) issueClientSession(`cred-churn-${i}`);
    // 仍忙:prune(initialize 路径)保留它,且**凭据仍可溯源**(MC-034 的既有保证)。
    const kept = pruneOrphanedOwners().keptBusyDetails.find((k) => k.ownerId === busy);
    verify("★ 复核①:忙 owner 被淘汰后凭据仍在(MC-034 的保证不变)", kept?.credentialId, "cred-idle-later");

    // 资源全部结束(转闲)→ 下一次 initialize 的 prune 收掉归属与 evicted 条目。
    busyNow = new Set();
    const pruned = pruneOrphanedOwners();
    verify("★ 复核①:忙 owner 转闲后被回收(不是永远保留)", pruned.pruned.includes(busy), true);
    // 直接读 evicted 的去留:释放审计的 credentialId 读的就是 evicted.get(...)。
    // 若是「没有任何路径删条目」,这里读到的仍是 "cred-idle-later"。
    releaseOwnerResources(busy);
    verify(
      "★ 复核①:evicted 条目已被 prune 删除(释放审计读回 null,不是原凭据)",
      released.at(-1),
      null,
    );

    offProbe();
    offSink();
    offReleaser();
    __resetPublicClientSessions();
  }

  /* ② 容量路径:不在归属表里的空闲条目(合成会话已删)由签发时的容量裁剪收掉;
   *    全部仍忙时没有裁剪路径(有意),超上限部分 = 仍忙 owner 数。 */
  {
    const busyAll = new Set<string>();
    const offProbe = registerOwnerWorkProbe((id) => busyAll.has(id));
    const released: Array<string | null> = [];
    const offSink = registerRetentionAuditSink((e) => { if (e.kind === "released") released.push(e.credentialId); });
    const offReleaser = registerOwnerResourceReleaser(() => {});

    const issued: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const o = issueClientSession(`cred-${i}`);
      issued.push(o);
      busyAll.add(o);
      rememberSyntheticOwner("sess_evict_bound", o);
    }
    // 全忙:容量裁剪无人可裁 → 超出上限的淘汰条目全部保留(每条都能溯源)。
    const details = pruneOrphanedOwners().keptBusyDetails;
    verify("★ 复核②:全忙时保留的条目数 = 淘汰数(超过签发上限,有意)", details.length, 4);
    verify("★ 复核②:…且每条都带着原凭据(没有因容量被顶掉)", details.every((d) => d.credentialId !== null), true);

    // 合成会话被删 → 这些 owner 不再出现在归属表里;prune 再也管不到它们的 evicted 条目。
    forgetSyntheticSession("sess_evict_bound");
    // 资源全部结束,再签发一次(生产里就是一次 initialize):容量裁剪把空闲条目裁回上限。
    busyAll.clear();
    issueClientSession("cred-next");

    // owner[0] 是最早的淘汰条目,应已被容量裁剪删掉;owner[3] 是容量内的,应仍在。
    releaseOwnerResources(issued[0]!);
    verify("★ 复核②:空闲的旧淘汰条目被容量裁剪删掉(审计读回 null)", released.at(-1), null);
    releaseOwnerResources(issued[3]!);
    verify("★ 复核②:容量内的淘汰条目仍在(带原凭据)", released.at(-1), "cred-3");

    offProbe();
    offSink();
    offReleaser();
    __resetPublicClientSessions();
  }

  /* ③ 持续 churn:忙→闲 循环多轮,每一轮的条目都被下一次 initialize 的 prune 收掉 ——
   *    没有任何一轮的凭据映射残留(这就是「有界」的可观察证明:条目不是只涨不落)。 */
  {
    let busyNow = new Set<string>();
    const offProbe = registerOwnerWorkProbe((id) => busyNow.has(id));
    const released: Array<string | null> = [];
    const offSink = registerRetentionAuditSink((e) => { if (e.kind === "released") released.push(e.credentialId); });
    const offReleaser = registerOwnerResourceReleaser(() => {});
    const stale: Array<string | null> = [];

    for (let cycle = 0; cycle < 8; cycle += 1) {
      const owner = issueClientSession(`cred-cycle-${cycle}`);
      rememberSyntheticOwner(`sess_cycle_${cycle}`, owner);
      busyNow = new Set([owner]);
      for (let i = 0; i < 4; i += 1) issueClientSession(`cred-cycle-${cycle}-churn-${i}`); // 顶掉 owner
      pruneOrphanedOwners(); // 仍忙 → 受控保留
      busyNow = new Set(); // 资源结束
      pruneOrphanedOwners(); // 下一次 initialize → 回收归属与 evicted 条目
      const before = released.length;
      releaseOwnerResources(owner);
      // ⚠️ 不用 `?? null` 吞掉「没发事件」:没发审计与「发了但凭据为 null」是两件事,
      //    前者说明释放路径根本没跑(空转),必须红。
      stale.push(released.length === before + 1 ? (released.at(-1) ?? null) : "__no_audit_event__");
      forgetSyntheticSession(`sess_cycle_${cycle}`);
    }
    verify("★ 复核③:8 轮忙→闲 churn 后没有任何残留的凭据映射(条目不是只涨不落)", stale.every((c) => c === null), true);

    offProbe();
    offSink();
    offReleaser();
    __resetPublicClientSessions();
  }

  __setMaxIssuedForTest(null);

  if (failures.length > 0) throw new Error(`复核断言失败(${failures.length} 条):\n${failures.join("\n")}`);
}

/* ── ★ MC-034:忙 owner 的凭据映射不能被**淘汰集的容量**顶掉 ──
 *
 * 上面那段刻意只 churn 3 次,好让 orphan 留在有界的 `evicted`(上限 3)里。可真实场景是
 * **大量初始化签发**:最早的忙 owner 会被后来的淘汰记录顶出 `evicted`,于是
 * `pruneOrphanedOwners` 保留它时 `credentialId` 变 `null` —— 运维再也说不清"哪条凭据死了、
 * 名下还挂着资源"(台账 E1:`EARLIEST_CREDENTIAL null`)。
 *
 * 本段放开 churn:orphan 名下**始终有活资源**,连签远超 `evicted` 上限的条数 → 它仍在
 * `evicted` 里、仍带着原始凭据。 */
{
  const {
    issueClientSession,
    rememberSyntheticOwner,
    pruneOrphanedOwners,
    registerOwnerWorkProbe,
    __setMaxIssuedForTest,
    __resetPublicClientSessions,
  } = await import("../../src/main/providers/bridge/publicClientSessions.js");

  __resetPublicClientSessions();
  __setMaxIssuedForTest(2);
  const busy = issueClientSession("cred-original");
  rememberSyntheticOwner("sess_mc034", busy);
  // 名下始终有活资源(探针恒真)—— 与真实"还有进程/搜索/SSH 在跑"一致。
  const off = registerOwnerWorkProbe((id) => id === busy);
  // 连签远超 evicted 上限(2)的条数:若容量裁剪不看"忙不忙",busy 的凭据映射会被顶掉。
  for (let i = 0; i < 10; i += 1) issueClientSession(`cred-churn-${i}`);

  pruneOrphanedOwners(); // 第一次:受控保留忙 owner(这一步是台账 E1 复现点)
  // 再来一批 churn + 再 prune,确认凭据**持续**留存(不是碰巧第一次还在)。
  for (let i = 0; i < 10; i += 1) issueClientSession(`cred-more-${i}`);
  const kept = pruneOrphanedOwners().keptBusyDetails;
  const busyDetail = kept.find((k) => k.ownerId === busy);
  equal("★ MC-034:忙 owner 被受控保留", busyDetail !== undefined, true);
  equal(
    "★ MC-034:忙 owner 的原始凭据仍在(没被淘汰集容量顶成 null)",
    busyDetail?.credentialId,
    "cred-original",
  );

  off();
  __setMaxIssuedForTest(null);
  __resetPublicClientSessions();
}

/* ── ★ MC-022:损坏的公网配置**拒绝写入**,不静默覆盖原有链接 / 审计 ──
 *
 * 两处副本同根因(读不懂 → 空表 → 读-改-写整表覆盖):
 *   ① 项目链接表(readProjectLinks → add/remove/regenerate);
 *   ② 留存审计环(publicMcpRetentionAudit → appendRetentionAudit)。
 * 读侧降级成空仍然对(那是给"没配过"用的);错的是**拿它当写基准**。 */
{
  const { addPublicMcpProjectLink, removePublicMcpProjectLink, publicMcpRetentionAudit } =
    await import("../../src/main/providers/bridge/publicMcpSession.js");

  // ① 项目链接表:盘上是**截断的**原链接(含 p-a)→ 给新项目加链接必须拒绝、原字节不动。
  resetRepositories([{ id: "p-new", name: "New", path: "/tmp/new", archived: false }]);
  SettingRepo.set("publicMcp.projectLinks", '[{"projectId":"p-a","secret":"' + "a".repeat(40));
  const corruptBytes = SettingRepo.get("publicMcp.projectLinks");
  let addThrew = false;
  try { addPublicMcpProjectLink("p-new"); } catch { addThrew = true; }
  equal("★ MC-022:链接表损坏时新增 → 拒绝(不静默)", addThrew, true);
  equal("★ MC-022:原字节一字未动(没被新链接覆盖)", SettingRepo.get("publicMcp.projectLinks"), corruptBytes);
  // 损坏时删除也必须拒(否则会拿空表回写)。
  const delThrew = (() => { try { removePublicMcpProjectLink("p-a"); return false; } catch { return true; } })();
  equal("★ MC-022:链接表损坏时删除 → 也拒绝(不拿空表回写)", delThrew, true);
  equal("★ MC-022:删除被拒后原字节仍未动", SettingRepo.get("publicMcp.projectLinks"), corruptBytes);

  // ② 留存审计环:盘上是截断的旧环(含一条 retained-busy)→ 真触发一次追加事件,不得覆盖它。
  SettingRepo.set("publicMcp.retentionAudit", '[{"kind":"retained-busy","at":1,"keptBusy":[{"ownerId":"o1","credentialId":"cred-x","resources":{"processes":1,"searches":0,"ssh":0}}],"prunedCount":0}');
  const corruptRing = SettingRepo.get("publicMcp.retentionAudit");
  equal("MC-022:坏环读成空(读侧降级不变)", publicMcpRetentionAudit().length, 0);
  // 走真扇出路径:签发 → 淘汰一份忙 owner → prune 触发 retained-busy 事件 → 经持久出口
  // `appendRetentionAudit` 落盘。若这里没拦住,坏环会被覆盖成"只含这条新事件"的干净环。
  const { issueClientSession: issueA, rememberSyntheticOwner: rememberA, pruneOrphanedOwners: pruneA,
    registerOwnerWorkProbe: probeA, __setMaxIssuedForTest: setMaxA, __resetPublicClientSessions: resetA } =
    await import("../../src/main/providers/bridge/publicClientSessions.js");
  resetA();
  setMaxA(1);
  const busyA = issueA("cred-busy-a");
  rememberA("sess_mc022", busyA);
  const offProbeA = probeA((id) => id === busyA);
  for (let i = 0; i < 3; i += 1) issueA(`cred-c-${i}`); // 顶掉 busyA
  pruneA(); // 触发 retained-busy 扇出 → appendRetentionAudit
  equal("★ MC-022:坏审计环经真追加路径后**原字节未被覆盖**(没被新事件顶成干净环)",
    SettingRepo.get("publicMcp.retentionAudit"), corruptRing);
  offProbeA();
  setMaxA(null);
  resetA();
}

/* ── MC-018:显式选的沙箱项目**失效**时绝不静默改绑 ──
 *
 * 从前 `publicMcpProjectId` 把"用户选了 A、A 没了"与"从没选过"当同一态,都回退到
 * 第一个非归档项目 —— 于是带**同一个公网密钥**的旧链接在 A 消失后转而授权 B,
 * 用户没确认过任何东西。现在两态分开:`unset` 才回退,`missing` fail closed。 */
{
  const {
    publicMcpProjectBinding,
    publicMcpProjectId,
  } = await import("../../src/main/providers/bridge/publicMcpSession.js");

  // 场景:用户显式选了 A、开过公网;之后 A 被删,库里只剩 B。
  resetRepositories([{ id: "p-b", name: "Beta", path: "/tmp/beta", archived: false }]);
  SettingRepo.set("publicMcp.projectId", "p-a");

  const binding = publicMcpProjectBinding();
  equal("★ MC-018:选了 A 但 A 没了 → 判成 missing(不是 unset)", binding.state, "missing");
  equal("★ MC-018:missing 态不解析出任何项目(绝不落到 B)", publicMcpProjectId(), null);
  equal("★ MC-018:missing 态带回失效的 id 供界面提示", binding.state === "missing" ? binding.chosen : null, "p-a");
  const statusView = extrasForTest().sandboxProjectMissingId();
  equal("★ MC-018:状态把这件事实报给设置页", statusView, "p-a");

  // 正控:从没选过(unset)时回退第一个项目是**设计**,不许被修成 fail closed。
  SettingRepo.set("publicMcp.projectId", "");
  equal("正控:没选过 → unset", publicMcpProjectBinding().state, "unset");
  equal("正控:没选过 → 仍回退第一个非归档项目(B)", publicMcpProjectId(), "p-b");

  // 正控:选了、项目还在 → valid,解析出它。
  SettingRepo.set("publicMcp.projectId", "p-b");
  equal("正控:选了且有效 → valid", publicMcpProjectBinding().state, "valid");
  equal("正控:选了且有效 → 解析出那个项目", publicMcpProjectId(), "p-b");

  // 默认链接的凭据快照在 missing 态 fail closed(入口据此回 404,不落到任何项目)。
  SettingRepo.set("publicMcp.projectId", "p-a");
  equal("★ MC-018:missing 态默认链接拿不到凭据快照(入口 fail closed)", publicMcpCredentialFor(null), null);

  // 显式重选一个有效项目 → 立刻恢复(用户重新指定之后才能再用)。
  resetRepositories([
    { id: "p-b", name: "Beta", path: "/tmp/beta", archived: false },
    { id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false },
  ]);
  SettingRepo.set("publicMcp.projectId", "p-a"); // A 回来了
  equal("★ MC-018:项目恢复(或用户重选)后 binding 回 valid", publicMcpProjectBinding().state, "valid");
  equal("★ MC-018:恢复后凭据快照又能解析出根", publicMcpCredentialFor(null)?.canonicalRoot, "/tmp/alpha");
}

console.log("public MCP session lifecycle smoke passed");
