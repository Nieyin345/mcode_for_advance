/**
 * 【T33】`document.*` 域的审批档位。
 *
 * ## 这套钉的是什么
 *
 * `policyFor(method)` 的档位是**安全边界**：`read` 自动放行、`write` 弹卡且可「始终允许」、
 * `danger` 每次问、`blocked` 谁都不给。这四条在 IPC 侧没有任何第二层闸 ——
 * `ipc/document.ts` 的 handler 拿到 `policyFor` 的结论就直接执行。
 *
 * ## 为什么原来的断言没抓到
 *
 * `genoffice-cli-smoke` 从前用**源码文本**判：
 * `policy.includes('"document.read": "read"')`。
 * 而 `document.read` 当时躺在 **BLOCKED 表**里（BLOCKED 的**值**是拒绝理由），
 * 那行字面量恰好长得一样 —— 断言绿着，`policyFor()` 返回的却是
 * `{level:"blocked", reason:"read"}`。
 *
 * 所以这里**全部问函数**，一个字面量扫描都不留。
 */
import { policyFor } from "@main/appControl/policy.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
const levelOf = (m: string): string => (policyFor(m) as { level: string }).level;

console.log("\nT33 · document.* 的审批档位");

/* ── 1. 只读的七条 ──
 *
 * `document.read` / `document.capabilities` 从前**误进 BLOCKED**（`{level:"blocked",
 * reason:"read"}`）；其余五条因为动词在**结尾**（`markdownRead` / `toolsList` /
 * `toolDescribe` / `apps` / `render`）命中不了 `READ_VERB`（它是 `^(list|get|read|…)`，
 * 要求动词在开头），全落 `write`。
 */
const READ_ONLY = [
  "document.read",
  "document.capabilities",
  "document.apps",
  "document.toolsList",
  "document.toolDescribe",
  "document.markdownRead",
  "document.render",
];
console.log("\n只读档(看不到文档就走不了任何文档功能)");
for (const m of READ_ONLY) {
  const level = levelOf(m);
  check(`★ ${m} 是 read 档`, level === "read", { actual: level, expected: "read" });
}

/* ── 2. 写的四条 ──
 *
 * `document.toolCall` / `document.markdownEdit` 从前落 `write`。`write` 与 `danger`
 * 的差别不是"弹不弹卡"（两者都弹），而是**能不能「始终允许」**：
 * `write` 可以，`danger` 不可以。所以 `write` 意味着用户点一次就永久放行文档写入。
 */
const DANGER = ["document.edit", "document.convert", "document.toolCall", "document.markdownEdit"];
console.log("\ndanger 档(每次问、不可「始终允许」)");
for (const m of DANGER) {
  const level = levelOf(m);
  check(`★ ${m} 是 danger 档`, level === "danger", { actual: level, expected: "danger" });
}

/* ── 3. 同一件事不能有两条不同档位的路 ──
 *
 * 「改文档」现在有四条入口：`document.edit` / `document.convert` /
 * `document.markdownEdit` / `document.toolCall`（后者能执行任意原生编辑器工具，
 * 含会写文件的那批）。它们必须同档，否则用户点一次「始终允许」就能从松的那条绕过去。
 */
console.log("\n同一能力必须同档(不能有更松的旁路)");
const docWriteLevels = DANGER.map((m) => `${m}=${levelOf(m)}`);
check(
  "★ 四条「能改文档」的方法档位完全一致",
  new Set(DANGER.map(levelOf)).size === 1,
  { levels: docWriteLevels },
);
check(
  "★ 没有一条文档写方法落在 write 档(那样就能被「始终允许」记住)",
  DANGER.every((m) => levelOf(m) !== "write"),
  { levels: docWriteLevels },
);

/* ── 4. 反向:只读的不能被错误地收紧 ──
 *
 * 把只读判成 danger 不是安全问题，但会让用户每次读文件都点一次卡 ——
 * 那是"防护过度"退化成"用户开始无脑点是"。这条与第 1 节同向，但要显式钉住
 * 「不是 blocked」——被 blocked 的只读是彻底不可用。
 */
console.log("\n反向:不该被收紧");
for (const m of READ_ONLY) {
  const level = levelOf(m);
  check(`${m} 不是 blocked`, level !== "blocked", { actual: level });
  check(`${m} 不是 danger`, level !== "danger", { actual: level });
}

/* ── 5. BLOCKED 表里不能再有 document.* ──
 *
 * 本卡的病灶就是"两条只读混进了 BLOCKED"。BLOCKED 的值是**拒绝理由**，写 `"read"`
 * 会被当成理由原样显示给用户（「这个功能不开放：read」）。这一类错误在类型上抓不到
 * （都是 `Record<string, string>`），所以只能在这里盯住。
 */
console.log("\nBLOCKED 表不得含 document.*");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/main/appControl/policy.ts", "utf8");
  // ⚠️ 切片不能用「下一个 `const X`」当终点 —— 本文件里 `CREDENTIAL_BEARING` 在
  // DANGER/EXPLICIT **之后**，那样切出来的是从 BLOCKED 到文件后段的整块。
  //
  // 从 `const BLOCKED` 起，取紧随其后的第一个顶层 `};`（该表自己的结尾）。
  const blockedStart = src.search(/^const BLOCKED: Record<string, string> = \{$/m);
  check("能在源码里定位 BLOCKED 表", blockedStart >= 0);
  if (blockedStart >= 0) {
    const closeAt = src.indexOf("\n};", blockedStart);
    check("BLOCKED 表有明确的结尾", closeAt > blockedStart);
    if (closeAt > blockedStart) {
      const blockedTable = src.slice(blockedStart, closeAt);
      const docInBlocked = blockedTable.match(/"document\.[A-Za-z]+"\s*:/g) ?? [];
      check("★ BLOCKED 表里没有任何 document.* 条目", docInBlocked.length === 0, { found: docInBlocked });
    }
  }
}

console.log(`\nt33-document-policy-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
