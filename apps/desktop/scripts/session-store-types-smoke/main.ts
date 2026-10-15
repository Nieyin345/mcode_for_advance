/**
 * session-store-types-smoke —— 类型层搬出去之后，**导出面不许少一个**。
 *
 * ## 盯的是什么
 *
 * 2026-10-15 把 `sessionStore.ts` 的 15 个类型（约 2100 行，含 1688 行的
 * `SessionState`）搬进了 `sessionStoreTypes.ts`。**144 个文件**从
 * `@renderer/stores/sessionStore.js` import 类型 —— 类型是**编译期**存在的，
 * 漏掉一个 re-export **不会在运行时炸**，`tsc` 也只在**恰好有消费者用到**时才红。
 * 所以要有这条把"对外契约"钉住。
 *
 * 判据立在**一个与实现无关的清单**上：搬家前 `sessionStore.ts` 导出的那 15 个名字，
 * 今天必须仍能从 `sessionStore.js` 取到。
 *
 * ## 为什么这条能真的红
 *
 * 它**不读** `sessionStoreTypes.ts` 的产物，而是当场对比两个文件的源码：
 * 「`sessionStore.ts` re-export 的名字」与「`sessionStoreTypes.ts` 定义的名字」
 * 必须一致 —— 少了（忘了转发）或多了（定义了没转）都会红。
 *
 * Run: scripts/session-store-types-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 搬家前从 `sessionStore.ts` 导出的 15 个类型 —— 对外契约。 */
const CONTRACT = [
  "BrowserTab",
  "MobileViewerTarget",
  "Block",
  "TurnMeta",
  "QueuedPrompt",
  "PromptAttachment",
  "PlanHandoffTarget",
  "PromptImage",
  "ComposerDraft",
  "ChatMessage",
  "TodoItem",
  "PlanDraft",
  "GitDiffDialogTab",
  "EnvChoice",
  "SessionState",
].sort();

const STORE = join(process.cwd(), "src/renderer/stores/sessionStore.ts");
const TYPES = join(process.cwd(), "src/renderer/stores/sessionStoreTypes.ts");

const storeSrc = readFileSync(STORE, "utf8");
const typesSrc = readFileSync(TYPES, "utf8");

/** 从源码里抓 `export type { a, b } from "..."` 的符号集合。 */
function exportedNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/export type \{([^}]*)\} from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim();
      if (n) out.add(n);
    }
  }
  return out;
}

/** `sessionStoreTypes.ts` 里**定义**的类型名（interface / type）。 */
function definedNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^export (?:interface|type) ([A-Za-z_]\w*)/gm)) out.add(m[1]);
  return out;
}

/* ─────────── §A 类型文件确实是独立的一份 ─────────── */

console.log("\n§A 类型层独立");
check("sessionStoreTypes.ts 存在", typesSrc.length > 0);
check(
  "★ 类型文件定义了契约里的每一个类型",
  CONTRACT.every((n) => definedNames(typesSrc).has(n)),
  CONTRACT.filter((n) => !definedNames(typesSrc).has(n)),
);

/* ─────────── §B store 的 re-export 覆盖完整（核心判据） ─────────── */

console.log("\n§B store 的转发面");
{
  const forwarded = exportedNames(storeSrc);
  const missing = CONTRACT.filter((n) => !forwarded.has(n));
  check("★ 契约里每个类型都能从 sessionStore.ts 取到（漏转发 → 消费者编译不过）", missing.length === 0, missing);

  // 反向：定义了却没转发的（消费者取不到，但类型文件里有一份，是隐形的坑）
  const defined = definedNames(typesSrc);
  const notForwarded = [...defined].filter((n) => !forwarded.has(n));
  check(
    "★ 类型文件里定义的类型都从 store 转发了（没有「定义了却取不到」的）",
    notForwarded.length === 0,
    notForwarded,
  );
}

/* ─────────── §C 搬迁确实发生过（防"又搬回去"） ─────────── */

console.log("\n§C 规模");
{
  const storeLines = storeSrc.split("\n").length;
  const typeLines = typesSrc.split("\n").length;
  console.log(`  info sessionStore.ts ${storeLines} 行 / sessionStoreTypes.ts ${typeLines} 行`);
  // 搬家前 sessionStore.ts 是 9379 行；搬完应显著变小。
  // 设成上限而不是等值：后续继续瘦身是好事，**长回去**才要问。
  check("sessionStore.ts 仍在 8000 行以下（类型层没搬回去）", storeLines < 8000, storeLines);
  check("SessionState 住在类型文件里（1688 行的那个接口）", typesSrc.includes("export interface SessionState"));
  check("sessionStore.ts 里不再定义 SessionState", !/^export interface SessionState/m.test(storeSrc));
}

console.log(`\nsession-store-types-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
