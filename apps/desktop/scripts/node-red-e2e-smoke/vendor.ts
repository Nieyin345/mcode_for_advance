/**
 * T19 real vendor proof: spawn the PRODUCTION registry bootstrap, with a
 * resources-style staging tree and no Node-RED npm package in the data dir.
 * Run from run.sh only when the package stage is present; no user data touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineRuntime, defaultEngineRuntimePorts } from "@main/workflowEngines/runtimeSupervisor.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";

const staged = resolve(process.env.MCODE_T19_STAGED ?? join(process.cwd(), ".tmp", "node-red-release"));
if (!existsSync(join(staged, "manifest.json"))) throw new Error("T19 vendor stage missing: " + staged);
const scratch = mkdtempSync(join(tmpdir(), "mcode-t19-vendor-e2e-"));
const resources = join(scratch, "resources");
mkdirSync(resources);
const data = join(scratch, "isolated-data");
mkdirSync(data);
symlinkSync(staged, join(resources, "node-red"), process.platform === "win32" ? "junction" : "dir");
process.env.MCODE_SMOKE_DATA_ROOT = data;
const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });
const engine = new EngineRuntime("node-red", defaultEngineRuntimePorts);
let failures = 0;
function check(label: string, ok: boolean, value?: unknown): void {
  console.log((ok ? "  ok   " : "  FAIL ") + "★【T19】" + label + (ok ? "" : ": " + JSON.stringify(value)));
  if (!ok) failures++;
}
try {
  const registry = new ProductionWorkflowEngineRegistry();
  const launch = registry.launchSpec("node-red");
  if (!launch) throw new Error("production Node-RED vendor launch spec missing");
  check("真实生产 registry 不依赖 dataDir npm 包", !existsSync(join(launch.dataDir, "node_modules", "node-red")));
  check("真实生产 launch spec 指向 vendor staging", launch.env?.NODE_PATH?.startsWith(join(resources, "node-red", "packages", "node_modules")) === true,
    launch.env?.NODE_PATH);
  const status = await engine.start({
    engineId: "node-red", dataDir: launch.dataDir, command: launch.command, args: launch.args,
    ...(launch.env ? { env: launch.env } : {}), readyTimeoutMs: 30_000,
  });
  check("Node-RED 5.0.8 vendor runtime 真进程 running", status.state === "running" && status.port !== null, status);
  if (!status.port) throw new Error("vendor Node-RED never became ready: " + status.reason);
  const base = "http://127.0.0.1:" + status.port;
  const html = await fetch(base + "/");
  const body = await html.text();
  check("真实 editor GET / 可打开", html.status === 200 && body.includes("red-ui-editor") && body.includes("<title>Node-RED</title>"),
    { status: html.status, bytes: body.length });
  const unauth = await fetch(base + "/settings");
  check("原有 adminAuth 拒绝匿名 Admin API", unauth.status === 401, unauth.status);
  const auth = await fetch(base + "/settings", {
    headers: { Authorization: "Bearer " + launch.env?.MCODE_ENGINE_ADMIN_TOKEN },
  });
  const settings = await auth.json() as { version?: string };
  check("editor 对应的 Node-RED settings.version 是 5.0.8", auth.status === 200 && settings.version === "5.0.8",
    { status: auth.status, version: settings.version });
  const denied = await fetch(base + "/flows", {
    method: "POST",
    headers: { Authorization: "Bearer " + launch.env?.MCODE_ENGINE_ADMIN_TOKEN, "content-type": "application/json" },
    body: JSON.stringify([]),
  });
  check("原有 POST /flows owner 握手无宿主回复时 fail-closed", denied.status === 423, denied.status);
  const bootstrap = readFileSync(join(launch.dataDir, "bootstrap.cjs"), "utf8");
  check("原有服务仅监听 127.0.0.1", bootstrap.includes('server.listen(port, "127.0.0.1"'));
} finally {
  await engine.stop();
  if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
  else Reflect.deleteProperty(process, "resourcesPath");
  rmSync(scratch, { recursive: true, force: true });
}
console.log("node-red-vendor runtime/editor verification: " + (failures ? "FAILED (" + failures + ")" : "PASS"));
if (failures) process.exitCode = 1;
