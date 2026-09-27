/**
 * MAINT-M16 定向 smoke —— 长期记忆与交接后端。
 *
 * ## 钉的是「注入预算 / 秘密遮蔽」这一条的**顺序**
 *
 * 记忆助手把来源对话整理成一段材料喂给模型。那段材料要做两件事:**遮蔽已知形式的
 * 凭据**、**裁到预算之内**。这两件事**谁先谁后是有对错的**:
 *
 *   先裁后遮 → 预算切口一旦落在 PEM 私钥块中间,`-----END … PRIVATE KEY-----`
 *   就被切掉了,而遮蔽用的模式**需要这个定界符才能匹配**;于是模式匹配不上,
 *   留在材料里的那半截私钥**原样进入模型上下文**。切得越靠近密钥,漏得越多。
 *
 * 同一个形状在三处截断上都成立(单值 4000、总预算 32000),所以这里逐个钉。
 *
 * ## 另一半:项目/全局授权的可见性矩阵
 *
 * `visibleMemory` 是"这条记忆能不能进这个项目的上下文"的唯一判据(检索与受控快照都
 * 问它)。legacy(未分类)必须**不可见** —— 那是"旧记忆要先在设置里确认导入"的依据;
 * 别的项目的记忆同样不可见。判错任一格都是跨项目泄漏。
 *
 * 全是纯函数,不碰库、不碰时钟、不起进程。
 *
 * Run: scripts/maint-m16-smoke/run.sh
 */
import {
  SOURCE_BUDGET,
  VALUE_CAP,
  clampSourceContext,
  redactSecrets,
  textOf,
} from "@main/memory/sourceText.js";
import { visibleMemory } from "@main/memory/paths.js";

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

const PEM_HEAD = "-----BEGIN RSA PRIVATE KEY-----";
const PEM_TAIL = "-----END RSA PRIVATE KEY-----";
const pemBlock = `${PEM_HEAD}\nMIIEowIBAAKCAQEA${"A".repeat(3000)}\n${PEM_TAIL}`;

console.log("A. 凭据遮蔽本身(两类已知形状)");
check("PEM 私钥块被替换", redactSecrets(`前${pemBlock}后`) === "前[已隐藏私钥]后", redactSecrets(`前${pemBlock}后`).slice(0, 60));
check("sk- 访问密钥被替换", redactSecrets(`k=sk-${"a".repeat(40)} .`).includes("[已隐藏疑似密钥]"));
check("AKIA 访问密钥被替换", redactSecrets("AKIAABCDEFGHIJKLMNOP x").includes("[已隐藏疑似密钥]"));
check("遮蔽是幂等的", redactSecrets(redactSecrets(pemBlock)) === redactSecrets(pemBlock));
check("普通文本不被误伤", redactSecrets("这是一段普通说明 sk-short") === "这是一段普通说明 sk-short");

console.log("B. 总预算裁剪:切口落在密钥块中间时不得漏出");
// 切口刻意落在 PEM 块内部:BEGIN 在预算之内,END 在预算之外。
const straddling = `${"x".repeat(SOURCE_BUDGET - 100)}${pemBlock}尾部`;
const clamped = clampSourceContext(straddling);
check("裁剪后不含 PEM 头(切口在块中间)", !clamped.includes(PEM_HEAD), { head: clamped.slice(SOURCE_BUDGET - 120, SOURCE_BUDGET) });
check("裁剪后不含私钥正文", !clamped.includes("MIIEowIBAAKCAQEA"), { tail: clamped.slice(-80) });
check("裁剪后给出占位符", clamped.includes("[已隐藏私钥]"), clamped.slice(-40));
check("裁剪后仍在预算之内", clamped.length <= SOURCE_BUDGET, clamped.length);

// 同一个形状,换成 sk- 密钥:切口把它切成不足 24 字符的残段,模式就咬不住了。
// ⚠️ 密钥前必须有分隔符。遮蔽模式带 `\b` 锚点,紧贴在词字符后面的 `sk-…`
// **本来就不在它的识别范围内**(见 redactSecrets 的说明:只认已知形状),
// 那是既有的取舍,不是这条断言要钉的东西 —— 这里钉的是**截断顺序**。
const skKey = `sk-${"a".repeat(40)}`;
const straddlingSk = `${"z".repeat(SOURCE_BUDGET - 25)}\nk=${skKey} 结束`;
const clampedSk = clampSourceContext(straddlingSk);
check("裁剪后不含 sk- 残段", !clampedSk.includes("sk-a"), { tail: clampedSk.slice(-40) });
check("sk- 情况也给出占位符", clampedSk.includes("[已隐藏疑似密钥]"), clampedSk.slice(-40));

// 预算之内的正常材料不受影响。
const small = "材料范围：…\n\n[user / m1]\n把引用格式改成 APA。";
eq("未超预算的材料原样通过", clampSourceContext(small), small);

console.log("C. 单值上限:一条消息内部的密钥同样不能被切漏");
const longValue = `${"y".repeat(VALUE_CAP - 200)}${pemBlock}`;
const valueText = textOf(longValue);
check("textOf 裁剪后不含 PEM 头", !valueText.includes(PEM_HEAD), { at: valueText.indexOf(PEM_HEAD), len: valueText.length });
check("textOf 裁剪后不含私钥正文", !valueText.includes("MIIEowIBAAKCAQEA"));
check("textOf 仍遵守单值上限", valueText.length <= VALUE_CAP, valueText.length);
// 嵌套结构走同一条路(消息 content 是块数组)。
const nested = { type: "text", text: `${"w".repeat(VALUE_CAP - 100)}${pemBlock}` };
check("嵌套块里的密钥同样不漏", !textOf([nested]).includes(PEM_HEAD));
eq("图片块不进材料", textOf({ type: "image", text: "data" }), "");
eq("思考块不进材料", textOf({ type: "thinking", text: "内心戏" }), "");

console.log("D. 项目/全局授权的可见性矩阵");
check("本项目的记忆可见", visibleMemory("projects/proj-a/project/note.md", "proj-a"));
check("显式全局可见", visibleMemory("global/preferences/style.md", "proj-a"));
check("别的项目不可见", !visibleMemory("projects/proj-b/project/note.md", "proj-a"));
check("legacy 未分类不可见(要先在设置里确认导入)", !visibleMemory("project/note.md", "proj-a"));
check("非法类目不可见", !visibleMemory("projects/proj-a/nope/note.md", "proj-a"));
check("目录穿越写法不可见", !visibleMemory("projects/proj-a/project/../../../etc/passwd.md", "proj-a"));
check("非 .md 不可见", !visibleMemory("projects/proj-a/project/note.txt", "proj-a"));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`maint-m16-smoke: ${failures} failing check(s)`);
  process.exit(1);
}

