/**
 * 【T147】对话正文行高 = 上游 `leading-relaxed`（1.625）。
 *
 * 本套读 `src/renderer/styles.css` 与 `components/chat/Markdown.tsx` 的真身。
 * **`smokes-for.sh` 不会把本套列为 `styles.css` 的覆盖者** —— 它的覆盖判定
 * 只认 `src/main/**`（`SMOKE_COVERS_RE` 写死了 `src/main/` 前缀），因为它是
 * 为主进程套件设计的。渲染端 `styles.css` 目前仍处在「没有 smokes-for 意义上的
 * 回归网」，这是该工具的已知范围限制，不是本套没覆盖。
 * ## 这张卡要守的是什么
 *
 * 上游正文（`open-claude-ui/code-examples/ChatMessageBubbles.tsx:361`）：
 *
 *     <div className="prose text-[15px] leading-relaxed ...">
 *
 * `leading-relaxed` 是 Tailwind 内置 1.625，而 `open-claude-ui/code-examples/
 * tailwind.config.js` **没有 `lineHeight` 段** —— 所以它就是 1.625，没被覆盖。
 *
 * 我们此前用的是 `--chat-md-leading: 1.45`，注释写「CDS 上游 1.42857」。
 * 那个 1.42857 来自 `cds-theme.css:179` 的 `--chat-leading`，**只被 :180/:181
 * 用来算间距，没有任何组件拿它当行高**。按它定行高是读错了变量。
 *
 * ## 为什么断言读源码真身而不是「文件里有没有 1.625」
 *
 * `src.includes("1.625")` 在注释里出现也算命中。本套先剥注释再按
 * `--chat-md-leading\s*:\s*<值>` 精确匹配，并且**读取该变量的真实使用点**，
 * 证明它不是死变量。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const here = dirname(fileURLToPath(import.meta.url));
// esbuild 把 bundle 放在临时目录，所以用 cwd（run.sh 已 cd 到 apps/desktop）。
const appDir = process.cwd();
const stylesPath = join(appDir, "src/renderer/styles.css");
const markdownPath = join(appDir, "src/renderer/components/chat/Markdown.tsx");

const stylesSrc = readFileSync(stylesPath, "utf8");
const markdownSrc = readFileSync(markdownPath, "utf8");

/**
 * 剥注释：`/* ... *\/` 与 `// ...`（行尾）。
 *
 * ⚠️ 不能只剥 `//` —— T140 那轮的取证工具就是漏了 `/* *\/`，块注释里的括号
 * 让括号配对永不归零，结论是工具造出来的（见 CLAUDE.md 第八条第 3 种）。
 * 这里用一个**不依赖括号配对**的简单状态机：碰到 `/*` 就跳到 `*\/`，碰到
 * 行首/空白后的 `//` 就跳到行尾。不处理字符串里的 `//`（CSS/TSX 源码里
 * 出现在字符串中的 `//` 会误伤，但本文件只用来找 `--chat-md-leading` 定义，
 * 定义行里不可能有 `//` 字符串）。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      // 保留换行，避免行号/分隔错乱
      out += "\n";
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "/") {
      // 只在行内空白之前是开头时当注释（避免误伤 "http://"）
      let j = i - 1;
      while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
      const lineStart = j < 0 || src[j] === "\n" || src[j] === ";" || src[j] === "{";
      if (lineStart) {
        const end = src.indexOf("\n", i);
        i = end === -1 ? src.length : end;
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return out;
}

const stylesCode = stripComments(stylesSrc);

/**
 * 找出三个密度档各自的 `--chat-md-leading` 值。
 *
 * 结构（styles.css）：
 *   :root, [data-chat-density="comfortable"] { ... --chat-md-leading: X; }
 *   [data-chat-density="compact"]            { ... --chat-md-leading: Y; }
 *   [data-chat-density="cozy"]               { ... --chat-md-leading: Z; }
 *
 * 不用正则做「块提取」，因为大括号嵌套不可靠；改为：按选择器字符串定位，
 * 然后从那个位置往后找**第一个** `--chat-md-leading:`。
 */
function leadingAfter(selector: string): number | null {
  const at = stylesCode.indexOf(selector);
  if (at === -1) return null;
  const m = /--chat-md-leading\s*:\s*([0-9.]+)\s*;/.exec(stylesCode.slice(at));
  if (!m) return null;
  return Number(m[1]);
}

const comfortable = leadingAfter('[data-chat-density="comfortable"]');
const compact = leadingAfter('[data-chat-density="compact"]');
const cozy = leadingAfter('[data-chat-density="cozy"]');

console.log("\n[1] 三档 --chat-md-leading 都定义在（剥注释后的）源码里");
check("comfortable 档有值", comfortable !== null, { comfortable });
check("compact 档有值", compact !== null, { compact });
check("cozy 档有值", cozy !== null, { cozy });

/* 【UI 重建 2026-10-28】**期望值改了：1.5385 → 1.4385。上一版配错了档位。**
 *
 * 上一版写 `1.25 / 0.8125` = 1.538462，两个数取自**不同的层**：
 *
 *   --cds-leading-body   .cds-root 基础层 → 1.25rem
 *   --cds-font-size-body .cds-root 基础层 → .8125rem
 *
 * 但它们**都还有 comfortable 层的值**，而 Claude 的 `index.html` 上写着
 * `data-density="comfortable"` —— 用户真实看到的是那一层：
 *
 *   --cds-leading-body   comfortable → 1.25rem  (20px)
 *   --cds-font-size-body comfortable → .875rem  (14px)
 *
 * 真 Electron 实测这两个 token 在 `<div class="cds-root" data-density="comfortable">`
 * 下的 computed 值：`14px` / `20px` → 比值 **1.428571**。
 *
 * 上一版碰巧用对了 leading（两层都是 1.25rem），却用错了 body
 * （基础层 .8125 而非 comfortable .875），于是比值偏高 7.7%。
 *
 * ## 但正文实际用的不是这个比值
 *
 * ⚠️ `.prose`（AI 回复的容器）自己写着
 * `--_prose-leading: var(--cds-leading-prose, 1.5)` ——
 * 正文行高是 **1.5**，不是 body 档的 1.4286。本套件守的是
 * `--chat-md-leading`，它跟着 **prose**，所以期望值是 1.5。
 *
 * 这条断言现在同时钉两件事：Mcode 的默认档 = Claude `--_prose-leading`，
 * 且它落在 body 比值 (1.4286) 之上 —— 两者差 5%，足以分辨用的是哪一档。 */
const CLAUDE_PROSE_LEADING = 1.5; // = --cds-leading-prose / --cds-font-size-prose = 1.5rem/1rem
console.log(`\n[2] ★ 默认档必须等于 Claude 正文的 leading（${CLAUDE_PROSE_LEADING}）`);
check(
  "comfortable ≈ 1.5（Claude --_prose-leading = 1.5rem / 1rem）",
  comfortable !== null && Math.abs(comfortable - CLAUDE_PROSE_LEADING) < 0.002,
  { comfortable, expected: CLAUDE_PROSE_LEADING },
);
check(
  "★ 且不等于 transcript 层比值 1.4286（证明量的是正文那一档，不是外层的 --chat-leading）",
  comfortable !== null && Math.abs(comfortable - 1.428571) > 0.01,
  { comfortable, transcriptRatio: 1.428571 },
);
check(
  "负控：默认档既不等于旧值 1.45，也不等于第三方文档的 1.625（证明这条不是恒真）",
  comfortable !== 1.45 && comfortable !== 1.625,
  { comfortable },
);

console.log("\n[3] 三档单调：compact < comfortable < cozy");
check(
  "compact 严格小于 comfortable",
  compact !== null && comfortable !== null && compact < comfortable,
  { compact, comfortable },
);
check(
  "comfortable 严格小于 cozy",
  comfortable !== null && cozy !== null && comfortable < cozy,
  { comfortable, cozy },
);
check(
  "负控：三档不是同一个值（否则单调性会退化成恒假）",
  new Set([compact, comfortable, cozy]).size === 3,
  { compact, comfortable, cozy },
);

console.log("\n[4] 每个档恰好出现一次（防止某个档被覆盖两次）");
{
  // 全文件（剥注释后）里 `--chat-md-leading:` 的出现次数
  const count = (stylesCode.match(/--chat-md-leading\s*:/g) ?? []).length;
  check("styles.css 里 --chat-md-leading 定义恰好 3 处", count === 3, { count });
}

console.log("\n[5] ★ 它是活变量：Markdown.tsx 真的把它读进 line-height");
check(
  "Markdown.tsx 里有 [line-height:var(--chat-md-leading)]",
  markdownSrc.includes("line-height:var(--chat-md-leading)"),
  undefined,
);
check(
  "负控：Markdown.tsx 不是随便一个文件（含 chat-md 类名）",
  markdownSrc.includes("chat-md"),
  undefined,
);

console.log("\n[6] 注释里不许再出现「上游 1.42857」这个错误依据");
{
  // 只检查【T147 更正】之前的旧说法是否还在生效的注释块里。
  // 允许出现「此前写」这类更正记录，但禁止出现「CDS 上游 1.42857,取整到」这种
  // 把错误值当现状的说法。
  const banned = /CDS 上游 1\.42857/;
  check(
    'styles.css 不再把 1.42857 当成现行依据（无 "CDS 上游 1.42857"）',
    !banned.test(stylesSrc),
    undefined,
  );
}

console.log("");
if (failures > 0) {
  console.log(`t147-chat-leading-smoke: ${total - failures}/${total} 通过，${failures} 条失败`);
  process.exit(1);
}
console.log(`t147-chat-leading-smoke: ${total}/${total} 通过`);
