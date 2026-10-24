/**
 * 【F006】从 `.vsix` 安装 —— 三层齐全性 + 复用性 + 诚实性。
 *
 * ## 这套为什么不 import 主进程实现
 *
 * 它要验的是「**接线有没有接全**」，不是「VSIX 解析对不对」（那是 F002/F003/F005 的事）。
 * 接线性是**文本层面**的事实：contracts 里有没有那条方法、handler 里有没有那个
 * `ipcMain.handle`、preload 里有没有那个转发、UI 里有没有那段限制说明。
 *
 * 三条里任何一条缺失，调用端就**看不到**这条能力 —— 而**编译期只有一部分能抓到**
 * （rpcMap 有类型、preload 靠 `satisfies`、但「UI 有没有展示限制」编译器完全不管）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModuleInstallVsixSchema } from "@contracts/ipc/modules";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** 剥掉注释再判断 —— 否则「注释里提到」会被当成「代码里有」。
 *  这个仓库为此栽过（`includes(sourceText)` 匹配到注释）。 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const contractsModules = read("../../packages/contracts/src/ipc/modules.ts");
const contractsRpc = read("../../packages/contracts/src/ipc/rpcMap.ts");
const mainHandler = read("../../apps/desktop/src/main/ipc/modules.ts");
const preload = read("../../apps/desktop/src/preload/index.ts");
const policy = read("../../apps/desktop/src/main/appControl/policy.ts");
const uiSection = read("../../apps/desktop/src/renderer/components/modules/VsixInstallSection.tsx");
const uiSurface = read("../../apps/desktop/src/renderer/components/modules/ModuleSurface.tsx");

console.log("[1] contracts 层：schema + rpcMap + channel");
{
  check("★ ModuleInstallVsixSchema 存在", /export const ModuleInstallVsixSchema\s*=/.test(contractsModules));
  check("★ ModuleInstallVsixInput 类型导出", /export type ModuleInstallVsixInput\s*=/.test(contractsModules));
  // schema 必须是 .strict()：渲染端不能借这条通道塞多余字段（尤其不能塞 manifest）。
  check("★ schema 是 .strict()（不能塞多余字段，尤其不能塞 manifest）",
    /ModuleInstallVsixSchema[\s\S]{0,600}?\.strict\(\)/.test(contractsModules));
  check("★ schema 里**没有** manifest 字段（清单只能从 vsix 里读）",
    !/ModuleInstallVsixSchema[\s\S]{0,500}?manifest\s*:/.test(contractsModules));
  check("★ rpcMap 有 modules.installVsix", /"modules\.installVsix"\s*:/.test(contractsRpc));
  check("★ IPC 常量表有 MODULE_INSTALL_VSIX", /MODULE_INSTALL_VSIX\s*:\s*"modules:installVsix"/.test(contractsRpc));
}

console.log("[2] 主进程 handler");
{
  const code = stripComments(mainHandler);
  check("★ 注册了 IPC.MODULE_INSTALL_VSIX", /ipcMain\.handle\(\s*IPC\.MODULE_INSTALL_VSIX/.test(code));
  // 复用性：必须 import 并调 VscodeL1Bridge.install，不能自己写一份读 VSIX 的逻辑。
  check("★ 调用了 VscodeL1Bridge.install（复用，不自己解析 vsix）",
    /VscodeL1Bridge\.install\s*\(/.test(code));
  check("★ 没有自己手写 ZIP/central-directory 解析（不重复实现 readMinimalVsix）",
    !/0x02014b50|central directory|EOCD/i.test(code));
  // 审批：deny 必须在读文件之前。
  // ⚠️ 只在 **handler 体**里找 —— 文件顶部有 `import { readFileSync }`，
  // 在整个文件里搜 `readFileSync` 会命中那行 import（index 9），断言永远假红。
  const handlerStart = code.indexOf("IPC.MODULE_INSTALL_VSIX");
  const handlerBody = code.slice(handlerStart);
  const denyIdx = handlerBody.indexOf('decision === "deny"');
  const readIdx = handlerBody.indexOf("readFileSync(input.path)");
  check("★ deny 判断在 readFileSync **之前**（拒绝时文件根本没被读）",
    denyIdx >= 0 && readIdx > denyIdx, { denyIdx, readIdx });
  check("★ 调了 resolveInstallDecision（走与 modules.install 相同的审批收窄）",
    /resolveInstallDecision\s*\(/.test(code));
}

console.log("[3] preload 白名单");
{
  const code = stripComments(preload);
  check("★ preload 暴露了 modules.installVsix", /installVsix\s*:/.test(code));
  // 三层齐全的最后一段：有 rpcMap 但 preload 没加 → 渲染端拿到 undefined。
  check("★ preload 转发到 IPC.MODULE_INSTALL_VSIX",
    /IPC\.MODULE_INSTALL_VSIX/.test(code));
}

console.log("[4] 审批档位（与 modules.install 同档，不能是后门）");
{
  const code = stripComments(policy);
  check("★ policy 里有 modules.installVsix 条目", /"modules\.installVsix"\s*:/.test(code));
  // 同档的意思：它必须在 danger 那张表里，而不是被当成 read 兜底。
  const installLine = /"modules\.installVsix"\s*:\s*"([^"]*)"/.exec(code)?.[1] ?? "";
  check("★ 档位描述里点明「可执行代码」（与 modules.install 同一危险级）",
    /可执行/.test(installLine), { installLine });
}

console.log("[5] UI 诚实性：限制说明在按钮**之前**");
{
  const code = stripComments(uiSection);
  const noticeIdx = code.indexOf('data-testid="module-vsix-limit-notice"');
  const buttonIdx = code.indexOf("vsixPick");
  check("★ 有限制说明的 testid", noticeIdx >= 0);
  check("★ 说明在按钮**之前**（选文件前就能看到，不是选完才报错）",
    noticeIdx >= 0 && buttonIdx > noticeIdx, { noticeIdx, buttonIdx });
  check("★ UI 被挂进 ModuleSurface（不然用户看不到）",
    /<VsixInstallSection/.test(stripComments(uiSurface)));
  check("★ 文件选择走既有 api.pickFiles（不是直接 import electron dialog）",
    /api\.pickFiles\s*\(/.test(code) && !/from\s+["']electron["']/.test(code));
  // ⚠️ 那段限制文案在 **i18n 词典**里，不在组件文件里 —— 组件只引用 key。
  // 所以要在 zh 词典里查「24 KiB」这个具体数字：只在组件里查会永远假红。
  const zhDict = read("../../apps/desktop/src/renderer/lib/i18n/zh/ide.ts");
  const noticeText = /"ide\.modules\.vsixLimitNotice"\s*:\s*"([^"]*)"/.exec(zhDict)?.[1] ?? "";
  check("★ 限制说明里点了 24 KiB 这个具体限额", /24\s*KiB/i.test(noticeText), { noticeText });
  // 还要提到「真实市场扩展装不进来」这件事本身 —— 只说限额不说后果，用户理解不到严重性。
  check("★ 限制说明说清了「真实市场扩展会被拒」而不只是给个数字",
    /真实市场扩展|会被.*拒绝|装不进来/.test(noticeText), { noticeText });
}

console.log("[6] i18n：zh/en 两本都有");
{
  const zh = read("../../apps/desktop/src/renderer/lib/i18n/zh/ide.ts");
  const en = read("../../apps/desktop/src/renderer/lib/i18n/en/ide.ts");
  const keys = ["ide.modules.vsixTitle", "ide.modules.vsixLimitNotice", "ide.modules.vsixPick"];
  for (const k of keys) {
    check(`★ zh 有 ${k}`, new RegExp(`"${k.replace(/\./g, "\\.")}"\\s*:`).test(zh));
    check(`★ en 有 ${k}`, new RegExp(`"${k.replace(/\./g, "\\.")}"\\s*:`).test(en));
  }
}

console.log("[7] schema 行为（用真 schema，不抄一份）");
{
  // 正控：合法输入能过
  const ok = ModuleInstallVsixSchema.safeParse({
    path: "/tmp/x.vsix", confirmReadAccess: true, confirmExecutableCode: true, installConsent: "allow-once",
  });
  check("★ 合法输入通过", ok.success);
  // 负控：塞 manifest 必须被拒（.strict() 的作用 —— 防绕过 modules.install 的清单校验）
  const smuggling = ModuleInstallVsixSchema.safeParse({
    path: "/tmp/x.vsix", confirmReadAccess: true, manifest: { id: "user.evil" },
  });
  check("★ 试图夹带 manifest 被拒（.strict() 生效）", !smuggling.success, smuggling.success ? "accepted" : undefined);
  // 负控：confirmReadAccess 必须是字面量 true
  const noConsent = ModuleInstallVsixSchema.safeParse({ path: "/tmp/x.vsix", confirmReadAccess: false });
  check("★ confirmReadAccess=false 被拒", !noConsent.success);
}

console.log(`\nvsix-install-ipc-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
