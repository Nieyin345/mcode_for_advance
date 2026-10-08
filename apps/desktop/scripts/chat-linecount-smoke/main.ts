/**
 * chat-linecount-smoke — `WriteToolCard` 的「N 行」徽标(MessageBlocks.tsx)。
 *
 * ## 盯的是什么
 *
 * Write 卡在没有 before 快照时(回合流式中 turn.files 还没落地,或该文件不在
 * beforeMap 里)显示「{n} 行」。这一行数此前是 `content.split("\n").length` ——
 * 以 `\n` 结尾的文件(几乎所有编辑器/prettier 的默认)会被**多算一行**:
 * `"a\nb\nc\n"` 是 3 行,`split` 得 `["a","b","c",""]` → 报 4 行。
 *
 * 这不是孤例:同一个「末尾单个 `\n` 是终止符、不是幽灵行」的规矩,仓库里
 * lineDiff.ts 的 `splitLines` 与主进程 fileSnapshot.ts 的 `splitLines` 都写着,
 * 紧挨着这个徽标的 `+N -M` diff 也走同一套。只有这里手写了朴素切分 —— 于是同一
 * 张卡上,"无 before 时的行数"和"有 before 时的 diff 行数"用的是两套口径。
 *
 * ## 判据
 *
 * 立在用户看到的那条串上:末尾带 `\n` 的正文,行数 = 真实行数(不多一行)。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `MessageBlocks.tsx`(只调其导出的纯函数);`@renderer/lib/monacoSetup.js`
 * 换成空壳;prelude 提供 `window`/`document`(sessionStore→api.ts 求值要用)。
 * 不起浏览器、不写盘。
 *
 * Run: scripts/chat-linecount-smoke/run.sh
 */
import "../../scripts/renderer-pure-smoke/prelude.js";
import { countContentLines } from "@renderer/components/chat/MessageBlocks.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (Object.is(actual, expected)) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name} — actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

console.log("Write 卡「N 行」徽标:行数口径");
check("末尾带 \n 的三行文件 → 3", countContentLines("a\nb\nc\n"), 3);
check("末尾无 \n 的三行文件 → 3", countContentLines("a\nb\nc"), 3);
check("单行带 \n → 1", countContentLines("only\n"), 1);
check("单行无 \n → 1", countContentLines("only"), 1);
check("空内容 → 0", countContentLines(""), 0);
check("中间空行算一行", countContentLines("a\n\nb\n"), 3);

// 与紧挨着徽标的 diff 口径必须一致:无 before(空旧文)时,新增行数就是行数。
{
  const content = "line1\nline2\nline3\n";
  const diffAdds = diffSummary(lineDiff("", content)).adds;
  check("与同一张卡的 diff 行数口径一致", countContentLines(content), diffAdds);
}

console.log(`\nchat-linecount-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
