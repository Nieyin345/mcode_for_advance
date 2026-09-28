/**
 * 自定义 UI(`@contracts/customUi` + `main/customUi/targets.ts`)的回归网 —— 2026-09-28 立。
 *
 * ## 它守的规矩
 *
 * 1. **配置是用户数据,逐条宽容**:一条坏的自定义项 / 一个坏的挂载位布局只丢它自己,
 *    不能把整份配置作废(用户摆好的菜单全没了)。
 * 2. **新东西默认出现**:布局里没列到的条目(新内置项、新模块、新建的自定义项)接在
 *    后面显示,而不是默默藏起来;布局里残留的已删除条目直接跳过。
 * 3. **模板里认不出的变量渲染成空串**,不原样留给模型。
 * 4. **批量跑自动化的展开**:分类带上全部子分类、有环不死循环;文件必须在某个项目
 *    目录里(`/a/proj2` 不算在 `/a/proj` 里)。
 * 5. **右栏页签 / 工具栏(P3)**:每个挂载位只收它用得上的动作(页签只能「显示」,手改 JSON
 *    塞进去的「运行自动化」整条丢);工作区目标没有「右键的那个东西」,带显示条件的项一律
 *    不出现;相对路径按项目根拼、没有项目就拼不出。
 *
 * 纯模块(不 import electron / store),直接 bundle 就能跑。
 *
 * Run: scripts/custom-ui-smoke/run.sh
 */
import {
  arrangeSlotEntries,
  builtinKey,
  coerceCustomUiConfig,
  customKey,
  customUiLabel,
  CustomUiRunAutomationSchema,
  DEFAULT_CUSTOM_UI_CONFIG,
  extensionOf,
  matchesWhen,
  moduleKey,
  normalizeExtension,
  parseCustomUiConfig,
  renderTemplate,
  targetKindOfSlot,
  TEMPLATE_VARS_BY_SLOT,
  templateVarsOf,
  unknownTemplateVars,
  CUSTOM_UI_SLOTS,
  CUSTOM_UI_ICONS,
  ACTIONS_BY_SLOT,
  isActionAllowed,
  localDateString,
  resolveWorkspacePath,
  type CustomUiTarget,
} from "@contracts/customUi";
import type { LibraryItem } from "@contracts/library";
import { collectCollectionIds, isInsideAnyProject, itemFactsOf, shouldSkipItem } from "../../src/main/customUi/targets.js";
import { describeTriggerPayload, payloadFactsOf } from "../../src/main/orchestration/automationPayload.js";
import { LIT_IMPORT_PY } from "../../src/main/workflows/assets.js";
import { spawnSync } from "node:child_process";
import { buildDefaultLibraryItems } from "../../src/renderer/components/customUi/seedDefaults.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { expected, got: actual });
}

/* ── 1. 读配置:逐条宽容 ─────────────────────────────────────────────── */

eq("空串 → 默认配置", parseCustomUiConfig(""), DEFAULT_CUSTOM_UI_CONFIG);
eq("null → 默认配置", parseCustomUiConfig(null), DEFAULT_CUSTOM_UI_CONFIG);
eq("不是 JSON → 默认配置", parseCustomUiConfig("{oops"), DEFAULT_CUSTOM_UI_CONFIG);
eq("版本不对 → 默认配置", parseCustomUiConfig(JSON.stringify({ version: 2, items: [] })), DEFAULT_CUSTOM_UI_CONFIG);
eq("数组顶层 → 默认配置", coerceCustomUiConfig([]), DEFAULT_CUSTOM_UI_CONFIG);

const goodItem = {
  id: "cite",
  slot: "library.item",
  label: { zh: "生成引用", en: "Cite" },
  icon: "quote",
  action: { type: "prompt", template: "为 {{item.title}} 生成引用", attach: true },
};
const mixed = coerceCustomUiConfig({
  version: 1,
  items: [
    goodItem,
    { ...goodItem, id: "BAD ID" }, // id 不合法
    { ...goodItem, id: "no-label", label: { zh: "" } }, // 中文名为空
    { ...goodItem, id: "bad-action", action: { type: "shell", cmd: "rm -rf /" } }, // 不认识的动作
    { ...goodItem, id: "bad-icon", icon: "skull" }, // 不在白名单里的图标
    { ...goodItem, label: { zh: "重复的" } }, // id 重复,只留第一条
    {
      id: "run-auto",
      slot: "library.collection",
      label: { zh: "批量转录" },
      action: { type: "automation", workflowId: "wf1", triggerNodeId: "t1" },
    },
  ],
  layout: {
    "library.item": { order: ["custom:cite", "builtin:info"], hidden: ["builtin:links"] },
    "library.group": { order: "not-an-array" }, // 坏的布局只丢这个挂载位
    "not.a.slot": { order: [], hidden: [] }, // 不认识的挂载位忽略
    "files.context": { hidden: ["builtin:openInBrowser"] }, // order 缺省 → []
  },
});
eq("坏条目逐条丢弃,好的留下(含 id 去重)", mixed.items.map((i) => i.id), ["cite", "run-auto"]);
eq("重复 id 保留第一条的内容", mixed.items[0]?.label.zh, "生成引用");
eq("好的布局留下", mixed.layout["library.item"], { order: ["custom:cite", "builtin:info"], hidden: ["builtin:links"] });
check("坏的挂载位布局被丢掉", mixed.layout["library.group"] === undefined, mixed.layout);
check("不认识的挂载位被忽略", !("not.a.slot" in mixed.layout), mixed.layout);
eq("缺省的 order 补成 []", mixed.layout["files.context"], { order: [], hidden: ["builtin:openInBrowser"] });
eq("往返一次不变", parseCustomUiConfig(JSON.stringify(mixed)), mixed);

/* ── 2. 布局:排序 / 隐藏 / 新东西默认出现 ──────────────────────────── */

const avail = [builtinKey("attachToChat"), builtinKey("info"), moduleKey("m", "c"), customKey("x")];
eq("没有布局 → 原顺序", arrangeSlotEntries(avail, undefined), avail);
eq(
  "order 在前,没列到的按原顺序接在后面",
  arrangeSlotEntries(avail, { order: [customKey("x"), builtinKey("info")], hidden: [] }),
  [customKey("x"), builtinKey("info"), builtinKey("attachToChat"), moduleKey("m", "c")],
);
eq(
  "隐藏的去掉",
  arrangeSlotEntries(avail, { order: [], hidden: [builtinKey("info"), moduleKey("m", "c")] }),
  [builtinKey("attachToChat"), customKey("x")],
);
eq(
  "includeHidden 时保留隐藏项(设置页要列出来)",
  arrangeSlotEntries(avail, { order: [], hidden: [builtinKey("info")] }, { includeHidden: true }),
  avail,
);
eq(
  "order 里已不存在的键(模块卸了)直接跳过,重复键只算一次",
  arrangeSlotEntries(avail, { order: ["module:gone:x", customKey("x"), customKey("x")], hidden: [] }),
  [customKey("x"), builtinKey("attachToChat"), builtinKey("info"), moduleKey("m", "c")],
);
eq("模块键的形状", moduleKey("pdf-tools", "split"), "module:pdf-tools:split");

/* ── 3. 模板 ───────────────────────────────────────────────────────── */

eq("变量替换(容忍空格)", renderTemplate("《{{ item.title }}》{{item.url}}", { "item.title": "A", "item.url": "u" }), "《A》u");
eq("认不出的变量 → 空串", renderTemplate("x{{item.nope}}y", { "item.title": "A" }), "xy");
eq("不是变量语法的花括号原样保留", renderTemplate("{{ 1 }} {x}", {}), "{{ 1 }} {x}");
check("原型链上的键不算变量", renderTemplate("{{toString}}", {}) === "", renderTemplate("{{toString}}", {}));

const fileTarget: CustomUiTarget = { kind: "file", projectPath: "D:\\work\\proj", path: "D:\\work\\proj\\docs\\Report.PDF" };
eq("文件变量(反斜杠路径)", templateVarsOf(fileTarget), {
  "file.path": "D:\\work\\proj\\docs\\Report.PDF",
  "file.name": "Report.PDF",
  "file.ext": ".pdf",
  "file.dir": "D:\\work\\proj\\docs",
  "project.path": "D:\\work\\proj",
});
const itemTarget: CustomUiTarget = {
  kind: "item",
  groupId: "g1",
  item: { id: "i1", title: "Deep Learning", pdfPath: "papers/dl.pdf" },
};
eq("条目缺的字段是空串", templateVarsOf(itemTarget)["item.mdPath"], "");
for (const slot of CUSTOM_UI_SLOTS) {
  const kind = targetKindOfSlot(slot);
  const sample: CustomUiTarget =
    kind === "item"
      ? itemTarget
      : kind === "collection"
        ? { kind, level: "collection", collection: { id: "c", name: "n" } }
        : kind === "group"
          ? { kind, group: { id: "g", name: "n" } }
          : kind === "workspace"
            ? { kind, today: "2026-09-28" }
            : fileTarget;
  const vars = templateVarsOf(sample);
  check(
    `设置页列出的变量都真的存在(${slot})`,
    TEMPLATE_VARS_BY_SLOT[slot].every((v) => Object.hasOwn(vars, v)),
    { listed: TEMPLATE_VARS_BY_SLOT[slot], vars: Object.keys(vars) },
  );
}

/* ── 4. 显示条件 ───────────────────────────────────────────────────── */

eq("扩展名规范化", ["pdf", ".PDF", "*.pdf", " md "].map(normalizeExtension), [".pdf", ".pdf", ".pdf", ".md"]);
eq("extensionOf", [extensionOf("a/b.tar.GZ"), extensionOf(".bashrc"), extensionOf(undefined), extensionOf("c\\d")], [".gz", "", "", ""]);
check("无条件 → 满足", matchesWhen(undefined, itemTarget));
check("扩展名命中(条目的 pdfPath)", matchesWhen({ extensions: ["PDF"] }, itemTarget));
check("扩展名不中", !matchesWhen({ extensions: ["md"] }, itemTarget));
check("文件扩展名大小写不敏感", matchesWhen({ extensions: [".pdf"] }, fileTarget));
check("requires pdf 满足", matchesWhen({ requires: "pdf" }, itemTarget));
check("requires markdown 不满足", !matchesWhen({ requires: "markdown" }, itemTarget));
check("requires file:pdf 也算有文件", matchesWhen({ requires: "file" }, itemTarget));
check("requires 对非条目目标恒不满足", !matchesWhen({ requires: "file" }, fileTarget));
check("大类筛选命中", matchesWhen({ groupIds: ["g1"] }, itemTarget));
check("大类筛选不中", !matchesWhen({ groupIds: ["g2"] }, itemTarget));
check("大类目标按自己的 id 筛", matchesWhen({ groupIds: ["g"] }, { kind: "group", group: { id: "g", name: "n" } }));
check("没有大类信息的目标不满足大类筛选", !matchesWhen({ groupIds: ["g1"] }, fileTarget));
check("空的 groupIds 不限制", matchesWhen({ groupIds: [] }, fileTarget));

eq("英文名缺了回落中文", customUiLabel({ zh: "引用" }, "en"), "引用");
eq("英文界面用英文名", customUiLabel({ zh: "引用", en: "Cite" }, "en"), "Cite");

/* ── 5. IPC 入参 ───────────────────────────────────────────────────── */

check(
  "合法入参通过",
  CustomUiRunAutomationSchema.safeParse({ workflowId: "w", triggerNodeId: "t", target: { kind: "item", itemId: "i" } }).success,
);
check(
  "目标种类不认识 → 拒绝",
  !CustomUiRunAutomationSchema.safeParse({ workflowId: "w", triggerNodeId: "t", target: { kind: "shell", cmd: "x" } }).success,
);
check(
  "缺 triggerNodeId → 拒绝",
  !CustomUiRunAutomationSchema.safeParse({ workflowId: "w", target: { kind: "group", groupId: "g" } }).success,
);

/* ── 6. 批量展开(main/customUi/targets.ts)─────────────────────────── */

const cols = [
  { id: "root", parentId: null },
  { id: "a", parentId: "root" },
  { id: "a1", parentId: "a" },
  { id: "b", parentId: "root" },
  { id: "other", parentId: null },
  // 历史数据里的环
  { id: "x", parentId: "y" },
  { id: "y", parentId: "x" },
];
eq("子孙分类全收齐", [...collectCollectionIds(cols, ["root"])].sort(), ["a", "a1", "b", "root"]);
eq("叶子分类只有自己", collectCollectionIds(cols, ["a1"]), ["a1"]);
eq("有环也只收一次、不死循环", [...collectCollectionIds(cols, ["x"])].sort(), ["x", "y"]);
eq("多个根去重", [...collectCollectionIds(cols, ["root", "a"])].sort(), ["a", "a1", "b", "root"]);

check("项目内的文件", isInsideAnyProject("/w/proj/a.txt", ["/w/proj"], false));
check("前缀相同的兄弟目录不算", !isInsideAnyProject("/w/proj2/a.txt", ["/w/proj"], false));
check("项目根本身不算文件", !isInsideAnyProject("/w/proj", ["/w/proj"], false));
check("../ 逃逸不算", !isInsideAnyProject("/w/proj/../secret.txt", ["/w/proj"], false));
check("Windows 上不分大小写", isInsideAnyProject("/W/PROJ/a.txt", ["/w/proj"], true));
check("非 Windows 分大小写", !isInsideAnyProject("/W/PROJ/a.txt", ["/w/proj"], false));
check("项目根带尾斜杠也行", isInsideAnyProject("/w/proj/a.txt", ["/w/proj/"], false));

const libItem = { id: "i1", title: "T", pdfPath: "p/x.pdf", filePath: undefined } as unknown as LibraryItem;
eq("条目事实:没有的路径不出现", itemFactsOf(libItem), { itemId: "i1", itemTitle: "T", pdfPath: "p/x.pdf" });

/* ── 7. 右栏页签 / 竖向工具栏(P3)────────────────────────────────── */

eq("七个挂载位", CUSTOM_UI_SLOTS.length, 7);
eq("页签 → 工作区目标", targetKindOfSlot("rightPanel.tab"), "workspace");
eq("工具栏 → 工作区目标", targetKindOfSlot("toolbar"), "workspace");
eq("页签只能显示", [...ACTIONS_BY_SLOT["rightPanel.tab"]].sort(), ["file", "view"]);
check("右键菜单不能「切页签」", !isActionAllowed("library.item", "openTab") && !isActionAllowed("files.context", "file"));
check("工具栏六种都行", ACTIONS_BY_SLOT.toolbar.length === 6);
for (const slot of CUSTOM_UI_SLOTS) {
  check(`${slot} 有变量表`, Array.isArray(TEMPLATE_VARS_BY_SLOT[slot]) && TEMPLATE_VARS_BY_SLOT[slot].length > 0);
}

const p3 = coerceCustomUiConfig({
  version: 1,
  items: [
    { id: "t1", slot: "rightPanel.tab", label: { zh: "README" }, action: { type: "file", path: "README.md" } },
    // 页签里塞了个「运行自动化」→ 丢
    { id: "t2", slot: "rightPanel.tab", label: { zh: "坏" }, action: { type: "automation", workflowId: "w", triggerNodeId: "n" } },
    { id: "b1", slot: "toolbar", label: { zh: "切到 Git" }, action: { type: "openTab", tab: "builtin:git" } },
    { id: "b2", slot: "toolbar", label: { zh: "开日志" }, action: { type: "file", path: "notes/{{today}}.md" } },
    // 右键菜单里的「打开文件」→ 丢
    { id: "m1", slot: "library.item", label: { zh: "坏" }, action: { type: "file", path: "a.md" } },
    // 空路径 / 空页签 → schema 拒
    { id: "b3", slot: "toolbar", label: { zh: "空" }, action: { type: "file", path: "" } },
    { id: "b4", slot: "toolbar", label: { zh: "空" }, action: { type: "openTab", tab: "" } },
  ],
  layout: { "rightPanel.tab": { order: ["custom:t1", "builtin:files"], hidden: ["builtin:git"] } },
});
eq("P3 坏条目逐条丢", p3.items.map((i) => i.id), ["t1", "b1", "b2"]);
eq("页签布局保留", p3.layout["rightPanel.tab"], { order: ["custom:t1", "builtin:files"], hidden: ["builtin:git"] });
eq(
  "自定义页签可以排到内置前面,藏掉的 git 不出现",
  arrangeSlotEntries(["builtin:files", "builtin:git", "builtin:browser", "custom:t1"], p3.layout["rightPanel.tab"]),
  ["custom:t1", "builtin:files", "builtin:browser"],
);

const ws: CustomUiTarget = {
  kind: "workspace",
  project: { path: "/w/proj", name: "proj" },
  session: { id: "s1", title: "聊天" },
  today: "2026-09-28",
};
const wsBare: CustomUiTarget = { kind: "workspace", today: "2026-09-28" };
eq("工作区变量", templateVarsOf(ws), {
  "project.path": "/w/proj",
  "project.name": "proj",
  "session.id": "s1",
  "session.title": "聊天",
  today: "2026-09-28",
});
eq("没项目 / 没对话 → 空串", renderTemplate("[{{project.name}}|{{session.title}}|{{today}}]", templateVarsOf(wsBare)), "[||2026-09-28]");
check("没条件的项在工具栏出现", matchesWhen(undefined, ws));
check("带分组条件的项在工具栏不出现", !matchesWhen({ groupIds: ["g"] }, ws));
check("带 requires 的项在工具栏不出现", !matchesWhen({ requires: "pdf" }, ws));
check("带扩展名的项在工具栏不出现", !matchesWhen({ extensions: [".md"] }, ws));

eq("相对路径拼到项目根", resolveWorkspacePath("notes/2026-09-28.md", "/w/proj"), "/w/proj/notes/2026-09-28.md");
eq("./ 前缀去掉、项目根尾斜杠去掉", resolveWorkspacePath("./README.md", "/w/proj/"), "/w/proj/README.md");
eq("Windows 项目根用反斜杠", resolveWorkspacePath("docs/a.md", "D:\\w\\proj"), "D:\\w\\proj\\docs\\a.md");
eq("绝对路径原样", resolveWorkspacePath("/etc/x.md", "/w/proj"), "/etc/x.md");
eq("盘符绝对路径原样", resolveWorkspacePath("C:\\x.md", undefined), "C:\\x.md");
eq("没项目 → 拼不出", resolveWorkspacePath("README.md", undefined), null);
eq("空路径 → null", resolveWorkspacePath("   ", "/w/proj"), null);
eq("本地日期补零", localDateString(new Date(2026, 0, 5)), "2026-01-05");

/* ── 模板变量 lint（设置页保存前的提示；规矩 6：打错的变量要能被看见）── */

eq("已知变量 → 无未知", unknownTemplateVars("A {{item.title}} B", "library.item"), []);
eq("打错的变量被点名", unknownTemplateVars("{{item.titel}}", "library.item"), ["item.titel"]);
eq("同一个错只报一次、顺序保持", unknownTemplateVars("{{a.b}} {{item.title}} {{a.b}} {{c}}", "library.item"), ["a.b", "c"]);
eq("变量跟挂载位走：file.path 在文件右键是已知", unknownTemplateVars("{{file.path}}", "files.context"), []);
eq("变量跟挂载位走：file.path 在条目右键是未知", unknownTemplateVars("{{file.path}}", "library.item"), ["file.path"]);
eq("空白形态照样识别", unknownTemplateVars("{{  today }} {{nope}}", "toolbar"), ["nope"]);
eq("没有变量 → 空", unknownTemplateVars("plain text", "toolbar"), []);

/* ── 图标白名单只能往后加（名字存在用户配置里，改名/重排会让存量配置丢图标）── */

eq("图标表前 16 项冻结", [...CUSTOM_UI_ICONS.slice(0, 16)], [
  "sparkles", "bolt", "message", "file-text", "copy", "book", "robot", "world",
  "code", "quote", "tag", "star", "flask", "eye", "template", "download",
]);

/* ── P1:automation 动作的 skipWhen（批量跳过条件;通用原语,转录检测是它的一个用法）── */

{
  const cfg = coerceCustomUiConfig({
    version: 1,
    items: [{
      id: "transcribe",
      slot: "library.item",
      label: { zh: "手动转录" },
      action: { type: "automation", workflowId: "w1", triggerNodeId: "t1", skipWhen: { requires: "markdown" } },
    }],
    layout: {},
  });
  const a = cfg.items[0]?.action;
  check("skipWhen 在配置解析后保留", a?.type === "automation" && a.skipWhen?.requires === "markdown", a);
}
check("RunAutomation 输入接受 skipWhen", CustomUiRunAutomationSchema.safeParse({
  workflowId: "w1", triggerNodeId: "t1", target: { kind: "item", itemId: "i1" },
  skipWhen: { requires: "markdown" },
}).success);

const mkItem = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "i1", title: "T", collectionId: "c1", createdAt: 0, updatedAt: 0, ...over,
} as LibraryItem);
check("已有转录 → 跳过", shouldSkipItem(mkItem({ mdPath: "a.md" }), { requires: "markdown" }));
check("没有转录 → 不跳过", !shouldSkipItem(mkItem({}), { requires: "markdown" }));
check("没写 skipWhen → 不跳过", !shouldSkipItem(mkItem({ mdPath: "a.md" }), undefined));
check("按扩展名跳过(pdf 条目)", shouldSkipItem(mkItem({ pdfPath: "x.pdf" }), { extensions: [".pdf"] }));
check("扩展名不匹配 → 不跳过", !shouldSkipItem(mkItem({ filePath: "x.docx" }), { extensions: [".pdf"] }));

/* ── P2:automation 动作的 inputs(运行前输入;通用原语,文献导入是它的一个用法)── */

{
  const cfg = coerceCustomUiConfig({
    version: 1,
    items: [{
      id: "lit-import",
      slot: "library.collection",
      label: { zh: "文献导入" },
      action: {
        type: "automation", workflowId: "w1", triggerNodeId: "t1",
        inputs: [
          { key: "files", kind: "files", label: { zh: "文献文件" } },
          { key: "doi", kind: "text", label: { zh: "DOI" } },
        ],
      },
    }],
    layout: {},
  });
  const a = cfg.items[0]?.action;
  check("inputs 在配置解析后保留", a?.type === "automation" && a.inputs?.length === 2 && a.inputs[0]?.kind === "files", a);
}
{
  const bad = coerceCustomUiConfig({
    version: 1,
    items: [{
      id: "bad-key",
      slot: "library.collection",
      label: { zh: "坏输入名" },
      action: { type: "automation", workflowId: "w", triggerNodeId: "t", inputs: [{ key: "DOI 名", kind: "text" }] },
    }],
    layout: {},
  });
  check("非法输入键 → 整条丢(同坏条目)", bad.items.length === 0, bad.items);
}
check("RunAutomation 输入接受 input 值表", CustomUiRunAutomationSchema.safeParse({
  workflowId: "w1", triggerNodeId: "t1", target: { kind: "collection", collectionId: "c1" },
  input: { doi: "10.1/x", files: ["D:/a.pdf", "D:/b.pdf"] },
}).success);

/* 载荷侧:input 拍平成 `input.<key>` 平面键(TRIGGER_REF_RE 按字面查键,含点 ⟹
   {{trigger.input.doi}} 直接可解),人话段落带输入行。 */
{
  const facts = payloadFactsOf({ kind: "event", event: "library.item.imported", input: { doi: "10.1/x", files: ["D:/a.pdf"] } });
  check("facts 拍平 input.doi", facts["input.doi"] === "10.1/x", facts);
  check("facts 拍平 input.files(数组)", Array.isArray(facts["input.files"]) && facts["input.files"][0] === "D:/a.pdf", facts);
  const said = describeTriggerPayload({ kind: "event", event: "library.item.imported", input: { doi: "10.1/x" } });
  check("人话段落带输入", said.includes("doi") && said.includes("10.1/x"), said);
}
{
  const facts = payloadFactsOf({ kind: "file", files: ["D:/w/x.md"], input: { note: "n1" } });
  check("file 载荷同样拍平 input", facts["input.note"] === "n1", facts);
  check("没 input 不加键", !("input.note" in payloadFactsOf({ kind: "file", files: [] })), payloadFactsOf({ kind: "file", files: [] }));
}

/* ── 首启预置(seedDefaults):按用户现有自动化自动搭出文献菜单,绑定要可解释 ── */

{
  const wfs = [
    { id: "w-md", name: "文件到位后在线转 Markdown", hasTrigger: true },
    { id: "w-dl", name: "DOI 文献下载", hasTrigger: true },
  ];
  const trs = [
    { workflowId: "w-md", nodeId: "t1", title: "触发器", kind: "event" },
    { workflowId: "w-dl", nodeId: "t2", title: "触发器", kind: "manual" },
  ];
  const r = buildDefaultLibraryItems(wfs, trs);
  check("两条自动化都命中 → 6 个预置项", r.items.length === 6, r.items.map((i) => i.id));
  const t = r.items.find((i) => i.id === "seed-transcribe");
  check("手动转录绑 event 触发器 + skipWhen markdown",
    t?.action.type === "automation" && t.action.workflowId === "w-md" && t.action.skipWhen?.requires === "markdown", t);
  const imp = r.items.find((i) => i.id === "seed-lit-import");
  check("文献导入绑名字含下载/doi 的自动化并带 files+doi 输入",
    imp?.action.type === "automation" && imp.action.workflowId === "w-dl"
      && imp.action.inputs?.map((x) => x.key).join(",") === "files,doi", imp);
  check("绑定说明可解释", r.notes.some((n) => n.kind === "transcribe" && n.workflowName.includes("Markdown"))
    && r.notes.some((n) => n.kind === "import"), r.notes);
  check("预置项整体能过 schema", coerceCustomUiConfig({ version: 1, items: r.items, layout: {} }).items.length === 6);
  // 文献导入是「只定位」那一种 —— 少了它,空分类会被「这个范围里没有条目」挡死。
  const lit = r.items.find((i) => i.id === "seed-lit-import");
  check("文献导入预置带 targetMode: context",
    lit?.action.type === "automation" && lit.action.targetMode === "context", lit?.action);
  check("批量转录仍是 scope(不带 targetMode)",
    r.items.find((i) => i.id === "seed-batch-transcribe")?.action.type === "automation"
      && (r.items.find((i) => i.id === "seed-batch-transcribe")?.action as { targetMode?: string }).targetMode === undefined);
  check("targetMode 能过运行请求的 schema",
    CustomUiRunAutomationSchema.safeParse({
      workflowId: "w", triggerNodeId: "t", target: { kind: "collection", collectionId: "c" },
      targetMode: "context", input: { files: ["C:/a.pdf"] },
    }).success);
}
{
  const r = buildDefaultLibraryItems([], []);
  check("没有自动化 → 只有信息卡 + 两条缺失说明", r.items.length === 1 && r.items[0]?.id === "seed-item-info"
    && r.notes.filter((n) => n.kind === "missingTranscribe" || n.kind === "missingImport").length === 2, r);
}
{
  const r = buildDefaultLibraryItems(
    [{ id: "w1", name: "普通自动化", hasTrigger: true }],
    [{ workflowId: "w1", nodeId: "t", title: "触发器", kind: "event" }],
  );
  check("只有 event 自动化 → 转录建、导入缺", r.items.some((i) => i.id === "seed-transcribe")
    && !r.items.some((i) => i.id === "seed-lit-import") && r.notes.some((n) => n.kind === "missingImport"), r);
}

/* ── 文献导入:载荷 → 脚本 → importFiles 这道缝(2026-09-28)──
 *
 * 这道缝塌过一次:运行前输入在载荷里是**拍平**的 `input.files`,而脚本按嵌套的
 * `input` 字典去取 —— 取到的永远是空,**而且不报错**(表现为"选了 PDF 却一个都没进库")。
 * 类型对不出这种错,所以这里从两头钉死:载荷的键名 + 那段 Python 真跑一遍。
 */
{
  const facts = payloadFactsOf({
    kind: "event",
    event: "library.item.imported",
    collectionId: "col_1",
    input: { files: ["C:/lib/a,b.pdf", "C:/lib/c.pdf"], doi: "10.1000/xyz" },
  });
  check("运行前输入在事实里是拍平的 input.<键>", facts["input.doi"] === "10.1000/xyz"
    && Array.isArray(facts["input.files"]) && facts["input.files"].length === 2, facts);
  check("落点分类进事实", facts.collectionId === "col_1", facts);
  check("只定位的载荷不带 items", facts.items === undefined, facts);

  // 真跑那段脚本。没装 python 就跳过(CI 的 Linux 镜像有,开发机不一定)。
  const py = ["python3", "python"].find((bin) => {
    try { return spawnSync(bin, ["-c", "pass"], { encoding: "utf8" }).status === 0; } catch { return false; }
  });
  if (py === undefined) {
    console.log("custom-ui-smoke: 没有 python,跳过 LIT_IMPORT_PY 实跑");
  } else {
    const run = (payload: unknown): { summary?: string; outputs?: Record<string, unknown> } => {
      const res = spawnSync(py, ["-c", LIT_IMPORT_PY], { input: `${JSON.stringify(payload)}\n`, encoding: "utf8" });
      const line = res.stdout.split("\n").find((l) => l.startsWith("@@mcode:result "));
      return line === undefined ? {} : JSON.parse(line.slice("@@mcode:result ".length));
    };
    const ok = run({ trigger: facts });
    const req = ok.outputs?.["importFiles"] as { paths?: string[]; collectionIds?: string[] } | null | undefined;
    check("选了文件 → 脚本报 importFiles.paths", Array.isArray(req?.paths) && req?.paths.length === 2, ok);
    check("路径里的逗号不被切开", req?.paths?.[0] === "C:/lib/a,b.pdf", req);
    check("落点分类带进 collectionIds", req?.collectionIds?.[0] === "col_1", req);
    const none = run({ trigger: payloadFactsOf({ kind: "event", event: "library.item.imported", input: { doi: "10.1" } }) });
    check("只填 DOI → 不报 importFiles,也不失败", none.outputs?.["importFiles"] === null, none);
  }
}

/* ── 汇总 ── */

console.log(`custom-ui-smoke: ${passed}/${checks} passed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
