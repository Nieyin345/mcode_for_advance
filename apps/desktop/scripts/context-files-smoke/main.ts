/**
 * Headless smoke for 托管上下文的文件层 — `main/lib/appContext.ts` +
 * `main/lib/tokenEstimate.ts`.
 *
 * ## 为什么要钉这里
 *
 * appContext 管「设置面板写的每一份文件落在哪、什么时候覆盖、什么时候绝不碰」。
 * 它的语义里藏着好几个**只看代码看不出对错、错了还安静**的决策:
 *
 *  - 收养:事实源缺失时把既有消费点的内容接进编辑器(剥托管标记)——接错或
 *    不剥标记,用户会在编辑器里看到 `<!-- mcode:managed -->` 或丢掉手写内容;
 *  - 手写文件保护:无标记的消费点在自动路径下绝不改写(防误删),面板显式
 *    保存才覆盖 —— 方向搞反就是数据事故;
 *  - 空内容 = 「明确配置为空」:源写成**空文件**而不是删除(删了下次读取会
 *    又走收养分支),已托管的消费点删掉 —— 两个动作必须同轮发生;
 *  - 幂等:同内容重写必须是 "unchanged"(物化在 CONTEXT_GET 时反复触发,
 *    不幂等就是每开一次面板重写一次文件,mtime 乱跳)。
 *
 * 这些全在临时目录里真读真写地跑一遍,不用桩 —— 存取逻辑本身就是被测物。
 *
 * 没有覆盖的:IPC 层路径装配(main/ipc/context.ts,拉 electron)与三引擎的
 * 消费点(要活的会话),靠真机验收。
 *
 * Run: scripts/context-files-smoke/run.sh
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_MARKER,
  ensureMaterialized,
  instructionsSourcePath,
  listMemoryDirs,
  memoryFilePath,
  materializeManagedFile,
  projectSlug,
  readInstructionsSource,
  readInstructionsState,
  readMemoryFile,
  stripManagedMarker,
  writeInstructionsAt,
  writeMemoryFile,
} from "@main/lib/appContext.js";
import { estimateToolTokens } from "@main/lib/tokenEstimate.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组/对象用的深比较(JSON 形态)—— Object.is 对数组按引用比,永远不等。 */
function eqDeep(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected },
  );
}

const root = mkdtempSync(join(tmpdir(), "mcode-context-files-smoke-"));

/* ────────────────────── 1. slug 规则 ────────────────────── */

console.log("\nprojectSlug(路径中每个非 [A-Za-z0-9-] 折成 -)");

eq("冒号/反斜杠/空格", projectSlug("D:\\destop\\work space"), "D--destop-work-space");
eq("正斜杠与已有连字符保留", projectSlug("D:/proj-2026"), "D--proj-2026");

/* ────────────────────── 2. 全局指令:读 / 收养 ────────────────────── */

console.log("\n全局指令:读取与收养");

const source = instructionsSourcePath(root);
const claudeMd = join(root, "smoke-CLAUDE.md");
const codexMd = join(root, "smoke-AGENTS.md");

// 全新安装:没有源、没有消费点 → 空、未收养。
let st = readInstructionsState(source, [claudeMd]);
eq("全新:内容为空", st.content, "");
eq("全新:未收养", st.adopted, false);
eq("全新:readInstructionsSource 也是空", readInstructionsSource(source), "");

// 用户手写过消费点(带托管标记——上一版 Mcode 留下的),事实源还没建:
// 首次接管要**收养**进编辑器,而且编辑器里不能看到标记本身。
writeFileSync(claudeMd, `${MANAGED_MARKER}\n\n# 手写的老指令\n正文\n`, "utf-8");
st = readInstructionsState(source, [claudeMd]);
eq("收养:adopted=true", st.adopted, true);
eq("收养:来源指向消费点", st.adoptedFrom, claudeMd);
check("收养:剥掉了托管标记", st.content.includes(MANAGED_MARKER) === false, st.content);
check(
  "收养:正文完整(含换行结构)",
  st.content.trim() === "# 手写的老指令\n正文",
  JSON.stringify(st.content),
);

// 收养候选是**依序**取第一个非空的:空目标(只有标记)跳过,不吞正文。
writeFileSync(codexMd, `${MANAGED_MARKER}\n\n   \n`, "utf-8");
st = readInstructionsState(source, [codexMd, claudeMd]);
eq("空目标跳过:仍收养到有正文的那份", st.adoptedFrom, claudeMd);

// ⚠️ 源存在(哪怕是空文件)就以源为准 —— 「明确配置为空」和「从未配置」是两回事。
mkdirSync(join(root, "context"), { recursive: true });
writeFileSync(source, "", "utf-8");
st = readInstructionsState(source, [claudeMd]);
eq("源存在:不收养", st.adopted, false);
eq("源存在:内容=源(空)", st.content, "");

// stripManagedMarker 单独钉一下(收养 codex/pi 侧组装产物时也会用到)。
eq("剥标记:只有标记时归空", stripManagedMarker(`${MANAGED_MARKER}\n\n`), "");

/* ────────────────────── 3. 全局指令:写 / 物化 ────────────────────── */

console.log("\n全局指令:保存与物化");

// 面板显式保存(force):事实源落盘,两个消费点全部物化(带标记)。
let w = writeInstructionsAt(source, [claudeMd, codexMd], "# 全局指令 v1", { force: true });
eq("保存:ok", w.ok, true);
eqDeep("保存:两个目标都写入", w.materialized.map((m) => m.action), ["written", "written"]);
eq("事实源:尾部一个换行", readFileSync(source, "utf-8"), "# 全局指令 v1\n");
check(
  "消费点:标记头 + 正文",
  readFileSync(claudeMd, "utf-8") === `${MANAGED_MARKER}\n\n# 全局指令 v1\n`,
  JSON.stringify(readFileSync(claudeMd, "utf-8")),
);

// 幂等:同内容重写必须是 unchanged(CONTEXT_GET 会反复触发物化)。
w = writeInstructionsAt(source, [claudeMd, codexMd], "# 全局指令 v1", { force: true });
eqDeep("幂等:目标不再重写", w.materialized.map((m) => m.action), ["unchanged", "unchanged"]);

// 漂移修复:消费点被(别的工具)改写或手删,ensureMaterialized 自动补齐 ——
// 但只动托管文件,无标记的手写文件跳过并给 warning。
writeFileSync(claudeMd, `${MANAGED_MARKER}\n\n# 被别人改过\n`, "utf-8");
let m = ensureMaterialized(source, [claudeMd]);
eq("漂移:托管文件被重写", m[0]?.action, "written");
check("漂移:内容回到事实源", readFileSync(claudeMd, "utf-8").includes("# 全局指令 v1"));

if (existsSync(claudeMd)) rmSync(claudeMd);
m = ensureMaterialized(source, [claudeMd]);
eq("漂移:手删后重建", m[0]?.action, "written");
check("漂移:重建内容=事实源", readFileSync(claudeMd, "utf-8") === `${MANAGED_MARKER}\n\n# 全局指令 v1\n`);

// 手写文件(无标记):自动路径绝不碰;显式保存才接管。
writeFileSync(codexMd, "# 用户手写的,没有标记\n", "utf-8");
m = ensureMaterialized(source, [codexMd]);
eq("手写保护:自动路径跳过", m[0]?.action, "skipped-unmanaged");
eq("手写保护:内容原样", readFileSync(codexMd, "utf-8"), "# 用户手写的,没有标记\n");
w = writeInstructionsAt(source, [codexMd], "# 全局指令 v1", { force: false });
check("手写保护:非强制写入带 warning", (w.warnings?.length ?? 0) === 1, w.warnings);
w = writeInstructionsAt(source, [codexMd], "# 全局指令 v1", { force: true });
eq("显式保存:接管为托管", w.materialized[0]?.action, "written");
check("显式保存:内容被覆盖", readFileSync(codexMd, "utf-8") === `${MANAGED_MARKER}\n\n# 全局指令 v1\n`);

// materializeManagedFile 直调的三态(不经 writeInstructionsAt 的包装)。
const lone = join(root, "smoke-lone.md");
eq("直调:不存在→写入", materializeManagedFile(lone, "x", { force: false }).action, "written");
eq("直调:一致→unchanged", materializeManagedFile(lone, "x", { force: false }).action, "unchanged");
eq("直调:空+托管→删除", materializeManagedFile(lone, "", { force: false }).action, "deleted");
eq("直调:删除后文件真的没了", existsSync(lone), false);

// 空内容 = 「明确配置为空」:源写成空文件(不是删除,否则下次读取又走收养),
// 已托管的消费点删掉。
w = writeInstructionsAt(source, [claudeMd, codexMd], "  \n", { force: true });
eqDeep("空内容:目标删除", w.materialized.map((m2) => m2.action), ["deleted", "deleted"]);
eq("空内容:消费点真的没了", existsSync(claudeMd) || existsSync(codexMd), false);
eq("空内容:事实源是空文件(存在!)", existsSync(source) && readFileSync(source, "utf-8") === "", true);
st = readInstructionsState(source, [claudeMd]);
eqDeep("空内容之后读取:不收养、内容空", [st.adopted, st.content], [false, ""]);
eq("空内容之后 ensureMaterialized:无事可做", ensureMaterialized(source, [claudeMd]).length, 0);

// CRLF 归一(Windows 用户在 textarea 里粘贴 CRLF 文本是常态)。
w = writeInstructionsAt(source, [claudeMd], "# a\r\nb\r\n", { force: true });
eq("CRLF:ok", w.ok, true);
check("CRLF:消费点里没有 \\r", !readFileSync(claudeMd, "utf-8").includes("\r"));
check("CRLF:事实源里没有 \\r", !readFileSync(source, "utf-8").includes("\r"));

/* ────────────────────── 4. 记忆 ────────────────────── */

console.log("\n项目记忆:列 / 读 / 写");

const projectsRoot = join(root, "projects");
// CLI 自己建的那种目录:memory/ 在,MEMORY.md 还没落盘 → updatedAt null。
mkdirSync(join(projectsRoot, "D--work-proj-A", "memory"), { recursive: true });
// 编辑器写的那份:真文件。
const fileB = memoryFilePath(projectsRoot, "projB");
eq("记忆路径:四段拼装", fileB.endsWith(join("projB", "memory", "MEMORY.md")), true);
eq("写入:ok", writeMemoryFile(fileB, "# B 的记忆\n").ok, true);

const dirs = listMemoryDirs(projectsRoot, ["D:\\work\\proj A"]);
eq("条目数", dirs.length, 2);
// 排序:有文件的在前(null 视作最旧)。
eq("排序:有 updatedAt 的在前", dirs[0]?.slug, "projB");
check("有文件:updatedAt 是数字", typeof dirs[0]?.updatedAt === "number");
const dirA = dirs.find((d) => d.slug === "D--work-proj-A");
check("无文件:updatedAt null", dirA?.updatedAt === null);
// 显示名:slug 不可逆,靠 hint 按同一规则算回来;匹配不上显示 slug 本身。
eq("显示名:hint 命中", dirA?.label, "D:\\work\\proj A");
eq("显示名:无 hint 时=slug", dirs[0]?.label, "projB");

eq("读:回写一致", readMemoryFile(fileB), "# B 的记忆\n");
eq("读:缺失=空串(新建场景)", readMemoryFile(join(projectsRoot, "nope", "memory", "MEMORY.md")), "");
eq("写:CRLF 归一", writeMemoryFile(fileB, "# c\r\n").ok && readMemoryFile(fileB), "# c\n");

// slug 是路径段 —— 二次防护必须真的拦(path traversal / 任意子目录)。
let threw = false;
try {
  memoryFilePath(projectsRoot, "../evil");
} catch {
  threw = true;
}
check("非法 slug:../ 被拒", threw, true);
threw = false;
try {
  memoryFilePath(projectsRoot, "a b");
} catch {
  threw = true;
}
check("非法 slug:空格被拒", threw, true);

/* ────────────────────── 5. token 估算 ────────────────────── */

console.log("\ntokenEstimate(工具占用的折算)");

// 折算 = ceil(字符数/4),字符数按 JSON.stringify 的线上形态 —— 与实现
// 逐字段对表,换字段顺序/加字段时这里会红(占用面板的数字必须可解释)。
const tool = { name: "lib_search", description: "search the library" };
eq(
  "名字+描述的折算",
  estimateToolTokens(tool),
  Math.ceil(JSON.stringify(tool).length / 4),
);
const withSchema = { ...tool, inputSchema: { type: "object", properties: { q: { type: "string" } } } };
eq(
  "带 inputSchema 的折算",
  estimateToolTokens(withSchema),
  Math.ceil(JSON.stringify(withSchema).length / 4),
);
eq("空描述不炸", typeof estimateToolTokens({ name: "x" }), "number");

/* ────────────────────── 6. 源级哨兵:外部继承切断 ────────────────────── */

console.log("\n源级哨兵:外部继承切断(claude 半边)");

// 这两条**没法行为级测**: enforcement 点是 CLI 二进制按 settingSources 读
// 不读 cwd 向上的文件,headless 拿不到活的二进制。退而求其次钉住源码里那
// 一行 —— 它就是 p1 决策的全部落点。重构挪走了这两行时,把断言指向新位置
// 即可;但**删掉而不补**会让外部 .mcp.json / CLAUDE.md 静默卷进每一轮
// (实测一轮 +26k token 且打断前缀缓存),所以宁可钉得难看。
const providerSrc = readFileSync(
  resolve("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"),
  "utf-8",
);
check(
  'provider 仍钉着 options.settingSources = ["user"]',
  providerSrc.includes('options.settingSources = ["user"]'),
);
const mcpSrc = readFileSync(resolve("src/main/lib/mcpConfig.ts"), "utf-8");
check(
  "mcpConfig 不再有项目级 .mcp.json 读取器",
  !mcpSrc.includes("readProjectMcpServers"),
);

/* ───────────────────────────── report ───────────────────────────── */

if (failures > 0) {
  console.error(`\n${failures} failed, ${checks - failures} passed`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} 通过`);
