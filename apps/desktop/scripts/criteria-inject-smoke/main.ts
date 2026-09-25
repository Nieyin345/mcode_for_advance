/**
 * 入口节点「固定条件」注入的无头冒烟 —— `main/orchestration/criteriaInject.ts`
 * 加上它脚下那层(`main/lib/searchPrefs.ts` 的拼装、设置表里的选中值)。
 *
 * ## 它验的是哪几条
 *
 * 这一套里**每一条都是用户报过的问题**,不是补出来的覆盖率:
 *
 *  1. **只在这个对话的第一轮注入**。第一轮注进去之后条件就已经在上下文里,后面每一轮
 *     再注就是同一段话反复出现 —— 而在此之前它是**每次运行都注**(每发一条消息就是
 *     一次运行)。
 *  2. **续跑不注**。点上一轮的卡片接回来时,存档里的 prompt 当年已经带过这段。
 *  3. **值为「不限」/没选的跳过**。界面上显示「—」的条件在提示词里不该存在 ——
 *     否则会出现"界面显示着没设、模型却收到一条条件"的错位。
 *  4. **条件名上那句解释会跟着注入**。它是配置的人写给模型的(「T1 = Q1 或中科院
 *     1 区或 Top 期刊」),不带上模型只能按字面猜。
 *  5. **节点上没声明的条件不注**。用户改过名/删过条件之后,设置表里留着的是孤儿键 ——
 *     跟着**节点**遍历才不会把没人认识的东西注进去。
 *
 * ## 为什么不用起 Electron
 *
 * `criteriaInject.ts` 刻意不 import `runner.ts`(那一头拖着 RuntimeManager 和三家
 * provider),所以这里能直接调它。设置表那半边要一个真的库 —— 脚下那个数据根换成
 * `mktemp` 出来的临时目录(见 stubs/dataRoot.ts 里那句"没设就抛")。
 *
 * Run: scripts/criteria-inject-smoke/run.sh
 */
import { initDb, getDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { WORKFLOW_NODE_PREFS_SETTING_PREFIX } from "@contracts/ipc";
import { injectEntryCriteria, entryCriteriaOf } from "@main/orchestration/criteriaInject.js";
import { docWithMainNode } from "./doc.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
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

/** 检索图那四条条件的精简版 —— 形状与 `builtins.ts` 的预填数据一致。 */
const CRITERIA = [
  { name: "时间范围", choices: ["不限", "近三年", "近五年"], note: "近N年按当前年份往前推" },
  { name: "期刊层次", choices: ["不限", "T1", "T2"], note: "T1 = Q1 或中科院 1 区或 Top 期刊" },
  { name: "每源条数", choices: ["不限", "10", "20"] },
];

const WORKFLOW = "wf_criteria_smoke";
const PREFS_KEY = WORKFLOW_NODE_PREFS_SETTING_PREFIX + WORKFLOW;
const doc = docWithMainNode({ instruction: "定方向", criteria: CRITERIA });

/** 换一份选中值。**每一步都从头写** —— 设置表是整份覆盖的,不清干净会串到下一步。 */
function setPrefs(values: Record<string, string>): void {
  SettingRepo.set(PREFS_KEY, JSON.stringify(values));
}

function clearPrefs(): void {
  getDb().run("DELETE FROM settings WHERE key = ?", [PREFS_KEY]);
}

/** 跑一次注入,拿拼好的 prompt。 */
function inject(prompt: string, opts?: { resumed?: boolean; firstTurn?: boolean }): string {
  return injectEntryCriteria({
    doc,
    workflowId: WORKFLOW,
    prompt,
    resumed: opts?.resumed ?? false,
    firstTurn: opts?.firstTurn ?? true,
  });
}

async function main(): Promise<void> {
  await initDb();

  console.log("\n读条件表(主节点参数 → 注入用的形状)");
  {
    const rows = entryCriteriaOf(doc);
    eq("三条都读出来了", rows.length, 3);
    eq("候选值是数组", Array.isArray(rows[0]?.choices), true);
    eq("解释跟着走", rows[1]?.note, "T1 = Q1 或中科院 1 区或 Top 期刊");
    check("没写解释的那条不带 note 键", !("note" in (rows[2] ?? {})), rows[2]);

    // 坏行丢掉,不抛 —— 参数是自由数据,一行写坏了不该让整次运行起不来。
    const messy = docWithMainNode({
      criteria: [
        { name: "好的", choices: ["不限", "近三年"] },
        "这不是一行",
        { name: 3, choices: [] },
        { choices: ["不限"] },
        { name: "混进数字", choices: ["不限", 7] },
      ],
    });
    const kept = entryCriteriaOf(messy);
    // 留下来的是两条:一条完好,一条名字合法、只是候选里混了个数字(数字被滤掉、行还在)。
    // 丢掉的是三条 —— 不是对象的那条、name 不是字符串的、以及根本没有 name 的。
    eq("坏行全丢掉,留下能读的那两条", kept.length, 2);
    eq("留下的是好的那条", kept[0]?.name, "好的");
    eq("候选里的非字符串也滤掉了", kept[0]?.choices.join(","), "不限,近三年");
    eq("名字合法的一条照留", kept[1]?.name, "混进数字");
    eq("它的候选里只剩字符串", kept[1]?.choices.join(","), "不限");
    eq("节点上没这个参数 → 空表", entryCriteriaOf(docWithMainNode({})).length, 0);
  }

  console.log("\n只在对话的第一轮注入(用户报的那条)");
  {
    setPrefs({ 时间范围: "近三年", 期刊层次: "T1" });
    const first = inject("帮我找找最近的扩散模型论文");
    check("第一轮注了", first.includes("## 这次的固定条件"), first);
    check("用户那句话还在最前面", first.startsWith("帮我找找最近的扩散模型论文"), first);
    eq("条件接在后面", first.split("\n\n")[0], "帮我找找最近的扩散模型论文");

    // **这一条是重点**:第二轮起不再注 —— 条件已经在上下文里了。
    const second = inject("再找找别的", { firstTurn: false });
    eq("第二轮原样返回,没有注入段", second, "再找找别的");
    check("第二轮里没有那几条条件", !second.includes("时间范围"), second);

    // 续跑同理:存档里那份 prompt 当年已经带过这段。
    const resumed = inject("从存档里读回来的原话", { resumed: true, firstTurn: false });
    eq("续跑不注", resumed, "从存档里读回来的原话");
    // 就算判据给错了(理论上不该发生),续跑这道门也得自己站住。
    eq("续跑这道门独立成立", inject("原话", { resumed: true, firstTurn: true }), "原话");
  }

  console.log("\n值为「不限」/没选的跳过");
  {
    setPrefs({ 时间范围: "不限", 期刊层次: "T1" });
    const out = inject("找论文");
    check("选了的那条在里面", out.includes("期刊层次:T1"), out);
    check("「不限」那条不在", !out.includes("时间范围"), out);
    eq("没设过的条件也不在", out.includes("每源条数"), false);

    clearPrefs();
    eq("一条都没设 → 原样返回", inject("找论文"), "找论文");

    // **孤儿键不注**:用户把条件删了/改名了,设置表里还留着旧键。
    setPrefs({ 时间范围: "近三年", 已删掉的条件: "某个值" });
    const orphan = inject("找论文");
    check("节点上还声明的那条照注", orphan.includes("时间范围:近三年"), orphan);
    check("节点上已经没有的条件不注", !orphan.includes("已删掉的条件"), orphan);
  }

  console.log("\n相对年份就地换算(模型算错一年的事出过)");
  {
    const year = (n: number): number => new Date().getFullYear() - n;

    // **汉字数字那一条是内置检索图真实的写法**(见 `builtins.ts` 的预填候选值)。
    // 这里原先只认 ASCII 数字,于是换算对随应用发布的那张图从来没生效过。
    setPrefs({ 时间范围: "近三年" });
    const han = inject("找论文");
    check(`「近三年」换算出绝对年份(即 ${year(3)} 年以后)`, han.includes(`即 ${year(3)} 年以后`), han);
    check("解释仍然挂在行尾", han.includes("—— 近N年按当前年份往前推"), han);
    check("值那一格没被解释挤坏", han.includes("- 时间范围:近三年(即 "), han);

    // ASCII 数字也照旧认(手写参数的人会这么写)。
    setPrefs({ 时间范围: "近3年" });
    check(`「近3年」一样换得出`, inject("找论文").includes(`即 ${year(3)} 年以后`));

    // 十位以上的中文数字。
    setPrefs({ 时间范围: "近十年" });
    check(`「近十年」= ${year(10)}`, inject("找论文").includes(`即 ${year(10)} 年以后`));
    setPrefs({ 时间范围: "近十五年" });
    check(`「近十五年」= ${year(15)}`, inject("找论文").includes(`即 ${year(15)} 年以后`));
    setPrefs({ 时间范围: "近二十年" });
    check(`「近二十年」= ${year(20)}`, inject("找论文").includes(`即 ${year(20)} 年以后`));
    setPrefs({ 时间范围: "近二十三年" });
    check(`「近二十三年」= ${year(23)}`, inject("找论文").includes(`即 ${year(23)} 年以后`));

    // **认不出来就原样返回,不猜** —— 「近些年」不该被当成某个数字。
    setPrefs({ 时间范围: "近些年" });
    const vague = inject("找论文");
    check("「近些年」原样保留", vague.includes("- 时间范围:近些年") && !vague.includes("即 "), vague);
    setPrefs({ 时间范围: "近0年" });
    check("「近0年」不换算", !inject("找论文").includes("即 "));
  }

  console.log("\n解释跟着条件一起注入");
  {
    setPrefs({ 期刊层次: "T1" });
    const out = inject("找论文");
    check("解释在行尾", out.includes("- 期刊层次:T1 —— T1 = Q1 或中科院 1 区或 Top 期刊"), out);

    // 没配解释的条件不该多出一条破折号。
    setPrefs({ 每源条数: "10" });
    const bare = inject("找论文");
    check("没解释的条件只有一条", bare.includes("- 每源条数:10") && !bare.includes("每源条数:10 ——"), bare);
  }

  console.log("\n提示词为空时的边界");
  {
    setPrefs({ 时间范围: "近三年" });
    // 自动化触发那一路的 prompt 永远非空(触发器任务 + 载荷),但空串也得站得住。
    const out = inject("");
    check("空 prompt 时注入段自己成为正文", out.startsWith("## 这次的固定条件"), out);
    eq("空 prompt + 没条件 → 还是空", inject("", { firstTurn: false }), "");
  }

  /**
   * 候选**现读**的条件(见 `@contracts/nodeType` 的 `source`)。
   *
   * ⚠️ **这一段钉的是"注入前必须把 id 翻成名字"**。界面上存进设置表的是**不透明的
   * 分类 id**(`lc_xxx`),原样注进提示词的话模型读到的是 `- 导入到:lc_mufvfytr` ——
   * 它没法知道那是哪个分类,而这条条件的全部意义就是"告诉它东西放哪儿"。
   *
   * 这条错**不会让任何东西报错**:提示词照样拼得出来、模型照样跑,只是它拿到的是一串
   * 它读不懂的字符,于是自己猜一个落点。所以它必须靠断言守着。
   */
  console.log("\n候选现读的条件 · 注入前要把 id 翻成名字");
  {
    const { CollectionRepo } = await import("@main/store/repositories.js");
    const withSource = docWithMainNode({
      criteria: [
        { name: "导入到", choices: [], source: "collections" },
        // 对照:手写候选那一条，值原样注入，不做任何翻译。
        { name: "时间范围", choices: ["不限", "近三年"] },
      ],
    });
    const target = CollectionRepo.create("量子密钥", null).id;

    const run = (values: Record<string, string>): string =>
      injectEntryCriteria({
        doc: withSource,
        workflowId: WORKFLOW,
        prompt: "找论文",
        resumed: false,
        firstTurn: true,
      });

    setPrefs({ 导入到: target, 时间范围: "近三年" });
    const out = run({});
    check("★ 分类 id 被翻成了名字", out.includes("- 导入到:量子密钥"), out);
    check("★ 提示词里**没有**那个不透明的 id", !out.includes(target), out);
    // 手写候选那一条不受影响(别把翻译做成了全局替换)。
    check("手写候选原样注入", out.includes("- 时间范围:近三年"), out);

    // **查不到时要说人话，不能编一个名字。** 分类被删了/存档指向别处的库时，那句 id
    // 就是死引用 —— 同这个模块头上那条"查不了就说查不了"。
    setPrefs({ 导入到: "lc_早就没了" });
    const gone = run({});
    check("查不到的 id 明说查不到", gone.includes("已删除的分类"), gone);
    check("而且没有编造一个名字", !gone.includes("导入到:lc_早就没了\n"), gone);
  }

  console.log(`\n${total - failures}/${total} 通过`);
  if (failures > 0) process.exit(1);
}

await main();
