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

/* 【UI 重建 2026-10-27】默认档的**依据换了**。
 *
 * 原来断言 1.625，出处是 `open-claude-ui` 里 `ChatMessageBubbles.tsx` 的
 * Tailwind `leading-relaxed`。那份第三方逆向目录已按用户要求删除，
 * 外观基准改成**用户本机安装的 Claude Desktop 3.1623.4.0**。
 *
 * 新依据（从它的产物里直接读到）：
 *   --cds-font-size-body : calc(.8125rem × rem-scale)
 *   --cds-leading-body   : calc(1.25rem  × rem-scale)
 *   --cds-rem-scale      : calc(16 / 17)
 * 两者相除 = 1.25 / 0.8125 = **1.538462**（rem-scale 约掉，与它无关）。
 *
 * 实现取 1.5378（与 1.538462 差 0.04%，是行高 px 取整造成的），
 * 所以断言用一个容差而不是严格相等 —— 但**仍然钉住「必须是 Claude 的那个比例」**：
 * 1.45 / 1.625 都落在容差外。 */
const CLAUDE_BODY_LEADING = 1.25 / 0.8125; // = 1.538462
console.log(`\n[2] ★ 默认档必须等于 Claude 的 leading/body 比例（${CLAUDE_BODY_LEADING.toFixed(6)}）`);
check(
  "comfortable ≈ 1.5385（Claude --cds-leading-body / --cds-font-size-body）",
  comfortable !== null && Math.abs(comfortable - CLAUDE_BODY_LEADING) < 0.002,
  { comfortable, expected: CLAUDE_BODY_LEADING },
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
