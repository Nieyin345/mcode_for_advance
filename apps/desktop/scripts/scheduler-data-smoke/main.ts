/**
 * 调度器冒烟 · **数据**:上下文继承(节点选了几类就去要那几类)/ 模版变量 `{{...}}` /
 * 产出约束(界面上那两栏真的变成了"跑完会检查的东西")。夹具见 `../scheduler-smoke/harness.js`。
 *
 * Run: scripts/scheduler-data-smoke/run.sh
 */
import { attachmentPathsIn, contextKindOfPath, contextRefOfPath, inheritContextLines, type ContextLine, type ContextLookup } from "@main/orchestration/contextInherit.js";
import { runWorkflow } from "@main/orchestration/scheduler.js";
import { composeNodePrompt } from "@main/orchestration/schedulerPrompt.js";
import { dirname, join, resolve } from "node:path";
import { renderTemplate, type NodeTemplateScope, type NodeTemplateNode } from "@contracts/nodeTemplate";
import { checkOutput, describeOutputVars, outputExampleOf, outputVarsFor, referenceableOutputsOf, validateOutputRules } from "@contracts/outputConstraint";
import { NodeTypeManifest } from "@contracts/nodeType";
import { check, eq, makePorts, node, branchNode, edge, docOf, outcomeOf, controller, sleep, AGENT, SHELL, LOOSE, BRANCH, CONVERSATION, RETRY_AGENT, MANIFESTS, PLAN, summary, type Harness, type Call } from "../scheduler-smoke/harness.js";

/* ────────────────────── 上下文继承与引擎 ────────────────────── */

console.log("\n上下文继承(节点选了几类,就去要那几类)");

{
  // 假端口返回的是**真的那种形状**(事实 + 由调度器排版,见 `contextInherit.ts` 的
  // `inheritContextLines`)—— 返回拼好的字符串的话,下面那几条断言测的就不是用户
  // 真正看到的那一段了(而"资料属于哪个大类、拿来干什么"正是用户提的那两条)。
  //
  // kind 退役后节点勾的是**大类**(`docs`),抬头显示的就是那个 id —— 见 `KIND_LABEL`
  // 那条回落:资料侧的类目名是用户自己起的、库里才有,纯件这一层认不出来。
  //
  // 两条**同一个大类**的行(整大类 + 其中一篇):这正是真实情形 —— 用户可能整个
  // 「文档」大类都挂上,又单独挂了里面的一篇。
  const lineOf = (): ContextLine[] => [
    { kind: "docs", level: "all", path: "/lib/group-docs.md", purpose: "material" },
    { kind: "docs", level: "item", path: "/lib/li_某条目.md", purpose: "material" },
  ];
  const h = makePorts({ contextLines: (kinds) => (kinds.length === 0 ? [] : lineOf()) });
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["docs", "docs"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  eq("按节点的参数问了一次", h.contextAsked.length, 1);
  eq("同一个大类写两遍只问一次", h.contextAsked[0]?.join(","), "docs");
  const prompt = h.calls[0]?.prompt ?? "";
  check("★ 整大类那条进了提示词", prompt.includes("- 【docs·整库】@/lib/group-docs.md"), prompt);
  check("★ 单篇那条也在", prompt.includes("- 【docs·单篇】@/lib/li_某条目.md"), prompt);
  // **两条都是"查资料"那一组**:资料库里的东西一律拿来读内容 —— 用途是**库**决定的
  // (挂不挂在「模版」大类下),不是类目名决定的(见 `purposeOfKinds`)。
  check("两条同属查资料那一组", prompt.includes("**当资料查**"), prompt);
  check("没有模版就不摆「当格式仿」", !prompt.includes("当格式仿"), prompt);
  // 单独一段而不是散在指令里 —— "这一步能读什么"是个可以一眼看完的集合。
  check("单独成一段", prompt.includes("## 这一步可以读的资料"), prompt);
  // **抬头得有出处**:方括号里那两个词(类目 + 层级)是代码算的,不解释一句的话
  // 模型只看见两个没来由的方括号词。见 `composeNodePrompt` 里那段。
  check("说明了方括号是什么", prompt.includes("方括号内是它的类别"), prompt);
  check("指令还是最后一段(资料在它前面)", prompt.trimEnd().endsWith("写论文"), prompt);
}

{
  // 模版那条也走一遍 —— 它和资料那条**必须落在不同的组**里,而分组判据现在是
  // "挂不挂在「模版」大类下"(独立模版库退役前是"路径属于哪个库")。
  const h = makePorts({
    contextLines: () => [
      { kind: "docs", level: "all", path: "/lib/group-docs.md", purpose: "material" },
      { kind: "templates", level: "collection", path: "/lib/lc_模版集.md", purpose: "format" },
    ],
  });
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["docs", "templates"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const prompt = h.calls[0]?.prompt ?? "";
  check("★ 资料那条进了「当资料查」", prompt.includes("**当资料查**"), prompt);
  check("★ 模版那条进了「当格式仿」", prompt.includes("**当格式仿**"), prompt);
  check("模版那条的抬头带着「模版」二字", prompt.includes("- 【模版·分类】@/lib/lc_模版集.md"), prompt);
  check("查资料那组在前", prompt.indexOf("当资料查") < prompt.indexOf("当格式仿"), prompt);
}

{
  // **没选类目时也要问一次**(问的是空数组)而且**不产生那一段** —— 一个空标题比没有
  // 更糟:模型会以为"这一步没有资料",而实际情况是"这一步没要求资料"。
  // 假端口按**契约**返回(没要类目就没有行);它不按契约来的话,下面这条断言的就不是
  // 调度器的行为了。
  const h = makePorts({
    contextLines: (kinds) =>
      kinds.length === 0
        ? []
        : [{ kind: "docs", level: "all", path: "/lib/group-docs.md", purpose: "material" }],
  });
  const doc = docOf([node("A")], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没选类目 → 问的是空数组", h.contextAsked[0]?.length, 0);
  check("没选类目 → 提示词里没有那一段", !(h.calls[0]?.prompt ?? "").includes("可以读的资料"));
}

{
  // 选了、但主对话没挂那一类 → 段不出现。这一条是"继承"与"查找"的分界:节点说了
  // 要资料,而这次对话没有,那这一步就是没有 —— 不会替用户去库里翻。
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["docs"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("问过了", h.contextAsked[0]?.join(","), "docs");
  check("主对话没挂 → 提示词里没有那一段", !(h.calls[0]?.prompt ?? "").includes("可以读的资料"));
}

{
  // 参数里存了**清单上没有的取值**(手改过的图 / AI 写歪了):清单声明了候选,所以
  // 这一类在这一层就被拦下 —— **节点明确失败并说清楚**,而不是把那个值静静丢掉。
  //
  // 这是刻意的:丢掉的话现象是"这一步没有它要的资料",而原因(名字写错了)在任何地方
  // 都看不到。这个仓库一贯的取舍是**错的配置要发出声音**(同 `validateDag` /
  // `instructionOf`)。
  const h = makePorts({
    contextLines: (kinds) =>
      kinds.map((k) => ({
        kind: k,
        level: "all" as const,
        path: `/lib/${k}.md`,
        purpose: "material" as const,
      })),
  });
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["latex", "根本不存在的大类"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没被派发", h.contextAsked.length, 0);
  const outcome = outcomeOf(h, "A");
  eq("节点失败", outcome?.status, "failed");
  check("说的是取值不在选项里", outcome?.error?.includes("不在选项里") === true, outcome?.error);
}

console.log("\n引擎解算(约定键 → 输入,执行器不再自己翻 params)");

{
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "x", { provider: "codex" })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("引擎解到了输入里", h.calls[0]?.providerId, "codex");
}

{
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "x", { provider: "   " })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("只有空白 = 跟着对话走", h.calls[0]?.providerId, undefined);
}

console.log("\ncomposeNodePrompt(上下文那一段)");

{
  const withContext = composeNodePrompt({
    userPrompt: "用户的请求",
    upstream: "",
    instruction: "写论文",
    nodeId: "A",
    plan: PLAN,
    // 两条不同**用途**的:`docs` 是资料(拿来查的),`templates` 是模版(拿来仿的)——
    // 那一段按这个分组,而判据是 `purpose` 这个**事实**(由 `contextRefOfPath` 在认出
    // 路径的那一刻按大类算好)。
    context: [
      { kind: "docs", level: "item", path: "/lib/li_某篇.md", purpose: "material" },
      { kind: "templates", level: "collection", path: "/lib/lc_模版集.md", purpose: "format" },
    ],
  });
  check(
    "两条都在,而且带着「是什么」",
    withContext.includes("- 【docs·单篇】@/lib/li_某篇.md") &&
      // **模版那条抬头是「模版」** —— 出厂大类的中文名(见 `KIND_LABEL`),跟用户在
      // 下拉里勾选时看到的词逐字一致。
      withContext.includes("- 【模版·分类】@/lib/lc_模版集.md"),
    withContext,
  );
  check("说的是「主对话挂了这些」", withContext.includes("以下是主对话中挂载的资料"), withContext);
  // **两类的用法不同,所以分开摆** —— 用户的原话:「模版的话是仿写,借鉴格式这种;
  // 文献、教材、笔记这些是用来查询资料的」。平铺成一个列表的话,模型多半会把模版
  // 当资料读(于是抄了里面的内容),或者把文献当成格式样板。
  check("资料那组说清了是拿来查的", withContext.includes("**当资料查**"), withContext);
  check("模版那组说清了是拿来仿的", withContext.includes("**当格式仿**"), withContext);
  check(
    "模版那组明确说了别搬内容",
    withContext.includes("不要搬用其中的原话"),
    withContext,
  );
  // 分组顺序固定:查资料的在前。跨组不再等于主提示词里的先后 —— 这是分组换来清晰度
  // 的代价(只影响"先看到哪一条")。
  check(
    "查资料那组在前",
    withContext.indexOf("当资料查") < withContext.indexOf("当格式仿"),
    withContext,
  );

  const noContext = composeNodePrompt({
    userPrompt: "用户的请求",
    upstream: "",
    instruction: "写论文",
    nodeId: "A",
    plan: PLAN,
    context: [],
  });
  check("空数组 = 没有那一段", !noContext.includes("可以读的资料"), noContext);
}

console.log("\n附件路径 → 类目(认不出来就什么都不给)");

// 假的库根 + 两次"按 id 查类目"。**用 `resolve` 而不是写死 `/fake/...`**:Windows 上
// 盘符会被拼进来,而两边都走同一个 `resolve`,比较才成立(被测代码也是这么做的)。
const LIB_ROOT = resolve("/fake/library");
/**
 * 一张**假库**:两个大类(`docs` / `templates`)、几个分类、几条条目。
 *
 * `undefined` 与 `[]` 是**两个不同的答案**,这张表要把它们都造出来:
 *  - `undefined` = 库里没这个东西 → "这不是一条分类/条目清单",继续往下试;
 *  - `[]` = 有,但它还没挂大类 → 它**是**清单,只是选任何大类都拿不到。
 * 混成一个的话,`resolveRef` 那条"不是分类就继续试条目"的分支就验不到了。
 */
const GROUPS_OF_COLLECTION: Record<string, string[] | undefined> = {
  "lc_文献": ["docs"],
  "lc_笔记": ["docs"],
  "lc_模版集": ["templates"],
  "lc_没挂大类": [],
  // ⚠️ 一条**同时挂在两个大类下**的分类 —— 用户把同一批东西收进两个大类是允许的。
  "lc_两边都要": ["docs", "templates"],
};
const GROUPS_OF_ITEM: Record<string, string[] | undefined> = {
  "li_论文": ["docs"],
  "li_模版图": ["templates"],
  "li_两边都要": ["docs", "templates"],
  "li_没归类": [],
};
const LOOKUP: ContextLookup = {
  libraryRoot: LIB_ROOT,
  // 查不到返回 `undefined`(不是 `[]`),这是"库里没有它"的信号。
  groupsOfCollection: (id) => GROUPS_OF_COLLECTION[id],
  groupsOfItem: (id) => GROUPS_OF_ITEM[id],
};
const libManifest = (name: string): string => join(LIB_ROOT, "collections", name);

const kindOf = (path: string): string | null => contextKindOfPath(path, LOOKUP);

// 大类清单:`group-<大类 id>.md` —— **由文件名直接读出来**,不用查库。
eq("整大类清单 group-docs.md → docs", kindOf(libManifest("group-docs.md")), "docs");
// ⚠️ `kind-paper.md` 是**老形状**,kind 退役后没有了 —— 它既不是 `group-` 开头、查库也
// 查不到,于是认不出来。老库里存着的那些挂载记录就这样落到这里(这一步少一份资料,
// 而不是拿到一份错类目的)。这一条钉住"老形状没有被悄悄当成大类"。
eq("★ 老形状 kind-paper.md 认不出来(不是大类)", kindOf(libManifest("kind-paper.md")), null);
// 分类 / 条目 **靠查库**。
eq("分类 id → 查出来是大类 docs", kindOf(libManifest("lc_文献.md")), "docs");
eq("条目 id → 查出来是它所属分类的大类", kindOf(libManifest("li_论文.md")), "docs");
// ⚠️ **同时挂在两个大类下的**:不指定时取第一个,指定了就取交集里那个 —— 显示给模型的
// 类目正是**这一步要的那个**,不是"它恰好也属于"的另一个。
eq("两边都挂的分类 → 不指定时取第一个", kindOf(libManifest("lc_两边都要.md")), "docs");
eq(
  "★ 两边都挂的分类 → 指定哪个就是哪个",
  contextRefOfPath(libManifest("lc_两边都要.md"), LOOKUP, ["templates"])?.kind,
  "templates",
);
// 挂着、但**没归任何大类** → 认得出层级,但 `kinds` 是空的 → 谁都拿不到。
eq("★ 没挂大类的分类 → 认不出来(它不属于任何一个大类)", kindOf(libManifest("lc_没挂大类.md")), null);
eq("★ 没归类的条目 → 同样认不出来", kindOf(libManifest("li_没归类.md")), null);
eq("库里没有的 id → 认不出来", kindOf(libManifest("不认识.md")), null);
// 模版就是「模版」大类下的普通分类 / 条目(独立模版库退役,2026-09-27)。
eq("模版分类 → 查出来是大类 templates", kindOf(libManifest("lc_模版集.md")), "templates");
eq("模版条目 → 查出来是大类 templates", kindOf(libManifest("li_模版图.md")), "templates");

// ⚠️ **单篇清单的**真实**文件名带 `item-` 前缀。** 主进程写它的时候用的是
// `item-${item.id}.md`(见 `library/manifest.ts` 的 `writeItemManifest`),而挂在对话上的
// `@路径` 行正是那个 `res.path`(见 `manifest.pushAttach` → 渲染端 `contentTag` 的
// `content: \`@${manifestPath}\``)。所以解析这一端必须认这个前缀 —— 上面那些裸
// `li_论文.md` 是**文档表格里的形状**,不是库里真正的文件名。
// 认不出来的后果:用户挂的**单篇**在「资料」这一类里被静默丢掉(少给了模型东西而一个字
// 都不说),而分类 / 整库那两种挂法照常 —— 只有"点开分类挑了其中一篇"那条路断。
eq("★ 单篇清单的真文件名(item-<条目 id>.md)认得出来", kindOf(libManifest("item-li_论文.md")), "docs");
eq("模版单篇的真文件名也认得出来", kindOf(libManifest("item-li_模版图.md")), "templates");

console.log("\ncontextRefOfPath(类目 + 层级 + 用途)");
// **层级也是算出来的**:一个 id 是"分类"还是"单篇",取决于它在哪张表里查到
// (`groupsOfCollection` / `groupsOfItem` 是两次不同的查询)。提示词里那个 `·单篇·`
// 就是它 —— 少了它,模型拿到一串不透明的 id(条目文件名甚至是 sha256),只能先读一遍
// 才知道那是一整个大类还是单独一篇。
const refOf = (path: string): string => {
  const r = contextRefOfPath(path, LOOKUP);
  return r === null ? "null" : `${r.kind}/${r.level}/${r.purpose}`;
};
eq("整个大类", refOf(libManifest("group-docs.md")), "docs/all/material");
eq("分类 id", refOf(libManifest("lc_文献.md")), "docs/collection/material");
eq("条目 id", refOf(libManifest("li_论文.md")), "docs/item/material");
// 真文件名的单篇:层级必须是「单篇」而不是「分类」(前缀剥掉之后查到的是条目那张表)。
eq("★ 单篇真文件名 → 层级是「单篇」", refOf(libManifest("item-li_论文.md")), "docs/item/material");
eq("模版分类", refOf(libManifest("lc_模版集.md")), "templates/collection/format");
eq("模版条目", refOf(libManifest("li_模版图.md")), "templates/item/format");
eq("认不出来的照样是 null", refOf(join(LIB_ROOT, "papers", "x.pdf")), "null");

console.log("\n用途(material / format)由**它挂在哪个大类下**决定");
// 这一个判断决定了资料那一段**怎么分组**(见 `composeNodePrompt` 的
// `renderContextLines`)。判据是**挂不挂在出厂的「模版」大类下**(`TEMPLATES_LIBRARY_GROUP_ID`)
// —— 不是一条要另外维护的规则。⚠️ **不能按类目名判**:kind 退役后类目名是用户自己起的,
// 他完全可以把一个大类叫 `latex`,按名字判会把它摆进"当格式仿"那一栏。
eq(
  "库根下的大类清单 → 查资料",
  contextRefOfPath(libManifest("group-docs.md"), LOOKUP)?.purpose,
  "material",
);
eq(
  "库根下的一条条目 → 查资料",
  contextRefOfPath(libManifest("li_论文.md"), LOOKUP)?.purpose,
  "material",
);
eq("「模版」大类整库清单 → 仿格式", contextRefOfPath(libManifest("group-templates.md"), LOOKUP)?.purpose, "format");
eq("模版分类 → 仿格式", contextRefOfPath(libManifest("lc_模版集.md"), LOOKUP)?.purpose, "format");
eq("模版条目 → 仿格式", contextRefOfPath(libManifest("li_模版图.md"), LOOKUP)?.purpose, "format");
// ★ 同时挂在 docs 与 templates 下的:它**也**是模版,按仿格式摆(宁可多摆一组)。
eq("★ 两边都挂的 → 仿格式", contextRefOfPath(libManifest("li_两边都要.md"), LOOKUP)?.purpose, "format");
// ★ 名字叫 `latex` 的**大类**仍然是资料 —— 判的是挂在哪个大类,不是它叫什么。
eq(
  "★ 名字叫 latex 的大类仍然是资料(判库不判名)",
  contextRefOfPath(libManifest("group-latex.md"), LOOKUP)?.purpose,
  "material",
);
// 不是清单的附件(一篇 PDF 的正文、一张图)不该被当成上下文类目。
eq("库根下的普通文件 → 认不出来", kindOf(join(LIB_ROOT, "papers", "ab", "cd", "abc.pdf")), null);
eq("库之外的文件 → 认不出来", kindOf(join(dirname(LIB_ROOT), "别处", "x.md")), null);

console.log("\nattachmentPathsIn(提示词里那几行 @)");
// 返回的是**路径本身**(不带 `@`)—— `@` 是拼进提示词时才加回去的(见
// `inheritContextLines`),所以这里比的是裸路径。
eq(
  "只取 @ 开头的行",
  attachmentPathsIn("帮我看一下\n@" + libManifest("group-docs.md") + "\n后面这句不算").join("|"),
  libManifest("group-docs.md"),
);
// **路径里有空格**(Windows 上 `C:\Users\张 三\...` 很常见)—— 按行取才不会在第一个
// 空格处断掉,而按正则扫全文一定会断。
eq(
  "路径里的空格不会把路径截断",
  attachmentPathsIn("@C:/Users/张 三/library/collections/group-docs.md").length,
  1,
);
eq("没有附件就是空", attachmentPathsIn("就是一段普通的话").length, 0);
eq("只有一个 @ 的空行不算", attachmentPathsIn("@\n@   ").length, 0);

console.log("\ninheritContextLines(挑出节点要的那几类)");
const PROMPT = [
  "帮我写一篇",
  "",
  `@${libManifest("group-docs.md")}`,
  `@${libManifest("li_论文.md")}`,
  `@${libManifest("lc_模版集.md")}`,
  `@${libManifest("group-docs.md")}`, // 挂了两次 —— 只该给一行
].join("\n");

// 交回来的是**事实**(类目 / 层级 / 用途 / 路径),排版是提示词那一层的事 —— 所以这里
// 比的是事实本身,而不是某一种排版结果(那种断言会在改一个字的时候红,却看不出对错)。
const lineKey = (l: ContextLine): string => `${l.kind}/${l.level}@${l.path}`;
eq(
  "只要 docs → docs 那两条",
  inheritContextLines(PROMPT, ["docs"], LOOKUP).map(lineKey).join("|"),
  `docs/all@${libManifest("group-docs.md")}|docs/item@${libManifest("li_论文.md")}`,
);
eq(
  "要 docs 和模版 → 三条,顺序跟着主提示词",
  inheritContextLines(PROMPT, ["docs", "templates"], LOOKUP).map(lineKey).join("|"),
  `docs/all@${libManifest("group-docs.md")}|docs/item@${libManifest("li_论文.md")}|templates/collection@${libManifest("lc_模版集.md")}`,
);
eq("一个类目都没要 → 一行都不给", inheritContextLines(PROMPT, [], LOOKUP).length, 0);
// 主对话没挂那一类 —— **这一步就是没有**,不会替用户去库里翻。
eq("要了但主对话没挂 → 空", inheritContextLines(PROMPT, ["nope"], LOOKUP).length, 0);
// 认不出来的路径不该混进来。
eq(
  "认不出来的 @ 行被丢掉",
  inheritContextLines(`@${join(LIB_ROOT, "papers", "x.pdf")}\n@随便什么`, ["docs"], LOOKUP).length,
  0,
);
// ★ **同时挂在两个大类下的条目:勾了哪一个都给得到它。** 这一条是 `kinds` 做成数组的
// 全部理由 —— 做成单个字段的话它只能属于一个,而挑哪个都没有依据。
eq(
  "★ 挂在两个大类下的条目 → 勾其中任一个都拿得到",
  inheritContextLines(`@${libManifest("li_两边都要.md")}`, ["templates"], LOOKUP)
    .map(lineKey)
    .join("|"),
  `templates/item@${libManifest("li_两边都要.md")}`,
);

/* ────────────────────── 变量({{...}}) ────────────────────── */

console.log("\nrenderTemplate(纯函数)");

const TPL_SCOPE: NodeTemplateScope = {
  user: "把这件事办了",
  // 名字集合里 id 和标题**都在**(调用方负责两个都放进去,`upstreamNames` 就是这么做的)。
  upstream: new Set(["A", "检索", "B", "整理"]),
  nodes: [
    {
      id: "A",
      title: "检索",
      outcome: { status: "success", summary: "找到三篇", outputs: { 年份: "2024", stats: { count: 3 } }, artifacts: [{ kind: "file", uri: "D:/work/report.pdf", name: "report.pdf", mimeType: "application/pdf" }] },
      params: { target: "量子", tags: ["a", "b"], n: 3 },
    },
    {
      id: "B",
      title: "整理",
      outcome: { status: "failed", summary: "", error: "超时了" },
      params: {},
    },
    // 图上有、但**不是上游** —— 用来验报错分得开。
    { id: "C", title: "后面那步", params: {} },
  ],
};

const render = (text: string): string => {
  const res = renderTemplate(text, TPL_SCOPE);
  return res.ok ? res.text : `ERR:${res.error}`;
};

eq("{{user}} → 用户这次发的请求", render("按这个做:{{user}}"), "按这个做:把这件事办了");
eq("按 id 引用产出", render("{{A.output}}"), "找到三篇");
eq("按**标题**引用也认", render("{{检索.output}}"), "找到三篇");
eq("不写字段 = 产出", render("{{A}}"), "找到三篇");
eq("status", render("{{B.status}}"), "failed");
eq("error", render("{{B.error}}"), "超时了");
eq("title", render("{{A.title}}"), "检索");
eq("params 取字符串", render("{{A.params.target}}"), "量子");
// 多选那种参数存的是字符串数组 —— `["a","b"]` 直接进提示词很难看,所以用顿号连起来。
eq("params 取数组 → 顿号连起来", render("{{A.params.tags}}"), "a、b");
eq("params 取数字", render("{{A.params.n}}"), "3");
eq("outputs 取嵌套对象", render("{{A.outputs.stats.count}}"), "3");
eq("artifacts 取 URI", render("{{A.artifacts[0].uri}}"), "D:/work/report.pdf");
eq("artifacts 取名称", render("{{A.artifacts[0].name}}"), "report.pdf");
eq("取不存在的参数 = 空串", render("[{{A.params.没有}}]"), "[]");
// 一句话里多处引用。
eq("一句里多处", render("{{检索.output}},目标 {{A.params.target}}"), "找到三篇,目标 量子");

console.log("\nrenderTemplate(写错了要说清楚)");
const err = (text: string): string => {
  const res = renderTemplate(text, TPL_SCOPE);
  return res.ok ? `OK:${res.text}` : res.error;
};

// **图上有、但不是这一步的上游** 和 **图上根本没有** —— 用户要做的事完全不一样
// (改依赖 vs 改名字),所以报错要分得开。
check("引用旁支 → 说清「不是这一步的上游」", err("{{C.output}}").includes("不是这一步的上游"), err("{{C.output}}"));
check("引用不存在的节点 → 说清「图上没有」", err("{{没有这个.output}}").includes("图上没有"), err("{{没有这个.output}}"));
// 引用一个那一步**没定过**的名字 → 把实际有的列出来,用户凭这个就能改对。
check("引用没定过的变量 → 把有的列出来", err("{{A.期刊}}").includes("年份"), err("{{A.期刊}}"));
// 引用一个**根本没填过产出变量**的节点 → 那是另一回事,说清怎么才能有。
check(
  "引用没填过变量的节点 → 说清怎么才有",
  err("{{B.年份}}").includes("还没有产出变量"),
  err("{{B.年份}}"),
);
check("空引用", err("{{}}").includes("空引用"), err("{{}}"));
check("params 后面没写名字", err("{{A.params.}}").includes("参数名"), err("{{A.params.}}"));
// 报错里要带**是哪个参数**写错了 —— 一个节点有好几个文本参数,不说是哪个就得自己找。
check("报错里带上了出错的参数名", err("{{C.output}}").includes("指令"), err("{{C.output}}"));

// **清单里声明的 `summary` 必须真的取得到**(2026-09-19)。
//
// 三个跑模型的类型(主代理 / 子 agent / 对话节点)在清单里都声明了
// `outputs: [{ key: "summary", label: "结果文本" }]`。存盘校验认清单声明的键
// (`workflowValidation.declaredOutputsOf`),所以 `{{那步.summary}}` **存得下去**;
// 而解算器只在 `outcome.outputs` 里找,`summary` 却在 `outcome` 的**外层** ——
// 于是同一个写法一边放行、一边报"产出里没有 summary 这个变量"。
//
// 这一条把它钉死:清单声明过的东西,解算器必须给得出来。
eq("清单声明的 summary 取得到", render("{{A.summary}}"), "找到三篇");
eq("按标题引用也一样", render("{{检索.summary}}"), "找到三篇");
// 用户**自己**声明过一个叫 `summary` 的变量时以他的为准 —— 那是今天就能用的写法,
// 不能因为补了这一条把它挤掉。判据:先看 `outcome.outputs`,没有才回落到原文。
const ownSummary: NodeTemplateScope = {
  ...TPL_SCOPE,
  nodes: [
    {
      ...(TPL_SCOPE.nodes[0] as NodeTemplateNode),
      outcome: { status: "success", summary: "原文", outputs: { summary: "用户定的" } },
    },
    ...TPL_SCOPE.nodes.slice(1),
  ],
};
const ownRes = renderTemplate("{{A.summary}}", ownSummary);
eq("用户真声明了 summary 就听用户的", ownRes.ok ? ownRes.text : "ERR", "用户定的");

const ambiguous: NodeTemplateScope = {
  user: "",
  upstream: new Set(["同名的"]),
  nodes: [
    { id: "n1", title: "同名的", outcome: { status: "success", summary: "一" }, params: {} },
    { id: "n2", title: "同名的", outcome: { status: "success", summary: "二" }, params: {} },
  ],
};
const amb = renderTemplate("{{同名的.output}}", ambiguous);
check("标题重名 → 拒", !amb.ok && amb.error.includes("同时是多个节点的标题"), amb);

console.log("\n转义(指令里真要写 {{)");
eq("\\{{ 是字面的 {{", render("用 \\{{变量}} 表示占位"), "用 {{变量}} 表示占位");
eq("转义和真引用可以混着用", render("{{A.output}} 要写成 \\{{output}}"), "找到三篇 要写成 {{output}}");

console.log("\n触发器变量({{trigger.*}} —— 另一个名字空间)");
{
  // 调度器把这次触发的载荷放进 `scope.trigger`(见 `scheduler.ts` 里 scope 的构造),
  // 而**解算它的是 `renderTemplate` 的同一遍遍历**(2026-09-20)。
  //
  // 从前这里是**两个展开器接力**:调度器先跑 `expandTriggerVars`,认不出 `{{检索.年份}}`
  // 所以把整串**原样交出去**;再跑 `renderTemplate`,它把 `{{trigger.at}}` 当节点名报
  // 「引用不到」。两个展开器各自都对,拼在一起就是"一个用不了的写法" —— 而用户写
  // `"上游是 {{检索.年份}},这次是 {{trigger.at}} 触发的"` 再自然不过。
  const trigScope: NodeTemplateScope = {
    ...TPL_SCOPE,
    trigger: { kind: "schedule", at: "2026-09-20 08:00", files: ["a.md", "b.md"], n: 3 },
  };
  const rt = (text: string): string => {
    const res = renderTemplate(text, trigScope);
    return res.ok ? res.text : `ERR:${res.error}`;
  };

  eq("{{trigger.键}} 取载荷", rt("{{trigger.at}}"), "2026-09-20 08:00");
  eq("数字也取得到", rt("{{trigger.n}}"), "3");
  eq("字符串数组用顿号连", rt("{{trigger.files}}"), "a.md、b.md");
  // **这一条就是那次改动的全部理由**:两种名字空间在同一句话里,一遍解完。
  eq(
    "同一句话里两种名字空间一起解",
    rt("上游是 {{检索.年份}},这次是 {{trigger.at}} 触发的"),
    "上游是 2024,这次是 2026-09-20 08:00 触发的",
  );
  eq("和 params 混着写也行", rt("{{A.params.target}} / {{trigger.kind}}"), "量子 / schedule");

  // **没有载荷**(手动发消息跑的工作流)要说清"这次不是触发器起的" —— 那句话把人
  // 支去配触发器;报成节点引用("图上没有 trigger 这个节点")只会让人去改图,而图没问题。
  const noTrig = renderTemplate("{{trigger.at}}", TPL_SCOPE);
  check(
    "没有载荷 → 说「不是触发器起的」",
    !noTrig.ok && noTrig.error.includes("不是触发器起的"),
    noTrig.ok ? noTrig : noTrig.error,
  );
  check(
    "没有载荷时报的**不是**节点引用那套话",
    !noTrig.ok && !noTrig.error.includes("图上没有"),
    noTrig.ok ? noTrig : noTrig.error,
  );

  // 载荷在、键拼错了 → 把**实际有的**列出来(与 `expandTriggerVars` 同一套话术)。
  const badKey = renderTemplate("{{trigger.不存在}}", trigScope);
  check(
    "键拼错 → 列出载荷里实际有的",
    !badKey.ok && badKey.error.includes("载荷里没有这一项") && badKey.error.includes("{{trigger.at}}"),
    badKey.ok ? badKey : badKey.error,
  );
}

console.log("\n变量在调度器里真的生效");
{
  // A → B。B 的指令里引用了 A 的产出,而 B 的提示词里应该出现**解算后**的那句话。
  const h = makePorts();
  const doc = docOf(
    [
      node("A", AGENT.id, "去检索"),
      node("B", AGENT.id, "基于 {{A.output}} 写一段"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("B 的提示词里是 A 的**结果**,不是 {{A.output}}", bPrompt.includes("A 的结果"), bPrompt);
  check("占位符本身不在了", !bPrompt.includes("{{A.output}}"), bPrompt);
}

{
  // 引用了**上游的参数**:B 指令里写 {{A.params.target}}。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "去检索", { target: "量子纠缠" }), node("B", AGENT.id, "目标 {{A.params.target}}")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("上游的参数被引用了进来", bPrompt.includes("量子纠缠"), bPrompt);
}

{
  // 引用一个**不是上游**的节点(node 在同列、甚至可能先跑完)—— 这一步**明确失败**,
  // 而且失败要往下游传(下游不派发)。这是"只认上游"那条规矩在运行时的样子。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "x"), node("B", AGENT.id, "引用 {{A.output}}"), node("C", AGENT.id, "y")],
    [edge("B", "C")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const outcomeB = outcomeOf(h, "B");
  eq("B 失败", outcomeB?.status, "failed");
  check("说的是「不是这一步的上游」", outcomeB?.error?.includes("不是这一步的上游") === true, outcomeB?.error);
  // B 根本没被派发出去 —— 参数解算在**跑之前**,所以它连会话都没建。
  check("B 没有被真的执行", !h.executed().includes("B"), h.executed());
  eq("下游 C 被跳过", outcomeOf(h, "C")?.status, "skipped");
  // 同列无关的 A 照常跑完 —— 一个节点配错了不该让整张图停摆。
  eq("无关的 A 照常跑", h.executed().includes("A"), true);
}

/* ────────────────────── 产出变量(硬约束) ────────────────────── */

// 界面上用户填的是「变量名 + 示例」两栏,底下是 JSON —— **这一整段测的就是那两栏真的
// 变成了"跑完会检查的东西"**。见 `@contracts/outputConstraint`。

console.log("\n产出名单:给人看的 vs 要模型交的(2026-09-19)");

// **一个节点的"产出变量"有四个消费方,而它们要的**不是同一份名单**。这一段把那两
// 份名单的形状钉死 —— 混用哪一边都是安静地出错:
//
//  - **要模型交的**(`outputVarsFor`)= 用户定的 + 分支的「出路」。清单声明的
//    `outputs` **不在内**:那几样是运行时填的(`commandRunner` 往 `outcome.outputs`
//    里塞 `exitCode`),并进来会逼每个 agent 节点交一个 `{"summary": ...}`。
//  - **下游引用得到的**(`referenceableOutputsOf`)= 上面那些 **+ 清单声明的**。
//
// 菜单列的是后者、卡片和提示词用的是前者 —— 各自用错一边的表现都很难看:菜单少列
// 用户就只能靠猜,反过来发提示词会凭空多要一样模型交不出来的东西。
{
  const manifest: NodeTypeManifest = {
    id: "demo.cmd",
    manifestVersion: 1,
    name: "命令",
    runner: { kind: "command", entry: "x.py" },
    capability: "exec",
    params: [
      { key: "instruction", kind: "longtext", label: "指令" },
      { key: "outputVars", kind: "variables", label: "产出变量" },
    ],
    outputs: [{ key: "exitCode", label: "Exit code" }],
  };
  const params = { outputVars: [{ name: "年份", example: "2024" }] };

  eq(
    "要模型交的:只有用户定的那几样(清单声明的**不进来**)",
    outputVarsFor(manifest, params).map((v) => v.name).join(","),
    "年份",
  );
  eq(
    "下游引用得到的:用户定的 + 清单声明的",
    referenceableOutputsOf(manifest, params).map((v) => v.name).join(","),
    "年份,exitCode",
  );
  eq(
    "两份名单都不含「出路」(决定权在用户时它由点选产生)",
    [outputVarsFor, referenceableOutputsOf]
      .map((f) => f(manifest, { ...params, decider: "user" }, ["甲"]).some((v) => v.name === "出路"))
      .join(","),
    "false,false",
  );
  // **模型选的分支**:两份都要有「出路」,而且例子得是**真有**的那条出路 —— 它是
  // 提示词里给模型的样板("照这个样子填"),编一个不存在的会让模型照着编。
  const branch: NodeTypeManifest = {
    id: "mcode.branch",
    manifestVersion: 1,
    name: "分支",
    runner: { kind: "branch" },
    capability: "read",
    params: [],
    outputs: [{ key: "ignored", label: "x" }],
  };
  const decideParams = { decider: "model" };
  eq(
    "模型选的分支:两份都有「出路」",
    [outputVarsFor, referenceableOutputsOf]
      .map((f) => f(branch, decideParams, ["深入", "收尾"]).map((v) => v.name).join(","))
      .join(" | "),
    "出路 | ignored,出路",
  );
  eq(
    "「出路」的例子是第一条出路",
    outputVarsFor(branch, decideParams, ["深入", "收尾"])[0]?.example,
    "深入",
  );
  eq(
    "一条出路都没有时不追加(那一步该失败在「没有出路」上)",
    outputVarsFor(branch, decideParams, []).length,
    0,
  );
  // 清单里没有 `outputs` 字段的类型不该凭空多出东西来(大多数内置类型就是这样)。
  const noOutputs: NodeTypeManifest = {
    id: "demo.agent",
    manifestVersion: 1,
    name: "子代理",
    runner: { kind: "prompt" },
    capability: "read",
    params: [{ key: "outputVars", kind: "variables", label: "产出变量" }],
  };
  eq(
    "清单没声明 outputs 时两份一样",
    referenceableOutputsOf(noOutputs, params).map((v) => v.name).join(","),
    "年份",
  );
}

console.log("\ncheckOutput(纯函数)");

const VARS = [
  { name: "年份", example: "2024" },
  { name: "标题", example: "量子纠缠的实验检验" },
];

{
  // **围栏优先**:模型围着结果说一句话是常态,不是错误。要求"整段一字不差"会把大量
  // 其实没问题的产出判死。
  const fenced = '好的,结果如下:\n```json\n{"年份": "2024", "标题": "量子"}\n```\n希望有帮助';
  const r = checkOutput(fenced, VARS);
  eq("围栏里的东西提得出来", r.ok, true);
  eq("提出来的是对的", r.ok ? (r.value as { 年份: string }).年份 : null, "2024");
}

{
  const bare = '前面一句。\n{"年份": "2024", "标题": "量子"}\n后面一句。';
  eq("没有围栏也能从正文里提", checkOutput(bare, VARS).ok, true);
}

{
  // **引号里的括号不算配平** —— 不按状态走的话 `{"a":"}"}` 会在那个 `}` 上提前收尾,
  // 于是所有含花括号的值都会莫名其妙地"读不出来"。
  const tricky = '{"a": "}", "b": "{\\\\"}';
  const r = checkOutput(tricky, [
    { name: "a", example: "}" },
    { name: "b", example: "{\\" },
  ]);
  eq("引号里的花括号不提前收尾", r.ok, true);
}

{
  // 围栏里那段不是我们要的形状时,要**继续往下找** —— 模型常把解释放进围栏、把结果
  // 放在正文里(或者反过来)。只试第一个候选的话这一条会失败。
  const mixed = '```\n这里是说明\n```\n结果是 {"ok": true}';
  eq("第一段候选不对就试下一段", checkOutput(mixed, [{ name: "ok", example: "true" }]).ok, true);
}

{
  const r = checkOutput("我觉得大概是 2024 年吧", VARS);
  eq("一段散文 → 失败", r.ok, false);
  check("报错说清该交哪几样", !r.ok && r.error.includes("年份") && r.error.includes("标题"), !r.ok && r.error);
  check("它交了什么也带上了", !r.ok && r.error.includes("我觉得大概是"), !r.ok && r.error);
}

{
  const r = checkOutput('{"年份": "2024"}', VARS);
  eq("少了一样 → 失败", r.ok, false);
  check("缺的是哪样说得出来", !r.ok && r.error.includes("标题"), !r.ok && r.error);
  check("不缺的那个不冤枉它", !r.ok && !r.error.includes("年份"), !r.ok && r.error);
  check("还把示例带出来提醒", !r.ok && r.error.includes("量子纠缠"), !r.ok && r.error);
}

{
  eq("交了个数组 → 失败", checkOutput("[1,2]", VARS).ok, false);
  eq("交了个数字 → 失败", checkOutput("42", VARS).ok, false);
}

{
  const r = checkOutput("随便什么", []);
  eq("没填变量就永远过", r.ok, true);
  eq("也不给结构化产出", r.ok ? r.value : "x", undefined);
}

console.log("\nvalidateOutputRules(填得不对要说出来)");

{
  const bad = validateOutputRules(AGENT, { outputVars: [{ name: "", example: "x" }] });
  eq("名字空着 → 拒", bad.ok, false);

  eq(
    "名字重复 → 拒",
    validateOutputRules(AGENT, {
      outputVars: [
        { name: "年份", example: "2024" },
        { name: "年份", example: "2025" },
      ],
    }).ok,
    false,
  );

  const reserved = validateOutputRules(AGENT, { outputVars: [{ name: "output", example: "x" }] });
  eq("起了内置的名字 → 拒", reserved.ok, false);
  check(
    "并说清为什么(下游会取到内置的那个)",
    !reserved.ok && reserved.error.includes("内置"),
    !reserved.ok && reserved.error,
  );

  eq(
    "名字里有花括号 → 拒",
    validateOutputRules(AGENT, { outputVars: [{ name: "a{b", example: "x" }] }).ok,
    false,
  );

  const noExample = validateOutputRules(AGENT, { outputVars: [{ name: "年份", example: "" }] });
  eq("没填示例 → 拒", noExample.ok, false);
  check("说清示例是干什么用的", !noExample.ok && noExample.error.includes("示例"), !noExample.ok && noExample.error);

  eq(
    "填对了 → 过,而且把表带回来",
    validateOutputRules(AGENT, { outputVars: VARS }).ok,
    true,
  );
  eq("什么都不填 → 过", validateOutputRules(AGENT, {}).ok, true);
  // **清单没声明过就不算数**:节点换过类型之后会留下上一个类型的键。不设这道门的话,
  // 一个跟产出无关的节点会突然开始因为"少了一样"而失败。
  eq(
    "清单没声明 outputVars 时,同样的脏参数不算数",
    validateOutputRules(SHELL, { outputVars: [{ name: "output", example: "" }] }).ok,
    true,
  );
}

console.log("\n给模型看的那两段");

{
  const example = outputExampleOf(VARS);
  check("样例里两个名字都在", example.includes("年份") && example.includes("标题"), example);
  check("样例里两个示例也都在", example.includes("2024") && example.includes("量子"), example);
  eq("没填变量就没有样例", outputExampleOf([]), "");

  const desc = describeOutputVars(VARS);
  check("说了照这个形状交", desc.includes(example), desc);
  check("说了会被检查", desc.includes("会被检查"), desc);
  // **硬约束的字面意思:产出只有那个对象,别的什么都不写。** 用户的规定(原话):
  // 「这个节点如果加了硬约束,就不要有除了 json 以外的任何东西了,他的输出全部都是
  // 放在了变量里面,不需要多余的输出」—— 实测里模型交完对象又补了 5 条说明,那 5 条
  // 按这条规矩就是多余的。这三条盯住这句话,别再翻回"正文照常交"那一版。
  check("说了产出就是这个对象", desc.includes("就是这个对象"), desc);
  check("说了别的什么也不要写", desc.includes("不要写任何内容"), desc);
  check("不再让它在正文里另说一遍", !desc.includes("另起一段"), desc);
  eq("没填变量就什么都不说", describeOutputVars([]), "");
  // 用户迟早会看到这一段(提示词是能翻的),所以这里**不该出现 JSON 这个词** ——
  // 界面上从头到尾没教过他这个。见 `@contracts/outputConstraint` 的文件头。
  check("这一段里不出现 JSON 这个词", !desc.includes("JSON"), desc);
}

console.log("\n调度器:产出回来当场查");

{
  const h = makePorts({
    summary: () => '这是结果:\n```json\n{"年份": "2024", "标题": "量子"}\n```',
  });
  // **A 后面得真有一步**:终末节点不查产出变量(见下面「终末节点不发也不查」那一组),
  // 一个孤零零的 A 现在压根不会走到校验这条路上。
  const doc = docOf(
    [node("A", AGENT.id, "找一篇", { outputVars: VARS }), node("B", AGENT.id, "整理")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const a = outcomeOf(h, "A");
  eq("交齐了 → 成功", a?.status, "success");
  eq("变量进了产出,下游取得着", (a?.outputs as { 年份?: string } | undefined)?.年份, "2024");
  check("原文照旧留着", a?.summary.includes("```json") === true, a?.summary);
}

{
  // **少一样就失败** —— 而不是把一段不完整的东西递给下游。下游拿到的文本没法知道
  // 这次是不是那个意外,问题会一路传到最下游才暴露,而那时已经看不出是哪一步的。
  const h = makePorts({ summary: () => "我觉得大概是 2024 年吧" });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: VARS }),
      node("B", AGENT.id, "用 {{A.年份}} 做点事"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const a = outcomeOf(h, "A");
  eq("没交齐 → 失败", a?.status, "failed");
  check("说清缺什么", a?.error?.includes("年份") === true, a?.error);
  check("它交了什么也留着", a?.summary === "我觉得大概是 2024 年吧", a?.summary);
  eq("下游被跳过", outcomeOf(h, "B")?.status, "skipped");
}

{
  // 没填变量的节点**不该**平白多出一个空的 `outputs`:那个字段的意思是"它有产出变量",
  // 空对象会让下游的报错说成"有产出但没这个变量",而真相是这一步根本没填过。
  const h = makePorts();
  const doc = docOf([node("A")], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没填变量就没有 outputs", outcomeOf(h, "A")?.outputs, undefined);
}

console.log("\n终末节点:没人取它的变量,那张表就不发也不查");

/** 一条变量就够 —— 这几条测的是"发不发/查不查",不是表怎么渲染。 */
const ONE_VAR = [{ name: "计划", example: "上午学习,中午午睡,晚上运动" }];

{
  // 用户实测报回来的那条:最后一步交出来的东西开头就是一坨 ```{"变量名": "…"}```,
  // 而他要的是「别让我看见 JSON」。机制本身没错(表是**给下游取值**的),错在
  // **没有下游也在发**:没人来取,却逼着模型把交付物写成一个对象。
  const h = makePorts({ summary: () => "上午学习,中午午睡,晚上运动。" });
  const doc = docOf([node("A", AGENT.id, "给我一个计划", { outputVars: ONE_VAR })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const a = outcomeOf(h, "A");
  eq("交的不是对象也照样成功", a?.status, "success");
  eq("也就没有 outputs", a?.outputs, undefined);
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("提示词里没有那张变量表", !prompt.includes("会被检查"), prompt);
  check("也没提会被检查", !prompt.includes("**会被检查**"), prompt);
}

{
  // **同一份参数、同一种产出,只因为后面多了一步就该查。** 这一条和上面那条是一对:
  // 只断言"不查"的话,把校验那条路整个删掉也照样过。
  const h = makePorts({ summary: () => "上午学习,中午午睡,晚上运动。" });
  const doc = docOf(
    [
      node("A", AGENT.id, "给我一个计划", { outputVars: ONE_VAR }),
      node("B", AGENT.id, "整理 {{A.计划}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  eq("有下游 → 照样查,不交就失败", outcomeOf(h, "A")?.status, "failed");
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("有下游 → 表照发", prompt.includes("会被检查"), prompt);
}

{
  // 「期望产出」那段**大白话**是给模型看的说明,不是机器格式 —— 终末节点照发。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "给我一个计划", { outputContract: "列出来一个计划" })],
    [],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("终末节点照样看得到「期望产出」", prompt.includes("列出来一个计划"), prompt);
}

console.log("\n上游结果:点过名的那几步不再整段拼一遍");

/**
 * A 身上有产出变量表,所以它**必须交得出那个变量** —— 交不出这一步就失败、下游被跳过,
 * 断言测的就成了"没跑",而不是"怎么拼的"。所以给它一段带变量的产出,B 才是普通文本。
 */
const upstreamFixture = (): Harness =>
  makePorts({
    summary: (id) =>
      id === "A" ? '```json\n{"计划": "上午学习,中午午睡,晚上运动"}\n```' : `${id} 交出来的整段东西`,
  });

{
  // `{{A.计划}}` 已经把 A 的产出**定点**取进指令了,再整段拼一遍的话,同一份内容会以
  // 两种形状出现在同一段提示词里 —— 白烧一截 token,还逼着模型判断"这两份是不是一回事"。
  const h = upstreamFixture();
  const doc = docOf(
    [node("A", AGENT.id, "找一篇", { outputVars: ONE_VAR }), node("B", AGENT.id, "参考 {{A.计划}} 再写")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("取到了值", prompt.includes("参考 上午学习,中午午睡,晚上运动 再写"), prompt);
  check("没有「上游步骤的结果」那一段", !prompt.includes("## 上游步骤的结果"), prompt);
  check("上游的整段文本没被拼进来", !prompt.includes('"计划":'), prompt);
  // **也别再说"上游的东西在下面"** —— 下面什么都没有的时候,那是一句把人支到空白上的
  // 指路话,模型会自己编一份"上游结果"出来。这句的判据必须跟着那一段走,不是跟着
  // "图上有上游"走。全被点名时一段都没有,它就一个字都不该出现。
  check("也不说「上游的东西在下面」", !prompt.includes("上游各步的产出见下方"), prompt);
}

{
  // **不带产出的引用不算点名** —— 写 `{{A.params.…}}` 的人要的是那一步的**配置**,
  // 多半还是想看见 A 干了什么。`status` / `error` / `title` 同理。
  const h = upstreamFixture();
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇"),
      node("B", AGENT.id, "照着 {{A.params.instruction}} 和 {{A.title}} 再来一遍"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("上游结果照给", prompt.includes("## 上游步骤的产出"), prompt);
  check("整段文本在", prompt.includes('"计划":'), prompt);
  check("指路那句也在(下面真有东西)", prompt.includes("上游各步的产出见下方"), prompt);
}

{
  // 两个上游、只点名其中一个 → **另一个照给**。这是一条"跳过不等于全跳"的兜底:
  // 写成"有引用就不拼上游"的话,这条会红。
  const h = upstreamFixture();
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: ONE_VAR }),
      node("C", AGENT.id, "查数据"),
      node("B", AGENT.id, "参考 {{A.计划}} 再写"),
    ],
    [edge("A", "B"), edge("C", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("没点名的那个照给", prompt.includes("C 交出来的整段东西"), prompt);
  check("点名的那个不给", !prompt.includes('"计划":'), prompt);
  check("整段那一段还在(给 C 的)", prompt.includes("### C"), prompt);
}

console.log("\n产出变量:模型看得见,下游也取得着");

{
  const h = makePorts({ summary: () => '```json\n{"年份": "2024", "标题": "量子"}\n```' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", {
        outputVars: VARS,
        outputContract: "给出这篇文章的年份和标题",
      }),
      node("B", AGENT.id, "它发表于 {{A.年份}} 年"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const aPrompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  // 大白话的说明和变量表拼出来的样例**在同一节里** —— 拆成两节会让模型以为要满足两组
  // 互不相干的要求。
  check("大白话的说明进了提示词", aPrompt.includes("给出这篇文章的年份和标题"), aPrompt);
  check("变量表的样例也进了提示词", aPrompt.includes('"年份"'), aPrompt);
  check("而且说了会被检查", aPrompt.includes("会被检查"), aPrompt);

  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("下游取到了变量(短写法)", bPrompt.includes("发表于 2024 年"), bPrompt);
}

{
  // 长写法 `outputs.年份` 也认 —— 手写、拷文档过来的人是这么写的。
  const h = makePorts({ summary: () => '{"年份": "2024"}' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: [{ name: "年份", example: "2024" }] }),
      node("B", AGENT.id, "用 {{A.outputs.年份}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("长写法也解得出来", bPrompt.includes("用 2024"), bPrompt);
}

{
  // 上游**没填变量** → 取不到。报错要**说清下一步改哪儿**(去那一步的产出变量里填上),
  // 而不是只说"取不到"。
  const h = makePorts();
  const doc = docOf([node("A"), node("B", AGENT.id, "用 {{A.年份}}")], [edge("A", "B")]);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const b = outcomeOf(h, "B");
  eq("B 失败", b?.status, "failed");
  check("说清是「还没有产出变量」", b?.error?.includes("还没有产出变量") === true, b?.error);
  check("并指出了怎么修", b?.error?.includes("产出变量") === true, b?.error);
  check("B 没有被派发", !h.executed().includes("B"), h.executed());
}

{
  // 有产出变量、但没有那个名字 —— 和上面那条**不是一回事**(一个是改上游配置,一个是
  // 改这里的名字),所以话术也要分开。
  //
  // 这里模型**多给了一个 `期刊`** —— 而那一栏没在表里填过。它照样取不到:那张表是一句
  // **承诺**,不是"最好有"的清单。多出来的字段要是也能引用,下游的失败就是随机的
  // (今天跑得通明天跑不通),而图上没有任何地方看得出为什么。
  const h = makePorts({ summary: () => '{"年份": "2024", "期刊": "PRL"}' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: [{ name: "年份", example: "2024" }] }),
      node("B", AGENT.id, "投在 {{A.期刊}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("多给的那一个没留下来", (outcomeOf(h, "A")?.outputs as { 期刊?: string } | undefined)?.期刊, undefined);
  const b = outcomeOf(h, "B");
  eq("B 失败", b?.status, "failed");
  check("点了名说没有哪个", b?.error?.includes("期刊") === true, b?.error);
  check("还把有的列出来了", b?.error?.includes("年份") === true, b?.error);
}

summary();
