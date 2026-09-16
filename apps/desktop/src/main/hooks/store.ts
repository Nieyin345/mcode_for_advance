/**
 * 钩子的落盘 —— `<数据根>/hooks.json`。
 *
 * ## 为什么是一个文件,不是数据库里的一张表
 *
 * 钩子是**用户能读懂、能自己改、也想让 AI 帮忙写**的东西(和节点类型清单同一个性质),
 * 而数据库里的那张表只有这个应用读得懂。放成数据根下的一个 JSON,用户想批量改、想
 * 拷给别人、想让 AI 直接写,都不用经过界面。
 *
 * 数据库那边存的是"状态"(会话、消息、用量),这边存的是**内容** —— 和
 * `<数据根>/workflows/node-types/` 是同一个判断。
 *
 * ## 格式规则不在这里
 *
 * "什么算合法、坏条目怎么办"在 `@contracts/hook` 的 `parseHooksFile` 里 —— 那是一条
 * **对外承诺**(这个文件是用户直接改的),而且纯函数才喂得进无头脚本。这一层只负责
 * 文件系统:读文本、写文本。
 *
 * ## 写入是"整份重写 + 改名"
 *
 * 这个文件很小(几十条),而**部分写入**要处理"改到一半崩了"的中间态。整份重写、先写
 * 临时文件再改名更简单也更安全:要么是旧的完整内容,要么是新的完整内容。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHooksFile, validateHook, type HookSpec, type HooksFile } from "@contracts/hook";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";

const HOOKS_FILENAME = "hooks.json";

/** 文件格式版本。将来改结构时,老文件能被认出来并给出可读的提示。 */
const HOOKS_FILE_VERSION = 1;

export function hooksFilePath(): string {
  return join(dataRoot(), HOOKS_FILENAME);
}

/** 读全部钩子。**文件不存在、读不了、格式不对都不抛** —— 钩子是附加能力,它坏了
 *  不该让设置页打不开(与 `parseWorkflowDoc` 退化成空文档同一条)。 */
export function readHooks(): HooksFile {
  const file = hooksFilePath();
  if (!existsSync(file)) return { hooks: [], problems: [] };
  try {
    return parseHooksFile(readFileSync(file, "utf-8"));
  } catch (err) {
    return {
      hooks: [],
      problems: [{ where: HOOKS_FILENAME, error: `读不了:${(err as Error).message}` }],
    };
  }
}

/**
 * 整份写回。**先写临时文件再改名** —— 改名在同一个目录里是原子的,所以任何时刻读到的
 * 都是完整的一份,不会出现"写了一半"的文件。
 *
 * 临时名是固定的(不是随机名):同一时刻只可能有一次保存(设置页一次改一条),而固定
 * 名字让"上次写崩了留下的垃圾"能被下一次覆盖掉。
 */
export function writeHooks(hooks: HookSpec[]): { ok: true } | { ok: false; error: string } {
  const file = hooksFilePath();
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: HOOKS_FILE_VERSION, hooks }, null, 2), "utf-8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    log.warn(`[hooks] 写不进去(${file}):${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/** 新增或覆盖一条(按 id)。 */
export function saveHook(spec: HookSpec): { ok: true } | { ok: false; error: string } {
  const check = validateHook(spec);
  if (!check.ok) return check;
  const { hooks } = readHooks();
  const index = hooks.findIndex((h) => h.id === spec.id);
  if (index >= 0) hooks[index] = spec;
  else hooks.push(spec);
  return writeHooks(hooks);
}

/**
 * 删一条。**找不到也算成功**(想要的结局已经在了)。
 *
 * ⚠️ 注意它读的是 `readHooks()` 过滤后的列表 —— 一条格式坏、被 `problems` 挡下的条目
 * 不在里面,所以**删不掉**。这是对的:那种条目的问题在格式,而"删掉它"要靠直接改文件
 * (页面上也把它的位置说出来了)。
 */
export function removeHook(id: string): { ok: true } | { ok: false; error: string } {
  const { hooks } = readHooks();
  const next = hooks.filter((h) => h.id !== id);
  if (next.length === hooks.length) return { ok: true };
  return writeHooks(next);
}
