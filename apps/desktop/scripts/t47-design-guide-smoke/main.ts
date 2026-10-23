/**
 * 【T47】模型能不能拿到 `guide slides design` 的设计方法论。
 *
 * ## 缺陷（本套件证明它成立、再证明它被修好）
 *
 * T43 让 `build_deck` 能造 deck 了，但模型**没有入口**拿到上游的设计规范：
 * `document_tool_describe` 传的是工具名（`load_guide`），不是子域 `design`。
 * 实测 `genoffice guide slides design --json` 是 **12,231 字符**的方法论 ——
 * 18 种布局名、CJK/拉丁排版数值、以及一份明写 "treat as defects" 的反模式清单
 * （第一条就是「每张卡片左侧的细竖条」，AI 做 PPT 最常见的丑法）。
 *
 * ## 钉住什么
 *
 *  1. `document_guide({app:"slides", topic:"design"})` 返回的正文**含 style.md /
 *     outline.json 的要求**、18 种布局名、反模式清单、CJK 数值、两轮修纪律
 *     —— 不是空、不是报错、不是只给前 4000 字；
 *  2. `topic:"spec"` 给页面规格的字段；
 *  3. 省略 topic 取该域顶层目录；
 *  4. 负控：非法 domain / topic、CLI 不认的 topic 都**显式报错**（不静默给空）；
 *  5. `build_deck` 的报错文案指向**可达**的 `document_guide`，不再指向模型够不到的
 *     `` `guide slides design` ``（卡上的判据 3）；
 *  6. 工具描述里有完整步骤（判据 4）—— 读 `appMcpTools()` 里 `document_tool_call`
 *     的 description。
 *
 * ## 变异
 *
 * `--mutate=no-topic`：`documentGuide` 不把 topic 传给 `guideOps`
 * （模拟「接了但没接对」，即 T47 原缺陷的形态）→ 断言必须变红。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MUTATE = process.argv.find((arg) => arg.startsWith("--mutate="))?.slice("--mutate=".length) ?? null;

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 700)}`}`);
  }
}

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const CLI = join(REPO_ROOT, "genoffice", "packages", "cli", "dist", "genoffice.cjs");

const WORK = mkdtempSync(join(tmpdir(), "t47-work-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });

const rt = await import("../../src/main/document/documentToolRuntime.js");

const ports = {
  cliPath: CLI,
  withinWorkspace: () => true,
  rendererOpen: () => false,
  renderTempRoot: () => WORK,
};

/** 变异注入：把 topic 丢掉（复现 T47 原缺陷）。 */
const guide: typeof rt.documentGuide = MUTATE === "no-topic"
  ? (async (p, a) => rt.documentGuide(p, { ...a, topic: undefined })) as typeof rt.documentGuide
  : (p, a) => rt.documentGuide(p, a);

console.log("\n1. design 规范：模型必须拿到完整方法论（不是前 4000 字）");
{
  const d = await guide(ports, { app: "slides", topic: "design" });
  check("取到了", d.ok === true, d.ok ? undefined : d);
  if (d.ok) {
    console.log(`     domain=${d.domain} topic=${d.topic} chars=${d.chars}`);
    const markers: Array<[string, string]> = [
      ["style.md 的要求", "style.md"],
      ["outline.json 的要求", "outline.json"],
      ["18 种布局之一（cover_typography_hero）", "cover_typography_hero"],
      ["反模式清单标题（treat as defects）", "treat as defects"],
      ["竖条反模式原文（thin vertical accent bar）", "thin vertical accent bar"],
      ["CJK 排版数值", "CJK"],
      ["两轮修纪律（two fix rounds）", "two fix rounds"],
    ];
    for (const [label, needle] of markers) check(`正文含 ${label}`, d.text.includes(needle), { chars: d.chars });
    // 卡里的判据：不许被截断（describe 的 4000 字上限曾经把反模式清单切掉）。
    check("正文远超 4000 字（未被截断）", d.chars > 8000, { chars: d.chars });
  }
}

console.log("\n2. spec 规范：页面规格的字段");
{
  const s = await guide(ports, { app: "slides", topic: "spec" });
  check("取到了", s.ok === true, s.ok ? undefined : s);
  if (s.ok) {
    check("正文含画布尺寸（1280）", s.text.includes("1280"), { chars: s.chars });
    check("正文含元素类型（text / image / shape 之一）",
      ["\"text\"", "**Text**", "**Image**", "**Shape**"].some((needle) => s.text.includes(needle)), { chars: s.chars });
  }
}

console.log("\n3. 省略 topic：取该域的顶层目录");
{
  const t = await guide(ports, { app: "slides" });
  check("省略 topic 也能取到", t.ok === true, t.ok ? undefined : t);
}

console.log("\n4. 负控：非法输入显式报错，不静默给空");
{
  const badDomain = await rt.documentGuide(ports, { domain: "../../etc" });
  check("非法 domain 被拒", badDomain.ok === false, badDomain);
  check("拒绝时给出可用域", !badDomain.ok && (badDomain.suggestions?.length ?? 0) > 0, badDomain);

  const badTopic = await rt.documentGuide(ports, { app: "slides", topic: "../secrets" });
  check("非法 topic 被拒（不接受任意 argv）", badTopic.ok === false, badTopic);

  const unknownTopic = await guide(ports, { app: "slides", topic: "no_such_topic_xyz" });
  check("CLI 不认的 topic 如实报错", unknownTopic.ok === false, unknownTopic);
  if (!unknownTopic.ok) check("报错里带该域已知可用的 topic", (unknownTopic.suggestions?.length ?? 0) > 0, unknownTopic);
}

console.log("\n5. build_deck 的报错文案指向可达入口（卡判据 3）");
{
  const call = await rt.documentToolCall(ports, {
    tool: "build_deck", app: "slides", filePath: join(WORK, "out.pptx"), input: {},
  });
  check("缺 specDir 时被拒", call.ok === false, call);
  const reason = call.ok ? "" : call.reason;
  check("文案点名 document_guide", reason.includes("document_guide"), { reason: reason.slice(0, 300) });
  check("文案不再把 `guide slides design` 当成模型能跑的入口",
    !reason.includes("设计流水线的规范在 `guide slides design`"), { reason: reason.slice(0, 300) });
  check("文案给出完整步骤（guide → 写 spec → build → 看 → 修）",
    reason.includes("style.md") && reason.includes("outline.json") && reason.includes("build_deck"), { reason: reason.slice(0, 400) });
}

console.log("\n6. 工具描述里有完整步骤（卡判据 4）");
{
  // 直接读源码里的 description 文本：`appMcpTools()` 需要 electron 与一堆端口的装配，
  // 这里断言的是**写给模型的文字**本身。
  const toolsSrc = readFileSync(join(REPO_ROOT, "apps/desktop/src/main/appControl/tools.ts"), "utf8");
  const guideIdx = toolsSrc.indexOf('name: "document_guide"');
  const guideBlock = guideIdx < 0 ? "" : toolsSrc.slice(guideIdx, guideIdx + 2200);
  check("appMcpTools 里有 document_guide 工具", guideBlock.length > 0, { found: guideBlock.length });
  check("document_guide 的描述提到 design", /topic:\\"design\\"|topic:"design"/.test(guideBlock) || guideBlock.includes("design"),
    { sample: guideBlock.slice(0, 300) });
  check("document_guide 的描述提到反模式清单", guideBlock.includes("反模式"), { sample: guideBlock.slice(0, 300) });

  const callBlock = /name: "document_tool_call"[\s\S]{0,1800}?\n    \},/.exec(toolsSrc)?.[0] ?? "";
  check("document_tool_call 的描述里有 build_deck 的完整步骤",
    callBlock.includes("build_deck") && callBlock.includes("style.md") && callBlock.includes("outline.json")
      && callBlock.includes("document_guide"),
    { sample: callBlock.slice(0, 400) });
  check("步骤里写明「最多两轮修」", callBlock.includes("两轮"), { sample: callBlock.slice(0, 400) });
}

console.log(`\nt47-design-guide-smoke:${total - failures}/${total} 通过${MUTATE ? `（变异 ${MUTATE}）` : ""}`);
process.exit(failures === 0 ? 0 : 1);
