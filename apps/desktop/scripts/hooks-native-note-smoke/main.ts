/**
 * 钩子面板的「原生 hooks 不在这里生效」那句说明(H1/H2)。
 *
 * ## 盯的是什么
 *
 * Mcode 的钩子走**自己**那套(数据根下的 `hooks.json`,由 `HookRunner` 订阅宿主事件总线),
 * 与引擎原生 hooks 是两条互不相干的机制。隔离是刻意的,但**没有任何地方告诉用户** ——
 * 让用户在 Claude Code 的 `~/.claude/settings.json` 里配了 hook、到 Mcode 里发现不跑而
 * 一头雾水,属于"坏东西不报出来"。
 *
 * 修法是钩子面板上一句说明。这条说明有两个会**静默失效**的失败面,都在这里钉住:
 *
 *   ① 词条本身没了 / 只说了一半。三件事实缺一不可 —— 本页用 `hooks.json`、
 *      `~/.claude` 那份**不生效**、`~/.mcode` 那份是**另一条路**。少说最后一件,
 *      用户会以为两处 hooks.json 是一回事。
 *   ② 面板**没把它渲染出来**(词条在、面板不引用)—— 这正是本仓库踩过的
 *      "登记了却没人命中"那一类:改动看着完成了,界面上一个字都没有。
 *
 * ## 它怎么跑
 *
 * esbuild 打包**真** i18n core(`translate`),`translate` 输出即是用户看到的那行字;
 * 面板那一侧读 `HooksPanel.tsx` 源码,断言它**引用**了这个词条键。不起浏览器、不写盘。
 *
 * Run: scripts/hooks-native-note-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "@renderer/lib/i18n/core.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const KEY = "settings.hooks.nativeNote" as const;
const zh = translate("zh", KEY);
const en = translate("en", KEY);

// ① 词条真的解析出来了(没解析出来时 translate 会原样回吐 key)。
check("zh 词条不是原样回吐的 key(词条真的存在)", zh !== KEY, zh);
check("en 词条不是原样回吐的 key(词条真的存在)", en !== KEY, en);
check("zh 词条非空", zh.trim().length > 0, zh);
check("en 词条非空", en.trim().length > 0, en);

// ② 三件事实在 zh 里都说到了 —— 判据立在用户看到的那行字上。
//    三处都按**完整路径**钉(不是只认 ".mcode" 这种子串:"配置根指到了 ~/.mcode"
//    那句话里也有 `.mcode`,只认子串会让"少了 ~/.mcode/settings.json 那条事实"漏过)。
check("zh:说了本页存到 hooks.json", zh.includes("hooks.json"), zh);
check("zh:点名 ~/.claude/settings.json(那份不生效)", zh.includes("~/.claude/settings.json"), zh);
check("zh:点名 ~/.mcode/settings.json(那条是另一套)", zh.includes("~/.mcode/settings.json"), zh);
check("zh:说清 ~/.claude 那份『不会』在 Mcode 里生效", /不会|不生效/.test(zh), zh);

// ③ en 侧同样把三件事说到(英文界面不能比中文少说事实)。
check("en:说了 hooks.json", en.includes("hooks.json"), en);
check("en:点名 ~/.claude/settings.json", en.includes("~/.claude/settings.json"), en);
check("en:点名 ~/.mcode/settings.json", en.includes("~/.mcode/settings.json"), en);
check("en:说清那份『不会』生效", /not\b.*(fire|apply|take effect)|will not/i.test(en), en);

// ④ 面板真的渲染它 —— 词条在、面板不引用 = 界面上一个字都没有。
{
  const panelSrc = readFileSync(
    join(process.cwd(), "src/renderer/components/settings/HooksPanel.tsx"),
    "utf8",
  );
  check("HooksPanel 引用了这句话(t(…nativeNote))", panelSrc.includes(`t("${KEY}")`), KEY);
}

console.log(`\nhooks-native-note-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
