/** BridgeRegistry 生命周期/配置漂移回归。 */
import { connect } from "node:net";
import type { ApiConfig } from "@contracts/customModel";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

function cfg(baseUrl: string, token: string): ApiConfig {
  return {
    baseUrl,
    authToken: token,
    authMode: "auth_token",
    protocol: "openai",
    selectedModel: "model-a",
    models: [{ id: "model-a" }],
    disableNonEssentialTraffic: true,
  };
}

async function canConnect(localUrl: string): Promise<boolean> {
  const u = new URL(localUrl);
  return await new Promise((resolve) => {
    const socket = connect({ host: u.hostname, port: Number(u.port) });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(600);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => resolve(false));
  });
}

BridgeRegistry.disposeAll();
const firstCfg = cfg("https://one.invalid/v1", "token-one");
const secondCfg = cfg("https://two.invalid/v1", "token-two");

console.log("\n同一 config id 的并发首次初始化");
const [parallel1, parallel2] = await Promise.all([
  BridgeRegistry.acquire("parallel", firstCfg),
  BridgeRegistry.acquire("parallel", firstCfg),
]);
check("并发 acquire 共享同一个 server", parallel1.localUrl === parallel2.localUrl);
BridgeRegistry.release("parallel");
check("释放一个并发持有者后 server 仍活着", await canConnect(parallel1.localUrl));
BridgeRegistry.release("parallel");
check("释放最后一个并发持有者后 server 关闭", !(await canConnect(parallel1.localUrl)));

console.log("\ndisposeAll 与启动中的 bridge 并发");
const starting = BridgeRegistry.acquire("dispose-during-start", firstCfg);
await Promise.resolve();
BridgeRegistry.disposeAll();
let rejectedAfterDispose = false;
try { await starting; } catch { rejectedAfterDispose = true; }
check("disposeAll 阻止并关闭尚未完成的 bridge 启动", rejectedAfterDispose);

console.log("\n共享 + refresh 不增 refCount");
const h1 = await BridgeRegistry.acquire("same", firstCfg);
const h2 = await BridgeRegistry.acquire("same", firstCfg);
check("同配置 acquire 共享一个 server", h1.localUrl === h2.localUrl);
const hSame = await BridgeRegistry.refreshHeld("same", firstCfg);
check("同配置 refresh 沿用 server", hSame.localUrl === h1.localUrl);

console.log("\n配置漂移重建且保留已有 holder 数");
const hNew = await BridgeRegistry.refreshHeld("same", secondCfg);
check("URL/token 变了 → 重建 server", hNew.localUrl !== h1.localUrl);
check("旧 server 已关", !(await canConnect(h1.localUrl)));
check("新 server 在监听", await canConnect(hNew.localUrl));
BridgeRegistry.release("same");
check("两个 holder 里只 release 一个 → server 还活着", await canConnect(hNew.localUrl));
BridgeRegistry.release("same");
check("最后一个 holder release → server 关闭", !(await canConnect(hNew.localUrl)));

console.log("\nRegistry 条目丢失时恢复逻辑 holder");
const orphan = await BridgeRegistry.acquire("recover", firstCfg);
check("恢复场景前 server 在", await canConnect(orphan.localUrl));
BridgeRegistry.disposeAll();
check("dispose 后旧 server 已关", !(await canConnect(orphan.localUrl)));
const recovered = await BridgeRegistry.refreshHeld("recover", firstCfg);
check("refreshHeld 能重建丢失条目", await canConnect(recovered.localUrl));
BridgeRegistry.release("recover");
check("恢复出来的 holder 仍是一份引用", !(await canConnect(recovered.localUrl)));

BridgeRegistry.disposeAll();
console.log(`\nbridge-registry smoke: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
