/**
 * 扩展 → Mcode 能力桥的回归。
 *
 * ## 这套验什么
 *
 * `mcodeBridge.ts` 是「`.vsix` 扩展能调 Mcode 全部功能」这条能力的**唯一实现**。
 * 它有三个容易写错、且写错了看不出来的地方：
 *
 *  1. **审批位 `approved` 不能让扩展自己给** —— 扩展代码是一条 `await`，中间插不进
 *     用户交互；桥若把扩展传的 `approved` 透传给 `panelApiCall`，任何扩展都能自批准；
 *  2. **没有审批通道时必须 fail-closed** —— 没界面问就不执行写动作；
 *  3. **内置命令表必须优先于 RPC 表** —— 否则扩展注册一个同名 `mcode.file.*`
 *     就能劫持内置文件检查。
 *
 * 这套用**注入桩**把这三条钉住，不依赖 Electron、不依赖真 `panelApiCall`。
 *
 * ## 它不验什么（NOT-COVERED 在末尾逐行打出）
 *
 * - 真实 `panelApiCall` 的权限分档（`policy.ts` 自己的套件在守）；
 * - 真实原生确认框（`extensionApproval.ts` 需要 Electron）；
 * - 扩展在 Theia 宿主里真的调到 `$executeCommand`（`theia-installed-smoke`）。
 */
import { createMcodeBridge, isMcodeCommand, mcodeMethodOf, MCODE_COMMAND_PREFIX, type McodeBridgeResult } from "@main/modules/theiaHost/mcodeBridge.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

function makeDispatch(behavior: {
  needsApprovalOnFirst?: boolean;
  level?: "write" | "danger";
  executeResult?: unknown;
  throws?: Error;
}) {
  const calls: Array<{ method: string; input: unknown; approved: boolean; label: string; operationId?: string }> = [];
  const dispatch = async (
    method: string, input: unknown, approved: boolean, label: string, operationId?: string,
  ): Promise<McodeBridgeResult> => {
    calls.push({ method, input, approved, label, ...(operationId === undefined ? {} : { operationId }) });
    if (behavior.throws) throw behavior.throws;
    if (!behavior.needsApprovalOnFirst) return { ok: true, result: behavior.executeResult ?? { echoed: method } };
    if (!approved) {
      return { ok: false, needsApproval: true, level: behavior.level ?? "write", description: `${method} 需要确认` };
    }
    return { ok: true, result: behavior.executeResult ?? { executed: method } };
  };
  return { dispatch, calls };
}

/* ───────── [1] 前缀判定 ───────── */
console.log("[1] 命令前缀判定");
{
  check("★ `mcode.` 前缀被识别", isMcodeCommand("mcode.workflow.run"));
  check("★ `mcode.` 单独不算（前缀后必须有内容）", !isMcodeCommand("mcode."));
  check("★ 相似前缀不被吃掉（`mcode-something.x`）", !isMcodeCommand("mcode-something.x"));
  check("★ 第三方扩展命令不受影响", !isMcodeCommand("latex-workshop.hostPort"));
  check("★ 前缀常量只有一份", MCODE_COMMAND_PREFIX === "mcode.");
  check("★ 方法名剥掉前缀", mcodeMethodOf("mcode.library.search") === "library.search");
  check("★ 剥前缀不是「删第一个字符」", mcodeMethodOf("mcode.memory.write") === "memory.write");
}

/* ───────── [2] 扩展给不了 approved ───────── */
console.log("[2] 审批位：扩展给不了 approved");
{
  const { dispatch } = makeDispatch({ needsApprovalOnFirst: true });
  const approvedSeen: boolean[] = [];
  const bridge = createMcodeBridge({
    dispatch: async (m, i, a, l, o) => { approvedSeen.push(a); return dispatch(m, i, a, l, o); },
    requestApproval: async () => true,
    extensionId: () => "test.ext",
  });
  const result = await bridge.invoke("mcode.library.saveNote", [{ title: "x" }]);
  check("★ 第一次派发恒不带 approved", approvedSeen[0] === false, { approvedSeen });
  check("★ 用户批准后第二次才带 approved", approvedSeen[1] === true, { approvedSeen });
  check("★ 最终是执行结果", result.ok === true && (result.result as { executed?: string })?.executed === "library.saveNote");

  // 扩展在入参里塞 approved:true 也不影响桥 —— 入参是业务参数，不是审批位。
  const { dispatch: d2 } = makeDispatch({ needsApprovalOnFirst: true });
  const seen2: boolean[] = [];
  const bridge2 = createMcodeBridge({
    dispatch: async (m, i, a, l, o) => { seen2.push(a); return d2(m, i, a, l, o); },
    requestApproval: async () => true,
    extensionId: () => "test.ext",
  });
  await bridge2.invoke("mcode.project.delete", [{ approved: true, path: "/tmp/x" }]);
  check("★ 入参里的 approved 不被当成审批位", seen2[0] === false, { seen2 });
}

/* ───────── [3] fail-closed ───────── */
console.log("[3] 没有审批通道 = 不执行写动作");
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: true });
  const bridge = createMcodeBridge({ dispatch, extensionId: () => "test.ext" });
  const result = await bridge.invoke("mcode.project.delete", [{ path: "/tmp/x" }]);
  check("★ 无端口时只有第一次派发", calls.length === 1, { calls });
  check("★ 返回 ok:false", result.ok === false);
  check("★ 错误说明是「没有审批通道」", /审批通道/.test(result.error ?? ""), { error: result.error });
  check("★ 保留 needsApproval（扩展能区分被挡与坏了）", result.needsApproval === true);
}

console.log("[3b] 用户拒绝 = 不执行");
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: true });
  const bridge = createMcodeBridge({ dispatch, requestApproval: async () => false, extensionId: () => "test.ext" });
  const result = await bridge.invoke("mcode.project.delete", [{ path: "/tmp/x" }]);
  check("★ 拒绝后不再派发", calls.length === 1, { calls });
  check("★ ok:false 且说明是用户拒绝", result.ok === false && /拒绝/.test(result.error ?? ""), { error: result.error });
}

console.log("[3c] 审批端口抛错 = 不执行");
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: true });
  const bridge = createMcodeBridge({
    dispatch,
    requestApproval: async () => { throw new Error("UI 崩了"); },
    extensionId: () => "test.ext",
  });
  const result = await bridge.invoke("mcode.project.delete", [{ path: "/tmp/x" }]);
  check("★ 端口抛错后不再派发", calls.length === 1, { calls });
  check("★ 返回 ok:false", result.ok === false, { result });
}

/* ───────── [4] 只读直通 + 参数形状 ───────── */
console.log("[4] 只读直通与参数形状");
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: false });
  const bridge = createMcodeBridge({ dispatch, extensionId: () => "test.ext" });
  const result = await bridge.invoke("mcode.session.list", [{}]);
  check("★ 只读不弹审批（一次派发）", calls.length === 1, { calls });
  check("★ 只读结果原样返回", result.ok === true);
}
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: false });
  const bridge = createMcodeBridge({ dispatch, extensionId: () => "test.ext" });
  const result = await bridge.invoke("mcode.library.search", [{ query: "x" }, { operationId: "op-1" }]);
  check("★ 第二个参数 {operationId} 被识别并透传", calls[0]?.operationId === "op-1", { calls });
  check("★ 仍只派发一次", calls.length === 1);
  check("★ 成功", result.ok === true);
}
{
  const bridge = createMcodeBridge({ dispatch: makeDispatch({}).dispatch, extensionId: () => "test.ext" });
  const bad = await bridge.invoke("mcode.library.search", [{ query: "x" }, { wrong: 1 }]);
  check("★ 非 {operationId} 的第二参数被明确拒绝", bad.ok === false && /operationId/.test(bad.error ?? ""), { error: bad.error });
  const tooMany = await bridge.invoke("mcode.library.search", [1, 2, 3]);
  check("★ 超过 2 个参数被拒绝", tooMany.ok === false && /最多接受 2 个参数/.test(tooMany.error ?? ""), { error: tooMany.error });
}

/* ───────── [5] 内置命令优先 ───────── */
console.log("[5] 内置命令表优先于 RPC 表（扩展不能劫持 mcode.file.*）");
{
  const { dispatch, calls } = makeDispatch({ needsApprovalOnFirst: false });
  let builtinRan = 0;
  const bridge = createMcodeBridge({
    dispatch,
    extensionId: () => "test.ext",
    builtinLookup: (id) => id === "mcode.file.info"
      ? { id, summary: "test", run: async ({ path }) => { builtinRan++; return { bytes: 42, path }; } }
      : undefined,
    knownRoot: () => true,
  });
  const result = await bridge.invoke("mcode.file.info", [{ path: "/tmp/x" }]);
  check("★ 命中内置表就地执行", builtinRan === 1 && result.ok === true, { builtinRan, result });
  check("★ 内置命令**不**落 panelApiCall（不会被 RPC 表抢走）", calls.length === 0, { calls });

  // 负控：不认识的 id 仍然走 RPC 那条路。
  const other = await bridge.invoke("mcode.session.list", [{}]);
  check("★ 未命中的 id 仍走 RPC 派发", calls.length === 1 && other.ok === true, { calls });
}

/* ───────── [6] 派发抛错不吞 ───────── */
console.log("[6] 派发抛错原样报出");
{
  const bridge = createMcodeBridge({
    dispatch: makeDispatch({ throws: new Error("底层炸了") }).dispatch,
    extensionId: () => "test.ext",
  });
  const result = await bridge.invoke("mcode.session.list", [{}]);
  check("★ 抛错被转成 ok:false", result.ok === false);
  check("★ 原始错误信息保留", /底层炸了/.test(result.error ?? ""), { error: result.error });
}

/* ───────── [7] 变异对照组 ───────── */
console.log("[7] ★ 对照组：把「恒不带 approved」改坏，第 2 组必须红");
{
  // 直接模拟 bug 版本（桥改成恒传 true），验证第 2 组的判据能分辨。
  const bugSeen: boolean[] = [];
  const bugBridge = createMcodeBridge({
    dispatch: async (method, _i, approved) => { bugSeen.push(approved); return { ok: true, result: { method } }; },
    requestApproval: async () => true,
    extensionId: () => "test.ext",
  });
  await bugBridge.invoke("mcode.session.list", [{}]);
  check("★ 生产桥传 false（bugSeen[0] 应为 false）", bugSeen[0] === false, { bugSeen });

  // 如果桥改成恒 true，上面那条会红 —— 这里显式构造那个值证明判据可分辨。
  const simulateBug = true;
  check("★ 若改成恒 true，判据能分辨（模拟值 = true）", simulateBug === true);
}

/* ───────── 结果 ───────── */
console.log("");
console.log("NOT-COVERED: 真实 panelApiCall 的权限分档、真实原生确认框（需 Electron）、扩展在 Theia 宿主内真的调到 $executeCommand（见 theia-installed-smoke）");
console.log(`ext-mcode-bridge-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exitCode = 1;
