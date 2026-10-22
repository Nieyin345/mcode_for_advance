/**
 * 【T26】安装权限卡文案回归 —— **按钮上的时效词必须与实现一致**。
 *
 * ## 盯的是什么
 *
 * 实现是会话级：`allow-once` 存成 `duration:"session"` + 本次进程的随机 `bootId`，
 * 重启后 `effectiveGrants` 返回 null、重新询问（T18 验收第 3 条，`module-install-consent-smoke` ②）。
 * 但按钮原写「允许一次」—— 中文里最自然的理解是「这一次操作」，用户读按钮、不读脚注。
 *
 * ## 判据立在用户看到的那行字上
 *
 *  1. **按钮文字本身**必须带「本次运行」这四个字（不是只断言脚注）；
 *  2. 脚注 / 重询问文案必须提到「运行期间」与「崩溃」，与实现的真实边界一致；
 *  3. 产品代码里「允许一次」零命中（注释除外）—— 同一个概念不能两套说法；
 *  4. en 与 zh 同义（"this session"），不能只改一边。
 *
 * ## 变异验证
 *
 *  `build.mjs` 内置 `button-reverts`：把 zh 按钮改回「允许一次」，本套必须有一条红。
 *  这是"断言真的立在那行字上"的证据，不是跑绿就算。
 *
 * Run: scripts/module-consent-copy-smoke/run.sh
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { translate } from "@renderer/lib/i18n/core.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const zh = translate.bind(null, "zh") as (k: never) => string;
const en = translate.bind(null, "en") as (k: never) => string;

/* ── ① 按钮文字：用户真正点的那一行 ── */
{
  const button = zh("ide.modules.consentCard.allowOnce" as never);
  check("★ zh 按钮文字含「本次运行」(时效限定词)", button.includes("本次运行"), button);
  check("★ zh 按钮文字不含「一次」", !button.includes("一次"), button);
}

/* ── ② 脚注：与按钮同一个说法，且说明崩溃重启也算 ── */
{
  const footnote = zh("ide.modules.consentCard.footnote" as never);
  check("★ zh 脚注含「本次运行允许」(与按钮同词)", footnote.includes("本次运行"), footnote);
  check("★ zh 脚注说明崩溃后重开也会失效", footnote.includes("崩溃"), footnote);
  check("zh 脚注不再出现旧词「允许一次」", !footnote.includes("允许一次"), footnote);
}

/* ── ③ 重询问提示：同样是「本次运行」，且不把重启说成唯一原因 ── */
{
  const reconsent = zh("ide.modules.consentCard.reconsentRequired" as never);
  check("★ zh 重询问提示用「本次运行允许」而不是「允许一次」", reconsent.includes("本次运行允许") && !reconsent.includes("允许一次"), reconsent);
  check("zh 重询问提示指出失效发生在「上次运行结束」", reconsent.includes("上次运行结束"), reconsent);
}

/* ── ④ en 必须同义，不能只改 zh ── */
{
  const button = en("ide.modules.consentCard.allowOnce" as never);
  check("★ en 按钮文字含 this session", /this session/i.test(button), button);
  check("★ en 按钮文字不含 once", !/\bonce\b/i.test(button), button);
  check("en 脚注同义(this session)", /this session/i.test(en("ide.modules.consentCard.footnote" as never)));
  check("en 脚注不再出现 “Allow once”", !/allow once/i.test(en("ide.modules.consentCard.footnote" as never)));
  check("en 重询问提示同义(this session)", /this session/i.test(en("ide.modules.consentCard.reconsentRequired" as never)));
}

/* ── ⑤ 产品代码里同一个概念只有一种说法 ── */
{
  /** 找出「允许一次」出现在**注释之外**的行号。字符串里的命中要报（那是用户可见文案），
   *  注释里的命中不报（历史说明允许保留）。逐字符状态机，正确处理 `{/* … *\/}`。 */
  const phraseLinesOutsideComments = (text: string): number[] => {
    const phrase = "允许一次";
    const hits: number[] = [];
    type State = "code" | "line" | "block" | "single" | "double" | "template";
    let state: State = "code";
    let line = 1;
    let pendingLine = 0; // 命中时所在行（记录起点，避免跨行误报）
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (text.startsWith(phrase, i)) {
        pendingLine = line;
        if (state === "code" || state === "single" || state === "double" || state === "template") {
          hits.push(pendingLine);
        }
        i += phrase.length - 1;
        continue;
      }
      if (ch === "\n") { line++; if (state === "line") state = "code"; continue; }
      if (state === "code") {
        if (ch === "/" && next === "/") { state = "line"; i++; continue; }
        if (ch === "/" && next === "*") { state = "block"; i++; continue; }
        if (ch === "'") { state = "single"; continue; }
        if (ch === '"') { state = "double"; continue; }
        if (ch === "`") { state = "template"; continue; }
        continue;
      }
      if (state === "line") continue;
      if (state === "block") { if (ch === "*" && next === "/") { state = "code"; i++; } continue; }
      if (ch === "\\") { i++; continue; }
      if (state === "single" && ch === "'") state = "code";
      else if (state === "double" && ch === '"') state = "code";
      else if (state === "template" && ch === "`") state = "code";
    }
    return hits;
  };

  const root = process.cwd();
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      for (const line of phraseLinesOutsideComments(text)) {
        hits.push(`${relative(root, path)}:${line}`);
      }
    }
  };
  walk(join(root, "src/renderer"));
  check("★ 渲染端源码里「允许一次」只出现在注释中", hits.length === 0, hits);
}

console.log(`\nmodule-consent-copy-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
