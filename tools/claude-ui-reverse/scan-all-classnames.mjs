/**
 * 从全部 chunk 里挑出 **UI 骨架**的 className，解成 px。
 *
 * ## 上一版为什么失败
 *
 * 上一版按「className 前面 600 字符里最近的 `data-cds=`」归类，
 * 结果 **10352 串全落进 `unknown`** —— 因为 className 与 data-cds 属性
 * 在同一次 `createElement` 调用里，但**顺序不固定**，且 minified 后
 * 中间可能隔着几十个参数。
 *
 * ## 这一版的做法
 *
 * 不提「这个类属于哪个组件」，改成**判断「这段代码是不是 UI 骨架」**：
 * 看 className **前后各 2000 字符**里是否出现骨架特征词
 * （`sidebar` / `titlebar` / `composer` / `transcript` / `New Chat` …）。
 * 命中就用那个特征词当桶名，否则丢弃。
 *
 * 这样得到的桶是「哪个区域」，而不是「哪个 React 组件」——
 * 后者需要 AST，而 minified bundle 没有可靠的组件边界。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { geometryOf } from "./resolve-class.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

const CLAUDE_ASSETS =
  "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

/**
 * 骨架特征词。**按特异性排序** —— 先匹配到的赢
 * （`ChatComposerDock` 比 `composer` 更具体）。
 */
const FEATURES = [
  ["输入框·外壳",   /ChatComposerDock|epitaxy-sticky-prompt|composer-dock/],
  ["输入框·编辑区", /ChatComposerEditor|ProseMirror|contentEditable/],
  ["输入框·按钮区", /ChatComposerActions|composer-action-row|composer-minipill/],
  ["输入框·下巴",   /ChatComposerChin|composer-chin/],
  ["输入框·提示",   /ChatComposerNotices|composer-notice/],
  ["输入框·排队",   /ChatComposerQueuedMessages/],
  ["消息区·容器",   /EpitaxyTranscriptHost|epitaxy-transcript|transcript-typography/],
  ["消息区·回合",   /EpitaxyTurnBox|TurnStatus|turn-status/],
  ["消息区·助手",   /AssistantMessage|assistant-message/],
  ["消息区·用户",   /UserMessage|user-message/],
  ["消息区·操作",   /MessageActions|message-actions/],
  ["正文",          /data-cds=Prose|\b\.prose\b|ProseMirror/],
  ["侧栏",          /Sidebar|sidebar|session-rail|EpitaxySessionRailHost|df-rail/],
  ["标题栏",        /Titlebar|titlebar|TitleBar|drag-region|EpitaxyTitlebar/],
  ["面板",          /data-cds=Panel|PanelHost|side-panel|aside-panel/],
  ["工具条",        /data-cds=Toolbar|toolbar-ground/],
];

/** 从 src 的 [i-2000, i+2000] 里找骨架特征词。 */
function featureAt(src, i) {
  const win = src.slice(Math.max(0, i - 2000), Math.min(src.length, i + 2000));
  for (const [label, re] of FEATURES) if (re.test(win)) return label;
  return null;
}

const files = readdirSync(CLAUDE_ASSETS)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: statSync(join(CLAUDE_ASSETS, f)).size }))
  .sort((a, b) => b.size - a.size);

console.error(`扫 ${files.length} 个 chunk`);

const buckets = new Map();   // label -> Set(className)
let hits = 0, total = 0;

for (const { f } of files) {
  let src;
  try { src = readFileSync(join(CLAUDE_ASSETS, f), "utf8"); } catch { continue; }

  for (const m of src.matchAll(/className\s*:\s*"([^"]{3,400})"/g)) {
    const cs = m[1];
    if (!cs) continue;
    if (!/\b(w-|h-|min-w|max-w|min-h|max-h|px-|py-|p-|gap-|size-|rounded|inset-|top-|bottom-)/.test(cs)) continue;
    total++;
    const label = featureAt(src, m.index);
    if (!label) continue;
    hits++;
    if (!buckets.has(label)) buckets.set(label, new Set());
    buckets.get(label).add(cs);
  }
}

console.error(`含布局意图的 className ${total} 条，命中骨架特征 ${hits} 条`);

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— UI 骨架的组件几何

⚠️ **静态事实**：源码里写了哪些类、那些类算出来多少 px。
   **不是**渲染后的实际尺寸 —— 后者受 flex/容器/内容影响，只有跑起来才知道。

⚠️ 分桶依据是「className 前后 2000 字符里出现的骨架特征词」，
   不是 AST 级组件归属。同一串类名可能同时出现在多个区域，这里记在
   特异性最高的那个桶里。

图例：
  gap-sm → gap: 7.5px    表示 \`gap-sm\` 这个类编译出来是 7.5px
`;

const ORDER = FEATURES.map(([l]) => l);

for (const label of ORDER) {
  const set = buckets.get(label);
  if (!set || !set.size) continue;
  out += `\n${"=".repeat(80)}\n${label}   (${set.size} 串)\n${"=".repeat(80)}\n`;
  // 长的类名串信息量更大，优先
  for (const cs of [...set].sort((a, b) => b.length - a.length).slice(0, 50)) {
    const geo = geometryOf(cs);
    if (!geo.length) continue;
    const parts = geo.map((g) => {
      const kv = Object.entries(g.px)
        .map(([k, v]) => `${k}:${typeof v === "number" ? v.toFixed(1) : v}`)
        .join(",");
      return `${g.cls}(${kv})`;
    });
    out += `  ${cs}\n      ${parts.join("  ")}\n`;
  }
}

writeFileSync(R(".tmp/rev/component-geometry.txt"), out);
console.log(out.slice(0, 12000));
console.log(`\n…完整：.tmp/rev/component-geometry.txt`);
