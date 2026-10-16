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
