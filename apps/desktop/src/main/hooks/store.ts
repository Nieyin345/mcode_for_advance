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
import { parseHooksFile, stripBom, validateHook, type HookSpec, type HooksFile } from "@contracts/hook";
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
 *
 * ⚠️ **它写的就是给它的那一份**(不给盘上原来的东西留位置)。`saveHook` / `removeHook`
 * 走的是 {@link commitHooks} —— 那一个会把看不懂的条目搬回去。用这个函数等于"整份重写"。
 */
export function writeHooks(hooks: HookSpec[]): { ok: true } | { ok: false; error: string } {
  return writeRaw(hooks);
}

/** {@link writeHooks} 的底层:收**原始**条目(可能是我们看不懂的那些),不只是 `HookSpec`。 */
function writeRaw(items: readonly unknown[]): { ok: true } | { ok: false; error: string } {
  const file = hooksFilePath();
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: HOOKS_FILE_VERSION, hooks: items }, null, 2), "utf-8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    log.warn(`[hooks] 写不进去(${file}):${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 盘上那个数组的**原始**内容 —— 没解析过、没过滤过,一个条目就是一个元素。
 *
 * `null` = 整份读不出来(不是 JSON、或者顶层形状不对)。那种情况下没有"剩下的照原样搬
 * 回去"这回事 —— 只能整份重写(见 {@link commitHooks})。
 */
function readRawHooks(): unknown[] | null {
  const file = hooksFilePath();
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    // BOM 同 `parseHooksFile`:这里若读不出来就会走“整份重写”,把用户手写的内容全盖掉。
    raw = JSON.parse(stripBom(readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
  const list = (raw as { hooks?: unknown } | null)?.hooks;
  if (Array.isArray(list)) return list;
  // 顶层直接是数组也认 —— 与 `parseHooksFile` 同一条(用户手写最自然的写法),
  // 判据只有一份、住在契约里,这里照着它认。
  return Array.isArray(raw) ? raw : null;
}

/** 这一条我们看懂了吗。看懂了给 `HookSpec`,看不懂(或只是个我们认不出的形状)给 `null`。
 *
 *  ⚠️ 判据**复用契约那一份**(`parseHooksFile`),不在这儿手写第二份 —— 两份判据迟早
 *  分家,而分家的表现是"读的时候报出来了、存的时候又当成好的搬回去了"。 */
function understoodOrNull(item: unknown): HookSpec | null {
  const one = parseHooksFile(JSON.stringify({ hooks: [item] }));
  return one.hooks.length === 1 ? one.hooks[0] : null;
}

/**
 * 把"看得懂的那一份"(`next`)写回去,**同时把盘上看不懂的条目录在原处**。
 *
 * ## 为什么不能直接 `writeHooks(next)`
 *
 * `readHooks()` 把坏条目挡在 `problems` 里、不放进 `hooks`(那是对的:坏条目不该跑)。
 * 但**保存一次就照着它整份重写**的话,用户亲手写坏的那一行会被**顺手删掉** ——
 * 界面上明明还列着"第 2 条:xxx 不对",一存就没了。这个文件是**用户直接改的**(那是
 * 把它放成文件的意义),删他写的东西得他自己动手,不是我们保存一次就替他清掉。
 *
 * 顺带:`readHooks` 与"下一次保存"是**两个时刻**,中间用户可能正在编辑器里改这个文件。
 * 搬回去比覆盖更接近"只动我改的那一条"。
 *
 * ## 对法
 *
 * 按**顺序**走盘上那份:看懂的那条按 id 替换成新值(被删掉的就跳过,即真的删掉),
 * 看不懂的原样留在那个位置;`next` 里新加的追加在末尾。
 */
function commitHooks(next: HookSpec[]): { ok: true } | { ok: false; error: string } {
  const raw = readRawHooks();
  // 整份读不出来 —— 搬不回去,只能写成新的一份。原内容靠 `readHooks` 报出的那条
  // problem 说话,不在这儿假装能保住。
  if (raw === null) return writeRaw(next);

  const byId = new Map(next.map((spec) => [spec.id, spec]));
  const claimed = new Set<string>();
  const merged: unknown[] = [];
  for (const item of raw) {
    const understood = understoodOrNull(item);
    // 看不懂的、**以及同一个 id 的第二份**(`readHooks` 只留第一条)→ 原样留着。
    if (understood === null || claimed.has(understood.id)) {
      merged.push(item);
      continue;
    }
    claimed.add(understood.id);
    const replacement = byId.get(understood.id);
    // 覆盖:换成新值(**留在原位置**)。删掉:不写回去。
    if (replacement !== undefined) merged.push(replacement);
  }
  // 新加的排在末尾 —— 和"push 到列表末尾"是同一个位置。
  for (const spec of next) if (!claimed.has(spec.id)) merged.push(spec);
  return writeRaw(merged);
}

/** 新增或覆盖一条(按 id)。 */
export function saveHook(spec: HookSpec): { ok: true } | { ok: false; error: string } {
  const check = validateHook(spec);
  if (!check.ok) return check;
  const { hooks } = readHooks();
  const index = hooks.findIndex((h) => h.id === spec.id);
  if (index >= 0) hooks[index] = spec;
  else hooks.push(spec);
  return commitHooks(hooks);
}

/**
 * 删一条。**找不到也算成功**(想要的结局已经在了)。
 *
 * ⚠️ 注意它读的是 `readHooks()` 过滤后的列表 —— 一条格式坏、被 `problems` 挡下的条目
 * 不在里面,所以**删不掉**。这是对的:那种条目的问题在格式,而"删掉它"要靠直接改文件
 * (页面上也把它的位置说出来了)。
 *
 * 删的时候其它**看不懂的条目照旧留着**(见 {@link commitHooks})—— "删掉我看懂的那一条"
 * 不该顺手带走旁边那条我还没看懂的。
 */
export function removeHook(id: string): { ok: true } | { ok: false; error: string } {
  const { hooks } = readHooks();
  const next = hooks.filter((h) => h.id !== id);
  if (next.length === hooks.length) return { ok: true };
  return commitHooks(next);
}
