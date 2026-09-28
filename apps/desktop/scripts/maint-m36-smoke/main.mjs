// MAINT M36 · 三层对账的补充断言(纯文本扫描,零依赖)。
//
// 已有 ipc-parity-smoke 容忍 preload 里"少数几条刻意不走 IPC.KEY 的字面量"。本套把这条收紧为
// **零字面量**:每一条 renderer 可调的 invoke 通道都必须来自 `@contracts/ipc` 的 `IPC` 常量,
// 并在 `RpcMap` 里有同名方法签名 —— 否则"契约先行"只对 337 条成立、对第 338 条不成立。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let checks = 0, failures = 0;
const check = (name, ok, detail) => {
  checks++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const root = resolve(process.cwd(), "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const preload = read("apps/desktop/src/preload/index.ts");
const rpcMap = read("packages/contracts/src/ipc/rpcMap.ts");
const dialogMain = read("apps/desktop/src/main/ipc/dialog.ts");

// 1. preload 不得有字面量通道的 invoke
const literalInvokes = [...preload.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]);
check("preload 的 ipcRenderer.invoke 一律走 IPC 常量(零字面量)", literalInvokes.length === 0, literalInvokes);

// 2. IPC 常量表:每个 preload 用到的 IPC.KEY 都存在
const ipcBlock = rpcMap.slice(rpcMap.indexOf("export const IPC = {"));
// 值可以是字面量,也可以是从域契约转发来的常量(`MEMORY_LIST: MEMORY_LIST_CHANNEL`)。
const ipcKeys = new Set([...ipcBlock.matchAll(/^\s+([A-Z0-9_]+):\s*[^\n]+,\s*(?:\/\/.*)?$/gm)].map((m) => m[1]));
const usedKeys = [...new Set([...preload.matchAll(/IPC\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
const missingKeys = usedKeys.filter((k) => !ipcKeys.has(k));
check("preload 引用的每个 IPC.KEY 都在契约常量表里", missingKeys.length === 0, missingKeys);

// 3. dialog 域:契约常量、RpcMap 签名、主进程注册三者一致
const ipcValue = (key) => (ipcBlock.match(new RegExp(`^\\s+${key}:\\s*"([^"]+)"`, "m")) ?? [])[1];
check("契约有 DIALOG_PICK_FOLDER 常量", ipcValue("DIALOG_PICK_FOLDER") === "dialog:pickFolder", ipcValue("DIALOG_PICK_FOLDER"));
check("RpcMap 有 dialog.pickFolder 方法签名", /"dialog\.pickFolder":\s*\(\)\s*=>\s*Promise</.test(rpcMap));
check("preload 的 pickFolder 走 IPC.DIALOG_PICK_FOLDER 并按 RpcMap 定型",
  /ipcRenderer\.invoke\(IPC\.DIALOG_PICK_FOLDER\)\)?\s*as RpcMap\["dialog\.pickFolder"\]/.test(preload));
check("主进程 dialog.ts 注册的通道字符串与契约一致", dialogMain.includes('"dialog:pickFolder"') || dialogMain.includes("IPC.DIALOG_PICK_FOLDER"));

// 4. 每个 RpcMap 的 dialog.* 方法在 preload 都有绑定(渲染端能调到)
const dialogMethods = [...rpcMap.matchAll(/^\s+"(dialog\.[A-Za-z]+)":/gm)].map((m) => m[1]);
const unbound = dialogMethods.filter((m) => !preload.includes(`RpcMap["${m}"]`));
check("RpcMap 的每个 dialog.* 方法在 preload 都有绑定", dialogMethods.length > 0 && unbound.length === 0, { dialogMethods, unbound });

console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);
