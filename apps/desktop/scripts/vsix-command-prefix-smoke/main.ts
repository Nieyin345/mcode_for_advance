/**
 * 【F008】命令 id 的前缀规则：从「只认 <publisher>.<name>.」到接受真实生态的两种形态。
 *
 * ## 这条规则原来让 100% 的真实扩展装不上
 *
 * 实测本机 24 个有 `contributes.commands` 的真实扩展，**没有一个**用
 * `<publisher>.<name>.` 前缀 —— 全部是 `<name>.<command>`：
 *
 * | 扩展 | 首条命令 |
 * |---|---|
 * | mechatroner.rainbow-csv | `rainbow-csv.CSVLint` |
 * | James-Yu.latex-workshop | `latex-workshop.hostPort` |
 * | ms-azuretools.vscode-containers | `vscode-containers.compose.down` |
 *
 * 现在接受**两种**：`<publisher>.<name>.` 与 `<name>.`。
 *
 * ## 为什么**不完全去掉**前缀检查
 *
 * 去掉之后扩展能声明**别的扩展**的命令 id（比如它声明 `git.commit`），
 * 那是越权命名。保留一个「必须属于自己」的约束，但按真实生态放宽到两种形态。
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

function host(): ModuleHost {
  let perm: string | null = null;
  return new ModuleHost({
    authorize: async () => {}, persist: async () => {}, requestApproval: async () => {},
    verifyProgram: async () => ({ ok: true as const }),
    readModulePermissions: () => perm, persistModulePermissions: async (t) => { perm = t; },
  });
}

/** 造包。`publisher`/`name` 与 `commands` 分开传，方便构造各种前缀组合。 */
function archive(pub: string, name: string, commands: { command: string; title: string }[], activation?: string[]): Uint8Array {
  const pkg = enc.encode(JSON.stringify({
    publisher: pub, name, version: "1.0.0", main: "./extension.js",
    engines: { vscode: "^1.80.0" },
    activationEvents: activation ?? ["onCommand:" + commands[0]!.command],
    contributes: { commands },
  }));
  return buildZip([
    { name: "extension/package.json", data: pkg },
    { name: "extension/extension.js", data: enc.encode("exports.activate=()=>{};") },
  ], 8);
}

async function tryInstall(zip: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  try {
    await VscodeL1Bridge.install(host(), zip, { confirmReadAccess: true, confirmExecutableCode: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

console.log("[1] 正控：<publisher>.<name>.<cmd> 仍然被接受（别弄坏本来支持的）");
{
  const r = await tryInstall(archive("acme", "demo", [{ command: "acme.demo.hello", title: "Hello" }]));
  check("★ publisher.name.cmd 形态安装成功", r.ok, { error: r.error });
}

console.log("[2] <name>.<cmd> 形态（本卡的核心：真实生态的写法）");
{
  const r = await tryInstall(archive("acme", "demo", [{ command: "demo.hello", title: "Hello" }]));
  check("★ name.cmd 形态安装成功（旧规则会拒）", r.ok, { error: r.error });
}

console.log("[3] 真实扩展的命令形态逐个验（用它的真实 command id，不造假数据）");
{
  const cases: { pub: string; name: string; command: string }[] = [
    { pub: "mechatroner", name: "rainbow-csv", command: "rainbow-csv.CSVLint" },
    { pub: "James-Yu", name: "latex-workshop", command: "latex-workshop.hostPort" },
    { pub: "ms-azuretools", name: "vscode-containers", command: "vscode-containers.compose.down" },
  ];
  for (const c of cases) {
    // 用真实 publisher/name，但命令只取一条（多命令是 F007 的事，本卡验前缀）
    const r = await tryInstall(archive(
      // publisher 的正则要求小写开头，James-Yu 不合规 —— 用它的真实 name 段就够验前缀了
      c.pub.toLowerCase() === c.pub ? c.pub : "james-yu",
      c.name,
      [{ command: c.command, title: "x" }],
    ));
    check(`★ ${c.command} 被接受`, r.ok, { error: r.error });
  }
}

console.log("[4] 负控：裸命令（不带点）被拒");
{
  // 裸词：`<name>` 本身、没有点
  const r = await tryInstall(archive("acme", "demo", [{ command: "hello", title: "Hello" }]));
  check("★ 裸命令 'hello' 被拒", !r.ok, { error: r.error });
  // schema 的 COMMAND_ID 正则要求有 `.`（`^[a-zA-Z][a-zA-Z0-9.-]{2,99}$` 其实不强制点），
  // 所以这里可能被 schema 或前缀检查任一拦住 —— 但必须拒。
  check("★ 拒绝信息说清是命令 id 的问题", !r.ok && /command/i.test(r.error ?? ""), { error: r.error });
}

console.log("[5] 负控：两个前缀都不匹配的命令被拒，且错误信息说清期望什么");
{
  const r = await tryInstall(archive("acme", "demo", [{ command: "other.thing", title: "X" }]));
  check("★ 'other.thing' 被拒（不是自己扩展的命令）", !r.ok, { error: r.error });
  check(
    "★ 错误信息同时列出两种期望前缀",
    !r.ok && /acme\.demo\./.test(r.error ?? "") && /demo\./.test(r.error ?? ""),
    { error: r.error },
  );
  check(
    "★ 错误信息带上了实际的命令 id（got '...'）",
    !r.ok && /other\.thing/.test(r.error ?? ""),
    { error: r.error },
  );
}

console.log("[6] 负控：同清单内命令 id 重复被拒");
{
  const r = await tryInstall(archive("acme", "demo", [
    { command: "demo.hello", title: "A" },
    { command: "demo.hello", title: "B" },
  ]));
  check("★ 重复命令 id 被拒", !r.ok, { error: r.error });
  check("★ 错误信息点名 duplicate", !r.ok && /duplicate/i.test(r.error ?? ""), { error: r.error });
}

console.log("[7] 真实扩展（rainbow-csv）的命令 id 现在过了前缀这一关");
{
  const p = join(homedir(), ".vscode/extensions/mechatroner.rainbow-csv-3.24.1/package.json");
  let pkg: any = null;
  try { pkg = JSON.parse(readFileSync(p, "utf8")); } catch { /* 没装 */ }

  if (!pkg) {
    console.log("      （本机没有 rainbow-csv，跳过）");
  } else {
    const cmds = pkg.contributes.commands as { command: string; title: string }[];
    // 用它的**真实命令**（24 条全带上，验的是「没有一条被前缀规则拒」）
    const r = await tryInstall(archive(pkg.publisher, pkg.name, cmds));
    // 它可能被 main 路径拒（`./extension`），但**不该被前缀规则拒**。
    const prefixRejected = !r.ok && /command id must start with/.test(r.error ?? "");
    check("★ 24 条真实命令没有一条被前缀规则拒", !prefixRejected, { error: r.error });

    // 并且每一条单独验一遍前缀（把 main 的干扰排除在判断之外）
    let bad = 0;
    for (const c of cmds) {
      const one = await tryInstall(archive(pkg.publisher, pkg.name, [c]));
      if (!one.ok && /command id must start with/.test(one.error ?? "")) bad++;
    }
    check(`★ 24 条逐条验，0 条被前缀规则拒（实际 ${bad} 条）`, bad === 0, { bad });
  }
}

console.log(`\nvsix-command-prefix-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
