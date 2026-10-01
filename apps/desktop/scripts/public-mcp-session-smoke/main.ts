import {
  PUBLIC_MCP_ENABLED_SETTING_KEY,
  PUBLIC_MCP_SESSION_ID_SETTING_KEY,
} from "@contracts/ipc/settings";
import {
  addPublicMcpProjectLink,
  initPublicMcp,
  publicMcpProjectIdForSession,
  publicMcpSandboxRoot,
  regeneratePublicMcpProjectLinkSecret,
  removePublicMcpProjectLink,
  setPublicMcpEnabled,
} from "../../src/main/providers/bridge/publicMcpSession.js";
import { resetRepositories, SessionRepo, SettingRepo } from "./stubs/repositories.js";
import { extrasForTest, resetServer, serverCounts, setStartFailure, storeForTest } from "./stubs/publicMcpServer.js";
import { resetTunnel, tunnelStops } from "./stubs/tunnelManager.js";

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
equal("sandbox root of link A", publicMcpSandboxRoot(sa), "/tmp/alpha");
equal("sandbox root of link B", publicMcpSandboxRoot(sb), "/tmp/beta");
equal("unrelated session has no sandbox", publicMcpSandboxRoot("sess-other"), null);
equal("delegate resolves link project", publicMcpProjectIdForSession(sb), "p-b");
const view = extrasForTest().projectLinks() as { projectId: string; projectName: string; missing: boolean }[];
equal("status view lists links", view.map((v) => v.projectName).join(","), "Alpha,Beta");
const oldSecret = links[0]!.secret;
regeneratePublicMcpProjectLinkSecret("p-a");
const regenerated = (store.listProjectLinks() as { projectId: string; secret: string }[]).find((l) => l.projectId === "p-a")!;
equal("regenerate changes the secret", regenerated.secret !== oldSecret, true);
equal("regenerate keeps the session", store.linkSessionId("p-a"), sa);
removePublicMcpProjectLink("p-b");
equal("remove drops the link", (store.listProjectLinks() as unknown[]).length, 1);
equal("removed link session no longer sandboxed as a link", publicMcpSandboxRoot(sb), null);
SettingRepo.set("publicMcp.projectLinks", "{not json");
equal("corrupt links setting = no links", (store.listProjectLinks() as unknown[]).length, 0);
SettingRepo.set("publicMcp.projectLinks", JSON.stringify([{ projectId: "p-a", secret: "short", sessionId: null }]));
equal("too-short secret is ignored", (store.listProjectLinks() as unknown[]).length, 0);
console.log("public MCP session lifecycle smoke passed");
