/**
 * 【F010】安装决策的透传：`deny` 必须在 `host.install` 那一层也生效。
 *
 * ## 这张卡修的是什么
 *
 * `host.install(raw, grantedPermissions?, decision = "allow-once")` —— 第三个参数有默认值。
 * 而 `VscodeL1Bridge.install` 从前只传 `manifest`，于是：
 *
 * **用户选「拒绝」，走到 bridge 就被默认成「允许一次」。**
 *
 * handler 那边确实挡了一道（`deny` 在读文件之前返回），但那道离 `host.install` 隔着四步，
 * **任何新调用方（工作流、直接调 bridge 的测试）都会绕过它**。
 *
 * ## 两道门不是重复
 *
 * | 门 | 位置 | 挡什么 |
 * |---|---|---|
 * | handler | `readFileSync` 之前 | **读文件** |
 * | bridge | `host.install` 之前 | **写盘** |
 *
 * bridge **做不到**前者 —— 它拿到 `archive` 时字节早就读进来了。
 * 所以两道都要有，**但它们是两件事**。
 *
 * ## 这套怎么验「真的透传到了」
 *
 * **不能只验「抛错了」** —— handler 那道也会抛。必须验**错误来自哪一层**：
 * 宿主那句是「未写入任何内容」，handler 那句是「未读取任何文件」。
 * 混成一个就分不出「真的透传了」和「被前面那道挡了」。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VscodeL1Bridge } from "@main/modules/vscodeL1Bridge.js";
import { ModuleHost } from "@main/modules/ModuleHost.js";
import { buildZip } from "./zip.js";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const enc = new TextEncoder();

/** 每个用例一个全新 host，并记录 `persist` 被调用几次 —— 「零写入」要用它证。 */
function freshHost(): { host: ModuleHost; persistCalls: () => number } {
  let perm: string | null = null;
  let calls = 0;
  const host = new ModuleHost({
    authorize: async () => {},
    persist: async () => { calls++; },
    requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm,
    persistModulePermissions: async (t) => { perm = t; },
  });
  return { host, persistCalls: () => calls };
}

function zipFor(pub = "acme", name = "demo"): Uint8Array {
  const pkg = {
    publisher: pub, name, version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: [`onCommand:${name}.hello`],
    contributes: { commands: [{ command: `${name}.hello`, title: "Hello" }] },
  };
  return buildZip([
    { name: "extension/package.json", data: enc.encode(JSON.stringify(pkg)) },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

const CONSENT = { confirmReadAccess: true, confirmExecutableCode: true } as const;

async function installWith(decision: "deny" | "allow-once" | "allow-always" | undefined) {
  const h = freshHost();
  let error: string | undefined;
  let bridge: VscodeL1Bridge | null = null;
  try {
    bridge = await VscodeL1Bridge.install(h.host, zipFor(), {
      ...CONSENT,
      ...(decision === undefined ? {} : { installConsent: decision }),
    });
  } catch (e) { error = String(e); }
  return { ...h, bridge, error };
}

console.log("[1] 正控：不传 decision 时仍能装（等价 allow-once）");
{
  const r = await installWith(undefined);
  check("★ 缺省 decision 能装成功", r.bridge !== null, { error: r.error });
  check("★ 且真的写盘了一次（persist 被调用）", r.persistCalls() === 1, { persistCalls: r.persistCalls() });
}

console.log("[2] allow-once / allow-always 都能装");
{
  for (const d of ["allow-once", "allow-always"] as const) {
    const r = await installWith(d);
    check(`★ decision='${d}' 装成功`, r.bridge !== null, { error: r.error });
  }
}

console.log("[3] deny 必须在 host.install 那一层生效（本卡的核心）");
{
  const r = await installWith("deny");
  check("★ deny 时安装失败", r.bridge === null, { unexpectedly: "装进去了" });
  // ⚠️ **关键判据：错误来自哪一层。**
  // 宿主那句是「未写入任何内容」；handler 那句是「未读取任何文件」。
  // 只验「抛错了」的话，两句话都能过 —— 那就证明不了 decision 真的透传了。
  check(
    "★ 错误来自 host.install（『未写入任何内容』），不是别处",
    r.error !== undefined && /未写入任何内容/.test(r.error),
    { error: (r.error ?? "").slice(0, 200) },
  );
  check(
    "★ 且不是 handler 那句（『未读取任何文件』）—— 证明不是被前面那道挡的",
    r.error !== undefined && !/未读取任何文件/.test(r.error),
    { error: (r.error ?? "").slice(0, 200) },
  );
  check("★ deny 时磁盘零写入（persist 一次都没被调用）", r.persistCalls() === 0, {
    persistCalls: r.persistCalls(),
  });
}

console.log("[4] deny 之后宿主里没有留下那个模块");
{
  const r = await installWith("deny");
  const ids = r.host.catalog().modules.map((m) => m.id);
  check("★ deny 后 catalog 里没有 acme 的模块", !ids.some((id) => id.includes("acme")), { ids });
}

console.log("[5] 负控：decision 没有被误传到 grantedPermissions 位置");
{
  // 如果实现写错成 `host.install(manifest, decision, ...)`，第二个参数会被当成
  // 权限数组 → `assertModuleGrants` 抛一个与「用户拒绝」无关的错。
  // 那时 deny 仍然「看起来生效了」，但原因是错的。
  const r = await installWith("deny");
  const wrongReason = r.error !== undefined &&
    !/未写入任何内容/.test(r.error) && !/未读取任何文件/.test(r.error);
  check(
    "★ 拒绝原因不是『权限数组不合法』那类错（证明没传错位置）",
    !wrongReason,
    { error: (r.error ?? "").slice(0, 200) },
  );

  // 反向：allow-always 时如果 decision 被当成权限数组，也会抛。
  const ok = await installWith("allow-always");
  check("★ allow-always 没被当成权限数组（装成功）", ok.bridge !== null, { error: ok.error });
}

console.log("[6] 真实桥接：handler 与 bridge 的错误信息确实不同");
{
  // 这条防「两处用了同一句话」—— 那样第 [3] 组就分不出来了。
  // 从源码确认两句话都在，且不一样。
  const handler = readFileSync(join(process.cwd(), "src/main/ipc/modules.ts"), "utf8");
  const hostSrc = readFileSync(join(process.cwd(), "src/main/modules/moduleHost.ts"), "utf8");
  check("★ handler 有「未读取任何文件」", /未读取任何文件/.test(handler));
  check("★ 宿主有「未写入任何内容」", /未写入任何内容/.test(hostSrc));
  const handlerMsg = /"(用户拒绝了这次安装，未读取任何文件)"/.exec(handler)?.[1];
  const hostMsg = /"(用户拒绝了这次安装，未写入任何内容)"/.exec(hostSrc)?.[1];
  check("★ 两条消息不同（否则 [3] 组分不出是哪道门）", handlerMsg !== undefined && hostMsg !== undefined && handlerMsg !== hostMsg, {
    handlerMsg, hostMsg,
  });
}

console.log("[7] handler 确实把 decision 透传下去了（源码层）");
{
  const handler = readFileSync(join(process.cwd(), "src/main/ipc/modules.ts"), "utf8");
  check("★ handler 里出现 installConsent:decision", /installConsent\s*:\s*decision/.test(handler), {
    hint: "handler 没透传的话，bridge 那道门对真实调用路径无效",
  });
}

console.log(`\nvsix-decision-passthrough-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
