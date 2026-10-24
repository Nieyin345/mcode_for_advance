/**
 * 【T142】`text-sm` → `text-body` 迁移的守护。
 *
 * ## 这套要守的到底是什么
 *
 * 这张卡的全部价值是「**零视觉变化**」。而这个结论完全依赖一个前提：
 *
 *     tailwind.config.js 里 body === ["14px", 20px]
 *     Tailwind 默认的 text-sm     ===  14px / 20px
 *
 * **这个前提在原仓库里没有任何断言守着。** 哪天有人把 `body` 的 lineHeight
 * 从 20px 改成 18px（一次很自然的「调紧一点行距」），那 22 处会**静默变化**，
 * 而「零视觉变化」的结论悄悄失效 —— 没人会知道。所以第 [1] 组读的是
 * **tailwind.config.js 的真身**。
 *
 * ## 为什么不 import tailwind.config.js
 *
 * 它是 `.js`（CommonJS 默认导出函数/对象），且内部 `require("tailwindcss/...")`
 * 之类只在构建时存在。**用正则从一个文本默认值里读**是脆的，所以这里走的是
 * 另一条路：把配置**当模块 require 进来**（Node 能直接跑 CJS）。如果将来它变成
 * ESM/TS，这一处会报错而不是静默通过 —— 这是想要的失败方向。
 *
 * ## 断言口径（区分「真换了」和「注释里写了」）
 *
 * 第 [2] 组扫的是 `.tsx` **源码**，所以必须先剥注释。`cn.ts` 和 `sessionStore.ts`
 * 的注释里各有一处字面量 `text-sm`（解释 Tailwind 内置档位），它们**不是用法**。
 * 用 `stripComments` 剥掉再数，否则「归零」这条断言永远不会红。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, resolve } from "node:path";

// ⚠️ **不要用 `import.meta.url`**：esbuild 打出来的是临时目录下的 bundle，
// `import.meta.url` 指向那里，而不是本文件 —— 第一次跑就是这么炸的
// （`scandir 'C:\...\AppData\Local\src\renderer'`）。
//
// `run.sh` 里 `cd "$HERE/../.."` 已经把工作目录切到 `apps/desktop`，
// 所以从 cwd 往上走更可靠。再断言一次「这里真的是 apps/desktop」，
// 否则从别处调用会静默扫错目录。
const APP_ROOT = process.cwd();
if (!statSync(join(APP_ROOT, "package.json")).isFile()) {
  throw new Error(`expected cwd to be apps/desktop, got ${APP_ROOT}`);
}
const RENDERER = join(APP_ROOT, "src/renderer");

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 递归收集 `*.tsx`（渲染端组件；`.ts` 里的 `text-sm` 全是注释，见文件头）。 */
function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsx(full));
    } else if (extname(full) === ".tsx") {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释，**保留字符串内容**（字符串里的 `//` 不是注释，
 * 例如 URL）。够用就好：这些文件里没有正则字面量里带 `//` 的情况，而且我们的断言
 * 只看「剥完之后还剩几个 text-sm」—— 多剥/少剥一个注释都只影响那一处，不会掩盖整体。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 字符串字面量：原样跳过（里面的 // 与 /* 不是注释）
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 词边界计数：`text-sm/50`、`text-small` 都不算 `text-sm`。 */
function countToken(src: string, token: string): number {
  const re = new RegExp(`(?<![-\\w])${token.replace(/-/g, "\\-")}(?![-\\w/])`, "g");
  return (src.match(re) ?? []).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// [1] ★ 全卡的核心前提：body 必须恰好等于 Tailwind 的 text-sm
//
// 读**真身**（require 进来的配置对象），不是正则抓文本。
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] ★ body 档必须恰好 = Tailwind text-sm 的 14px / 20px（零变化的前提）");

const require_ = createRequire(join(APP_ROOT, "package.json"));
let fontSizeTable: Record<string, unknown> | undefined;
try {
  const cfg = require_(join(APP_ROOT, "tailwind.config.js"));
  const resolved = cfg?.default ?? cfg;
  fontSizeTable = resolved?.theme?.extend?.fontSize;
} catch (err) {
  console.log(`  FAIL 读取 tailwind.config.js —— ${(err as Error).message}`);
  failures++;
  total++;
}

if (fontSizeTable === undefined) {
  check("tailwind.config.js 能读出 theme.extend.fontSize", false, { fontSizeTable });
} else {
  const body = fontSizeTable["body"];
  // 配置的写法是 ["14px", { lineHeight: "20px" }]
  const isArray = Array.isArray(body) && body.length === 2;
  const size = isArray ? (body as unknown[])[0] : undefined;
  const lhObj = isArray ? (body as unknown[])[1] : undefined;
  const lineHeight =
    lhObj !== null && typeof lhObj === "object"
      ? (lhObj as Record<string, unknown>)["lineHeight"]
      : undefined;

  check('body 的字号是 "14px"（= Tailwind text-sm 的 14px）', size === "14px", { size });
  check('body 的行高是 "20px"（= Tailwind text-sm 的 20px）', lineHeight === "20px", {
    lineHeight,
  });

  // ★ 这条是本卡的「前提守门员」：把上面两条合成一句人能读懂的判断。
  //   有人调了 body 的行高 / 字号，这条会红，而那 22 处迁移的「零变化」前提
  //   就在这条断言里被保住了。
  check(
    "★ 前提完整：body === 14px/20px == text-sm 的默认值（这 22 处零视觉变化靠它）",
    size === "14px" && lineHeight === "20px",
    { size, lineHeight },
  );

  // 负控：如果这条「前提」永远为真，它就什么都没守。所以同时断言 body 的**字号**
  // 不是别的常见值（防止有人把整个表改成一个统一值而这条仍然绿）。
  /** 取某一档的字号（`["14px", {lineHeight}]` 的第 0 位）。缺档返回 undefined。 */
  const tierSize = (tier: string): unknown => {
    const entry = fontSizeTable?.[tier];
    return Array.isArray(entry) ? (entry as unknown[])[0] : undefined;
  };

  check(
    "负控：body 不等于 caption/footnote/code 的字号（证明这条读的是 body 自己的值）",
    size !== tierSize("caption") &&
      size !== tierSize("footnote") &&
      size !== tierSize("code"),
    {
      body: size,
      caption: tierSize("caption"),
      footnote: tierSize("footnote"),
      code: tierSize("code"),
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// [2] text-sm 在 .tsx 用法里归零（剥注释后计数）
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] text-sm 在渲染端 .tsx 用法里归零（注释不算）");

const tsxFiles = collectTsx(RENDERER);
let liveTextSm = 0;
let liveTextBody = 0;
const offenders: Array<{ file: string; count: number }> = [];

for (const file of tsxFiles) {
  const raw = readFileSync(file, "utf8");
  const code = stripComments(raw);
  const sm = countToken(code, "text-sm");
  if (sm > 0) {
    offenders.push({ file: relative(APP_ROOT, file), count: sm });
    liveTextSm += sm;
  }
  liveTextBody += countToken(code, "text-body");
}

check("text-sm 在 .tsx 代码里出现 0 次", liveTextSm === 0, {
  total: liveTextSm,
  offenders,
});
check("text-body 已用上（≥ 114 处，迁移前的 92 + 本卡 22）", liveTextBody >= 114, {
  textBody: liveTextBody,
});

// 负控：确认扫描确实读到了文件（0 个文件时上面两条会「碰巧」全绿）
check("负控：扫描确实读到了 .tsx 文件（> 100 个）", tsxFiles.length > 100, {
  files: tsxFiles.length,
});

// ─────────────────────────────────────────────────────────────────────────────
// [3] 剥注释函数本身不能把代码也吃掉（防止「全剥了所以归零」的假绿）
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 剥注释不误伤代码（否则第 [2] 组是假绿）");

const FIXTURE = [
  'const a = "text-sm";', // 字符串里的 text-sm：**算用法**（它是真的 className）
  "// text-sm in a line comment", // 注释：不算
  "/* text-sm in a block comment */", // 注释：不算
  "const b = `x // not a comment ${y}`;", // 模板串里的 // 不是注释
  "const c = 'text-body';",
].join("\n");
const stripped = stripComments(FIXTURE);

check("字符串字面量里的 text-sm 仍然被数到（它是真 className）", countToken(stripped, "text-sm") === 1, {
  count: countToken(stripped, "text-sm"),
});
check("行注释 / 块注释里的 text-sm 被剥掉", !stripped.includes("in a line comment") && !stripped.includes("block comment"), {
  stripped,
});
check("模板字符串里的 // 不被当注释（后面的 text-body 还在）", countToken(stripped, "text-body") === 1, {
  count: countToken(stripped, "text-body"),
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nt142-font-tier-migration-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
