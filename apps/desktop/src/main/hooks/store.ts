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
import { createHash, randomUUID } from "node:crypto";
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

/**
 * 【MC-051】hooks.json 的**健康分类** —— 读/写/删共用一份判据(仓库硬规矩 2)。
 *
 * 从前 `readRawHooks` 把「读盘异常」「损坏 JSON」「没有有效 hooks 数组」一律降成
 * `null`,而 `commitHooks` 对 `null` 的处理是**直接整份重写** —— 用户手写的损坏
 * 原文被一次普通保存悄悄覆盖,没有备份、没有拒绝。台账点名的坏例。
 *
 * 四态(与插件配置的 `classifyJsonSetting` 同一条纪律):
 *  - `missing`   文件不存在 —— **唯一**允许创建文件的状态;
 *  - `valid`     读得懂(顶层形状对),照常读/合并写;
 *  - `corrupt`   读得到但读不懂(JSON 语法坏 / 顶层形状不对)—— 普通写入**拒绝**,
 *                原字节保全,重建走显式的恢复操作(见 {@link rebuildCorruptHooksFile});
 *  - `read_error` 读不动(existsSync 通过但 readFileSync 抛,如 EACCES)—— 同拒绝。
 */
export type HooksFileHealth =
  | { state: "missing" }
  | { state: "valid"; text: string }
  | { state: "corrupt"; text: string; error: string }
  | { state: "read_error"; error: string };

/** 一处分层的读:文件在 → 读文本 → 判形状。readHooks/readRawHooks/commitHooks 共用。 */
export function classifyHooksFile(): HooksFileHealth {
  const file = hooksFilePath();
  if (!existsSync(file)) return { state: "missing" };
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    return { state: "read_error", error: (err as Error).message };
  }
  const body = stripBom(text);
  if (body.trim().length === 0) return { state: "valid", text }; // 空文件 = 没钩子(与 parseHooksFile 同)
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return { state: "corrupt", text, error: `不是合法的 JSON:${(err as Error).message}` };
  }
  const list = (raw as { hooks?: unknown } | null)?.hooks;
  if (list !== undefined && !Array.isArray(list)) {
    return { state: "corrupt", text, error: "hooks 要是一个数组" };
  }
  if (Array.isArray(list) || Array.isArray(raw)) return { state: "valid", text };
  return { state: "corrupt", text, error: "顶层要是一个钩子数组,或者一个有 hooks 数组的对象" };
}

/** 损坏状态下的保存拒绝语 —— 一处措辞,UI / Agent 看到同一句话(点名怎么恢复)。 */
function corruptRefusal(health: Extract<HooksFileHealth, { state: "corrupt" | "read_error" }>): { ok: false; error: string } {
  const why = health.state === "read_error" ? `读不动:${health.error}` : `读不懂:${health.error}`;
  return {
    ok: false,
    error: `${HOOKS_FILENAME} ${why} —— 为保住你的原始内容,这次保存被拒绝(不是没保存成功,是故意的)。请先直接修好文件;或在设置页用「备份并重建」显式重建(会先把原件备份成 ${HOOKS_FILENAME}.corrupt-<时间>.bak)。`,
  };
}

/** 读全部钩子。**文件不存在、读不了、格式不对都不抛** —— 钩子是附加能力,它坏了
 *  不该让设置页打不开(与 `parseWorkflowDoc` 退化成空文档同一条)。 */
export function readHooks(): HooksFile {
  const health = classifyHooksFile();
  if (health.state === "missing") return { hooks: [], problems: [] };
  if (health.state === "read_error") {
    return {
      hooks: [],
      problems: [{ where: HOOKS_FILENAME, error: `读不了:${health.error}` }],
    };
  }
  return parseHooksFile(health.text);
}

/**
 * 整份写回。**先写临时文件再改名** —— 改名在同一个目录里是原子的,所以任何时刻读到的
 * 都是完整的一份,不会出现"写了一半"的文件。
 *
 * 临时名是固定的(不是随机名):同一时刻只可能有一次保存(设置页一次改一条),而固定
 * 名字让"上次写崩了留下的垃圾"能被下一次覆盖掉。
 *
 * ⚠️ **它写的就是给它的那一份**(不给盘上原来的东西留位置)。`saveHook` / `removeHook`
 * 走的是 {@link commitHooks} —— 那一个会把看不懂的条目搬回去、并在损坏时拒绝;
 * 用这个函数等于"整份重写"(测试夹具与显式重建用它)。
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
 * 调用方必须先过 {@link classifyHooksFile}:只有 `valid` / `missing` 才拿得到数组
 * (missing → 空数组);`corrupt` / `read_error` 由 {@link commitHooks} 在更外层拒掉,
 * 不会走到这里。
 */
function readRawHooks(health: Extract<HooksFileHealth, { state: "missing" | "valid" }>): unknown[] {
  if (health.state === "missing") return [];
  const body = stripBom(health.text);
  // classifyHooksFile accepts an empty/whitespace-only file as valid, and
  // readHooks() treats it as zero hooks. Saving must use that same contract:
  // JSON.parse("") used to throw instead of creating the first hook.
  if (body.trim().length === 0) return [];
  const raw = JSON.parse(body) as unknown;
  const list = (raw as { hooks?: unknown } | null)?.hooks;
  if (Array.isArray(list)) return list;
  // 顶层直接是数组也认 —— 与 `parseHooksFile` 同一条(用户手写最自然的写法),
  // 判据只有一份、住在契约里,这里照着它认。
  return Array.isArray(raw) ? raw : [];
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
 * ## 【MC-051】整份读不懂时**拒绝**,不是重写
 *
 * 从前这里 `raw === null`(整份读不出来)就 `writeRaw(next)` —— 用户手写的损坏原文
 * 被一次普通保存悄悄覆盖,没有备份、没有拒绝。现在按 {@link classifyHooksFile} 分岔:
 *  - `missing` → 唯一允许创建的状态,写新的一份;
 *  - `valid`   → 照旧按序合并(看不懂的条目录在原处);
 *  - `corrupt` / `read_error` → **拒绝**并点名恢复路径(见 {@link corruptRefusal}),
 *    原字节保全 —— 重建必须走显式的 {@link rebuildCorruptHooksFile}(用户授权)。
 *
 * ## 对法
 *
 * 按**顺序**走盘上那份:看懂的那条按 id 替换成新值(被删掉的就跳过,即真的删掉),
 * 看不懂的原样留在那个位置;`next` 里新加的追加在末尾。
 */
function commitHooks(next: HookSpec[]): { ok: true } | { ok: false; error: string } {
  const health = classifyHooksFile();
  if (health.state === "corrupt" || health.state === "read_error") {
    log.warn(`[hooks] 拒绝保存:${HOOKS_FILENAME} ${health.state === "corrupt" ? "损坏" : "读不动"}(${health.error})—— 原文件保持不动`);
    return corruptRefusal(health);
  }
  const raw = readRawHooks(health);

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

/**
 * 【MC-051】**显式**把损坏的 hooks.json 备份并重建 —— 唯一的重建入口,且必须由用户
 * 在界面上点(或经 Agent 的同一通道,见 `ipc/hooks.ts` 的 `hooks:rebuildCorrupt`）。
 *
 * 步骤(顺序有意):读原文 → 写备份 `hooks.json.corrupt-<时间戳>.bak` → **校验备份
 * 与原文 sha256 一致** → 才写新文件。备份写失败 / 校验不过就中止,原文件不动 ——
 * 「重建」这个词承诺的原件保全要靠这一步真的成立。
 *
 * `next` 为空 = 重建出一个空文件(用户想从头写);常用法是先 `readHooks()` 拿到
 * 能看懂的条目再递进来(那些条目本来就被读出来了,不必让用户重打一遍)。
 */
export function rebuildCorruptHooksFile(
  next: HookSpec[] = [],
): { ok: true; backupPath: string } | { ok: false; error: string } {
  const health = classifyHooksFile();
  if (health.state === "missing" || health.state === "valid") {
    // 没坏就没有"重建"这回事 —— 普通保存路径足够(不静默地做用户没要的事)。
    return { ok: false, error: `${HOOKS_FILENAME} 没有损坏,不需要重建(直接普通保存即可)` };
  }
  const originalText = health.state === "corrupt" ? health.text : readOriginalForBackup();
  if (originalText === null) {
    return { ok: false, error: `${HOOKS_FILENAME} 读不动,连备份都做不了 —— 请先处理文件权限` };
  }
  // Never reuse an existing backup name: repeated rebuilds can happen within
  // the same millisecond (or after a restored clock). The exclusive create
  // also protects old backup bytes if a random name ever collides.
  const backupPath = `${hooksFilePath()}.corrupt-${Date.now()}-${randomUUID()}.bak`;
  try {
    writeFileSync(backupPath, originalText, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    return { ok: false, error: `备份写不进去(${backupPath}):${(err as Error).message} —— 未重建,原文件未动` };
  }
  // 校验备份与原文逐字节一致 —— 「先备份再重建」的承诺在这里被核验,不是嘴上说说。
  const digest = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
  let backupText: string;
  try {
    backupText = readFileSync(backupPath, "utf-8");
  } catch (err) {
    return { ok: false, error: `备份写完后读不回来(${backupPath}):${(err as Error).message} —— 未重建,原文件未动` };
  }
  if (digest(backupText) !== digest(originalText)) {
    return { ok: false, error: `备份与原文 sha256 不一致(${backupPath})—— 未重建,原文件未动` };
  }
  // Re-read the authoritative source immediately before replacing it.
  // A user can repair hooks.json in another editor while we prepare its
  // backup. Never use a previously-corrupt snapshot to overwrite healthy or
  // newer bytes. Cross-process writers still need an OS lease/CAS as a
  // separate end-to-end gate; this check closes the deterministic stale read.
  const current = classifyHooksFile();
  if (current.state !== "corrupt" || current.text !== originalText) {
    return { ok: false, error: `${HOOKS_FILENAME} 在备份期间已被外部修改或恢复—— 为保护最新内容,已取消重建;请重新加载后再试(备份位于 ${backupPath})` };
  }
  const written = writeRaw(next);
  if (!written.ok) return { ok: false, error: `重建写失败:${written.error}(原件已备份在 ${backupPath})` };
  log.info(`[hooks] 损坏的 ${HOOKS_FILENAME} 已备份到 ${backupPath} 并重建(${next.length} 条)`);
  return { ok: true, backupPath };
}

/** `read_error` 状态下尽力读一次原文(给备份用);读不到返回 null。 */
function readOriginalForBackup(): string | null {
  try {
    return readFileSync(hooksFilePath(), "utf-8");
  } catch {
    return null;
  }
}

/**
 * 新增或覆盖一条(按 id)。
 *
 * 【MC-051】**文件整体损坏时这条会拒绝**(`ok:false` + 点名恢复路径)—— 那正是
 * 「用户手写崩了、保存又把它盖掉」那条坏例的正面。拒绝不是没保存成功,是**故意的**:
 * 原字节必须有人先看过、点过「备份并重建」({@link rebuildCorruptHooksFile})才动。
 */
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
  // A corrupt file can parse as zero usable hooks, but removing an unknown id
  // is NOT a successful operation in that state. Surface the same refusal as
  // saveHook/commitHooks even when the target does not occur in the list.
  const health = classifyHooksFile();
  if (health.state === "corrupt" || health.state === "read_error") return corruptRefusal(health);
  const { hooks } = readHooks();
  const next = hooks.filter((h) => h.id !== id);
  if (next.length === hooks.length) return { ok: true };
  return commitHooks(next);
}
