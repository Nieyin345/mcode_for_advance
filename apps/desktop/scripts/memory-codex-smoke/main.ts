/**
 * Headless smoke for **`main/ipc/memory.ts`**(记忆库 IPC)与 **`main/ipc/codexModels.ts`**
 * (Codex 第三方供应商 IPC),外加 `main/ipc/index.ts` 那座总注册表。
 *
 * ## 为什么单独一套:这两个文件原来是零覆盖
 *
 * `memory-smoke` 覆盖的是**存储层**的三个纯模块(store / retrieval / maintenance);
 * `ipc-parity-smoke` / `ipc-wiring-smoke` 是**读源码文本**验三层对不对得上。这两个
 * handler 文件本身——也就是用户真正按下去的那条路——两边都没碰过。所以这里走
 * **真的 handler**:`ipcMain` 的记名替身 + 按 channel 取回注册进去的真函数。
 *
 * ## 四块
 *
 *  1. **记忆库**:存→读同一个内容、删了真没了、题目沿用/盖章;两个无参 handler
 *     (`memory:list` 不传参、`memory:categories`)不许因为 `raw === undefined` 抛。
 *  2. **路径穿越**:`../../x.md`、`..\\..\\x.md`、`C:\\Windows\\x.md`、`/etc/x.md`、
 *     驱动相对写法 `C:x.md`、`rules/../x.md`、符号链接指向库外 —— **一条都不许
 *     写到记忆库根外面**,而且**不许在数据根里留下任何东西**。这是本套最重要的一组。
 *  3. **Codex 供应商**:list 出的每一项**绝不许带明文 Key**(只有 `hasApiKey`);
 *     save 之后 `config.toml` 真的重生成、且**不含**那把 Key;delete 之后供应商与
 *     Key 都没了;`getApiKey` 对不存在的 id 不许抛。
 *  4. **总注册表**:`registerIpcHandlers()` 真的跑一遍(整座 import 图都在别的桩上),
 *     断言注册表与 `IPC` 常量对得上、没有重复注册、两个无参 channel 传 `undefined`
 *     也走得到 handler,以及 `createDbGuardedIpc` 真的把 `awaitDb()` 挡在 handler 前面。
 *
 * ## 它不碰用户的真东西
 *
 * 数据根 = `mktemp -d`;`homedir()` 也被指到那个临时目录(`config.toml` 落在
 * `<临时目录>/.mcode/codex/`),跑完连目录一起删。见 `run.sh` 与 `stubs/dataRoot.ts`。
 *
 * Run: scripts/memory-codex-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { MemoryFileMeta } from "@contracts/memory";
import type { IpcMain } from "electron";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** `Object.is` 比不了数组 —— 断"集合里正好是这几个"用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/**
 * 数据根。`run.sh` 已经 `export MCODE_SMOKE_DATA_ROOT`(桩里没设就抛),这里再兜一层:
 * 万一有人直接 `node` 跑打包产物,也得有个能负责任的临时目录,而不是回落到真库。
 */
const DATA = process.env.MCODE_SMOKE_DATA_ROOT ?? mkdtempSync(join(tmpdir(), "mcode-memcodex-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
const DATA_ABS = resolve(DATA);
const MEMORY_ROOT = join(DATA_ABS, "memory");

/**
 * `IPC` 表里那些**只往渲染端推**的渠道(主进程侧压根不该有 handler)。
 *
 * 这份名单不是手抄的:它等于「`IPC` 常量表 **减去** `registerIpcHandlers()` 真的注册进去的
 * 那些」,而上面那条断言断的就是这个等式。手抄那 21 个名字是为了让失败信息里能看见
 * **差的是哪几条**;真值以注册表为准。
 *
 * 主进程侧的发送方散在各处(`sendToRenderer` / `webContents.send`),所以"每一条都真
 * 有人发"这件事归 `ipc-parity-smoke`(它从 preload 的 `ipcRenderer.on` 那份名单反推)。
 */
const PUSH_CHANNELS = [
  "browser:event",
  "claude:event",
  "composer:attach",
  "library:changed",
  "lsp:event",
  "market:progress",
  "relay:event",
  "runtimes:event",
  "session:titleUpdated",
  "terminal:data",
  "terminal:exit",
  "theme:changed",
  "toolchain:event",
  "update:available",
  "update:downloadProgress",
  "update:downloaded",
  "voice:downloadProgress",
  "voice:result",
  "window:focusChanged",
  "workflow:changed",
].sort();

/** 这个路径是不是落在数据根里(`..` 穿不出去的判据)。 */
function insideDataRoot(p: string): boolean {
  const abs = resolve(p);
  return abs === DATA_ABS || abs.startsWith(DATA_ABS + sep);
}

/** 数据根下每一个文件/目录的数据根源相对路径(含目录,不含数据根自己)。 */
function snapshotDataRoot(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      out.push(resolve(p).slice(DATA_ABS.length + 1));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(DATA_ABS);
  return out.sort();
}

/* ──────────────── 0. 把真 handler 取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-trash-smoke` 的办法)。
 *
 * 这两个文件要验的判据整个住在 handler 的**函数体**里(`.parse()` 那一句、list 的
 * 投影、catch 里回什么),而它们从来不是导出符号 —— 唯一拿得到的办法就是调
 * `registerMemoryHandlers` / `registerCodexModelsHandlers`,把注册进来的函数按
 * channel 收下来。
 *
 * ⚠️ 这里的替身**不**替 `registerIpcHandlers()` 那个(它从 `electron` 直接 import
 * `ipcMain`,见 stubs/electron.ts 的 `registeredChannels`)——两个方向各有一套,
 * 因为 §4 要验的正是"总注册表包的那一层"。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORIES_CHANNEL,
  MEMORY_DELETE_CHANNEL,
  MEMORY_LIST_CHANNEL,
  MEMORY_READ_CHANNEL,
  MEMORY_SAVE_CHANNEL,
} = await import("@contracts/memory");
const { registerMemoryHandlers } = await import("@main/ipc/memory.js");
const { registerCodexModelsHandlers } = await import("@main/ipc/codexModels.js");
const { codexHomePath, codexKeyEnvVar } = await import("@main/lib/codexModelsStore.js");

registerMemoryHandlers(fakeIpc);
registerCodexModelsHandlers(fakeIpc);

const { initDb, awaitDb } = await import("@main/store/db.js");
await initDb();

/** 调一条真的 handler。`raw` 一律显式给(要验的就是"传了 undefined 会怎样")。 */
function call(channel: string, raw?: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel} 的 handler`);
  return Promise.resolve(fn(null, raw));
}

check("拿到了 memory 的五个 handler", handlers.has(MEMORY_CATEGORIES_CHANNEL));
for (const ch of [MEMORY_LIST_CHANNEL, MEMORY_READ_CHANNEL, MEMORY_SAVE_CHANNEL, MEMORY_DELETE_CHANNEL]) {
  check(`拿到了 ${ch} 的 handler`, handlers.has(ch));
}
for (const ch of [
  IPC.CODEX_MODELS_LIST,
  IPC.CODEX_MODELS_SAVE,
  IPC.CODEX_MODELS_DELETE,
  IPC.CODEX_MODELS_GET_API_KEY,
]) {
  check(`拿到了 ${ch} 的 handler`, handlers.has(ch));
}

/* ──────────────── 1. 记忆库:存 / 读 / 删 ──────────────── */

const BODY = "引用一律用 APA。\n第二行也得原样回来。";

console.log("\n记忆库:出参形状必须跟契约一致(这三个原来全错)");

/**
 * ⚠️ 这一组是整套里最"像抄契约"的地方,而它恰好钉住了三个**面板上真的看得见**的
 * 故障。契约写在 `RpcMap` 上(`packages/contracts/src/ipc/rpcMap.ts` 的 `memory.*`),
 * preload 只是转发、面板只读契约里那几个键 —— 而 `main/ipc/memory.ts` 原来转的是
 * **store 的返回值**,两套形状不一样:
 *
 *   - `memory:list` 要 `{ files: [...] }`,原来转裸数组 → 面板 `res.files` 是
 *     `undefined`、`for (const f of undefined)` 抛 → **设置→记忆库整块打不开**。
 *   - `memory:save` 要 `{ ok: boolean }`,原来转 `{ updatedAt }` → 面板 `res.ok`
 *     是 `undefined`,**每一次成功保存都显示「错误」**,而「有改动还没保存」永远不消。
 *   - `memory:delete` 要 `{ ok, error? }` 而不是"抛"(契约自己写的:
 *     "`ok: false` 时 `error` 是给人看的句子,不是异常")。
 */
{
  const saved = (await call(MEMORY_SAVE_CHANNEL, { path: "rules/cite.md", content: BODY, title: "引用规范" })) as {
    ok?: unknown;
    updatedAt?: unknown;
  };
  eq("memory:save 回形状跟契约一致(ok: true)", saved.ok, true);
  check("...(而不是把 store 的 updatedAt 直接转出去)", saved.updatedAt === undefined, saved);

  const read1 = (await call(MEMORY_READ_CHANNEL, { path: "rules/cite.md" })) as { content: string; revision: string };
  eq("读回来的是存进去的那段正文(不含 frontmatter)", read1.content, BODY);

  // 契约原文:"读一条记忆的正文(含 frontmatter 原文)"—— store 吐的是分隔行之后
  // 那一整段,前面带着一个换行;写回去时 store 会 `trimEnd`。一读一存就长一个空行,
  // 用户在编辑器里点三次保存,正文前面就多出三个空行。
  const r2 = (await call(MEMORY_READ_CHANNEL, { path: "rules/cite.md" })) as { content: string; revision: string };
  await call(MEMORY_SAVE_CHANNEL, { path: "rules/cite.md", content: r2.content, expectedRevision: r2.revision });
  const r3 = (await call(MEMORY_READ_CHANNEL, { path: "rules/cite.md" })) as { content: string; revision: string };
  eq("读出来再原样存回去,正文不长胖(不多空行)", r3.content, r2.content);

  const savedFile = readFileSync(join(MEMORY_ROOT, "rules", "cite.md"), "utf8");
  check("文件真的落在 <数据根>/memory/rules/ 下", insideDataRoot(join(MEMORY_ROOT, "rules", "cite.md")));
  check("frontmatter 里写进了标题", savedFile.includes(`title: "引用规范"`), savedFile.split("\n").slice(0, 4));
  check("frontmatter 里写进了 updatedAt", /updatedAt: \d+/.test(savedFile), savedFile.split("\n").slice(0, 4));
  check("正文里没有多出来的空行", savedFile.endsWith(`---\n\n${BODY}\n`), JSON.stringify(savedFile));

  // 第二次保存不传标题 → 沿用旧标题(文件即事实源,人手改的标题不能被一次正文保存抹掉)。
  await call(MEMORY_SAVE_CHANNEL, { path: "rules/cite.md", content: "改过的正文", expectedRevision: r3.revision });
  check("再存一次且不传标题时,旧标题被沿用", readFileSync(join(MEMORY_ROOT, "rules", "cite.md"), "utf8").includes(`title: "引用规范"`));

  const list = (await call(MEMORY_LIST_CHANNEL, { category: "rules" })) as {
    files?: MemoryFileMeta[];
  };
  check("memory:list 回形状跟契约一致(有 files 那一层)", Array.isArray(list.files), list);
  same("list 里能看到这一条", list.files?.map((f) => f.path), ["rules/cite.md"]);
  eq("list 的标题来自 frontmatter", list.files?.[0]?.title, "引用规范");
  eq("list 的行带类目", list.files?.[0]?.category, "rules");
  check("list 的 updatedAt 是个数", typeof list.files?.[0]?.updatedAt === "number", list.files?.[0]);

  const all = (await call(MEMORY_LIST_CHANNEL, {})) as { files: unknown[] };
  eq("不按类目过滤时也只看得到这一条", all.files.length, 1);
  const noArg = (await call(MEMORY_LIST_CHANNEL)) as { files: unknown[] };
  eq("不给参数时列的是全部类目(parse(raw ?? {}))", noArg.files.length, 1);

  const beforeDelete = await call(MEMORY_READ_CHANNEL, { path: "rules/cite.md" }) as { revision: string };
  const del = (await call(MEMORY_DELETE_CHANNEL, { path: "rules/cite.md", expectedRevision: beforeDelete.revision })) as { ok?: unknown };
  eq("memory:delete 回形状跟契约一致(ok: true)", del.ok, true);
  check("删了之后文件真没了", !existsSync(join(MEMORY_ROOT, "rules", "cite.md")));
  const afterDelete = (await call(MEMORY_LIST_CHANNEL, {})) as { files: unknown[] };
  eq("删了之后 list 里也没有了", afterDelete.files.length, 0);

  // 删除是幂等的:本来就不在也算成功(用户在两个窗口里各按一次不该报错)。
  const idempotent = (await call(MEMORY_DELETE_CHANNEL, { path: "rules/cite.md" })) as { ok?: unknown };
  eq("删一个本来就不存在的文件也算成功(幂等)", idempotent.ok, true);
}

/* Real IPC boundary: revisions must survive schema parsing and response projection. */
{
  const path = "decisions/ipc-cas.md";
  const create = await call(MEMORY_SAVE_CHANNEL, { path, content: "first", expectedRevision: null }) as { ok: boolean; revision?: string };
  check("IPC保存返回新版本", create.ok && !!create.revision);
  const read = await call(MEMORY_READ_CHANNEL, { path }) as { content: string; revision: string };
  eq("IPC读取版本与保存一致", read.revision, create.revision);
  const update = await call(MEMORY_SAVE_CHANNEL, { path, content: "second", expectedRevision: read.revision }) as { ok: boolean; revision?: string };
  check("IPC接收版本并允许正常更新", update.ok && update.revision !== read.revision);
  const stale = await call(MEMORY_SAVE_CHANNEL, { path, content: "stale", expectedRevision: read.revision }) as { ok: boolean; code?: string };
  check("IPC旧版本返回可识别冲突", !stale.ok && stale.code === "conflict");
  const blind = await call(MEMORY_SAVE_CHANNEL, { path, content: "blind" }) as { ok: boolean; code?: string };
  check("旧客户端无版本不能静默覆盖", !blind.ok && blind.code === "conflict");
  const conflict = await call(MEMORY_DELETE_CHANNEL, { path, expectedRevision: read.revision }) as { ok: boolean; code?: string };
  check("IPC删除使用确认时的旧版本并被拒绝", !conflict.ok && conflict.code === "conflict");
  eq("冲突后正文保持最新", (await call(MEMORY_READ_CHANNEL, { path }) as { content: string }).content, "second");
  eq("IPC最新版本允许删除", (await call(MEMORY_DELETE_CHANNEL, { path, expectedRevision: update.revision }) as { ok: boolean }).ok, true);
}

console.log("\n记忆库:两个无参 handler");

{
  // preload 的 `categories: () => ipcRenderer.invoke(IPC.MEMORY_CATEGORIES)` **不带参数**,
  // 而 `createDbGuardedIpc` 转手时 `raw` 就是 `undefined`。handler 里没有 `?? {}`。
  let cats: unknown = null;
  let catsThrew = "";
  try {
    cats = await call(MEMORY_CATEGORIES_CHANNEL);
  } catch (err) {
    catsThrew = (err as Error).message;
  }
  check("memory:categories 一个参数都不给也不抛", catsThrew === "", catsThrew);
  same("给回来的正好是契约里那六类", cats, [...MEMORY_CATEGORIES]);
}

/* ──────────────── 2. 路径穿越:一条都不许穿出去 ──────────────── */

console.log("\n路径穿越:一条都不许写到记忆库根外面");

/**
 * 穿越用例。**每条都断言两件事**:
 *
 *  1. 被拒了 —— `read` 是抛(它没有 `ok` 这条路),`save` / `delete` 按契约
 *     `{ ok: false }` + 一句给人看的话;两者都不许漏出 ENOENT / EPERM 那种内形状。
 *  2. **数据根里一个字节都没多出来。**
 *
 * `C:x.md` 那一行是这套里最不直观的一条:`isAbsolute("C:x.md")` 在 win32 上是
 * **false**(它没有根分隔符),所以第一道闸放它过去,靠的是 resolve 之后的前缀比对。
 * 实测未修版也是拒的 —— 但那是 `C:\x.md` 正好不在白名单类目里,纯属侥幸,所以留着。
 */
const TRAVERSAL: Array<{ label: string; path: string }> = [
  { label: "../../etc/passwd", path: "../../etc/passwd" },
  { label: "..\\..\\x.md(反斜杠写法)", path: "..\\..\\x.md" },
  { label: "C:\\Windows\\x.md(绝对路径)", path: "C:\\Windows\\x.md" },
  { label: "/etc/x.md(绝对路径)", path: "/etc/x.md" },
  { label: "C:x.md(win32 驱动相对写法)", path: "C:x.md" },
  { label: "rules/../x.md(从类目里往上爬)", path: "rules/../x.md" },
  { label: "rules/../../x.md(爬两级)", path: "rules/../../x.md" },
  { label: "rules/../rules/x.md(爬回同一个目录)", path: "rules/../rules/x.md" },
  { label: "rules/.\\x.md(前导反斜杠)", path: "rules/.\\x.md" },
  { label: "rules/sub/x.md(多一段子目录)", path: "rules/sub/x.md" },
  { label: "rules/.hidden.md(点开头)", path: "rules/.hidden.md" },
  { label: "rules/..md(名字只剩个点)", path: "rules/..md" },
  { label: "rules/x.txt(不是 .md)", path: "rules/x.txt" },
  { label: "nope/x.md(类目不在白名单)", path: "nope/x.md" },
  { label: "rules/x.md\u0000.txt(NUL 截断)", path: "rules/x.md\u0000.txt" },
  { label: "rules//x.md(空段)", path: "rules//x.md" },
  { label: "/rules/x.md(前面多个斜杠)", path: "/rules/x.md" },
  { label: "rules/x.md/(尾随斜杠)", path: "rules/x.md/" },
  { label: "rules\\cite.md(反斜杠当分隔符)", path: "rules\\cite.md" },
];

/** 「被拒了」的统一判据:抛了也好、回了 `ok: false` 也好,总之不许算成功。 */
function rejected(out: unknown): boolean {
  return typeof out === "object" && out !== null && (out as { ok?: unknown }).ok === false;
}

{
  const before = snapshotDataRoot();
  for (const { label, path } of TRAVERSAL) {
    for (const [verb, channel] of [
      ["save", MEMORY_SAVE_CHANNEL],
      ["read", MEMORY_READ_CHANNEL],
      ["delete", MEMORY_DELETE_CHANNEL],
    ] as const) {
      let threw = "";
      let out: unknown = null;
      try {
        out = await call(channel, verb === "save" ? { path, content: "被穿越进来的内容" } : { path });
      } catch (err) {
        threw = (err as Error).message;
      }
      // 拒绝是对的,但**必须是一条说得出口的理由**,不能是 ENOENT 之类漏出来的内部形状。
      const said = threw.includes("不是合法的记忆路径") || rejected(out);
      check(`${verb} 「${label}」被拒且理由是给人看的`, said, { path, threw, out });
    }
  }
  same("这一轮穿越没在数据根里留下任何东西", snapshotDataRoot(), before);
}

// 形状对但名字里带分隔符的另一种写法:类目/文件名 两段里塞了空段,靠 split 得到 3 段。
{
  const before = snapshotDataRoot();
  for (const p of ["rules//x.md", "/rules/x.md", "rules/x.md/", "rules\\cite.md"]) {
    let threw = "";
    let out: unknown = null;
    try {
      out = await call(MEMORY_SAVE_CHANNEL, { path: p, content: "x" });
    } catch (err) {
      threw = (err as Error).message;
    }
    check(`「${p}」被拒`, threw.includes("不是合法的记忆路径") || rejected(out), { path: p, threw, out });
  }
  same("这几种写法也没留下东西", snapshotDataRoot(), before);
}

console.log("\n拒绝要说出口,而不是抛出去");

/**
 * 契约里 `memory.save` / `memory.delete` 的备注写得很清楚:
 * "`ok: false` 时 `error` 是给人看的句子,**不是异常**" —— 面板也是照着读的
 * (`res.error ?? t("common.error")`)。所以"路径不合法"在这两条上必须走
 * `{ ok: false, error: <那句给人看的话> }` 这条**返回值**的路,而不是抛。
 *
 * ⚠️ 上面那一组穿越断言收的是"抛了**或者** ok:false"—— 它验的是"拒了",验不了
 * "用哪种方式拒的"。把这两条单独拎出来,就是为了钉住后者:`main/ipc/memory.ts`
 * 那两句 `try/catch` 谁拆掉,这里就红。
 */
{
  const BAD = "../../etc/passwd";

  /** 调一条"契约说好回 `{ ok, error? }`、不该抛"的 handler;抛了就当成一次失败报出来。 */
  async function expectRefusal(
    label: string,
    channel: string,
    raw: unknown,
  ): Promise<void> {
    let threw = "";
    let out: { ok?: unknown; error?: unknown } | null = null;
    try {
      out = (await call(channel, raw)) as { ok?: unknown; error?: unknown };
    } catch (err) {
      threw = (err as Error).message;
    }
    check(
      `${label}拒绝时回的是 ok: false,不是抛`,
      threw === "" && out?.ok === false,
      { threw, out },
    );
    check(
      `${label}拒绝时带一句给人看的理由`,
      typeof out?.error === "string" && out.error.includes("不是合法的记忆路径"),
      { threw, out },
    );
  }

  await expectRefusal("save", MEMORY_SAVE_CHANNEL, { path: BAD, content: "x" });
  await expectRefusal("delete", MEMORY_DELETE_CHANNEL, { path: BAD });

  // 读没有 `ok` 这条路(契约是 `{ content: string }`),所以它**只能**抛 —— 抛得对。
  let readThrew = "";
  try {
    await call(MEMORY_READ_CHANNEL, { path: BAD });
  } catch (err) {
    readThrew = (err as Error).message;
  }
  check("read 没有 ok 那条路,所以照契约抛一句给人看的话", readThrew.includes("不是合法的记忆路径"), readThrew);
}

/**
 * 词法检查挡不住的那一类:**符号链接**。
 *
 * `resolve()` 是纯词法的,不碰磁盘 —— `memory/rules/linked.md` 是个指向库外的符号
 * 链接时,前三道闸(两段、白名单、`.md`、前缀比对)全过。于是 `read` 会把库外的
 * 文件读出来、`save` 会把库外的文件**覆盖掉**。
 *
 * 这组现在是**硬回归**：read / list / save / delete 四条路都必须把符号链接挡在
 * 存储层外面。只钉 save 不够 —— 越权读取同样会把库外内容送进模型上下文；只钉
 * read/save 也不够 —— list 如果把链接当成普通记忆列出来，后续工具仍可能反复撞它。
 */
{
  const outside = join(DATA_ABS, "outside-secret.md");
  writeFileSync(outside, "库外的东西,不该被记忆库读出来", "utf8");
  const linkDir = join(MEMORY_ROOT, "rules");
  mkdirSync(linkDir, { recursive: true });
  const link = join(linkDir, "linked.md");
  let linked = true;
  try {
    rmSync(link, { force: true });
    symlinkSync(outside, link, "file");
  } catch {
    linked = false; // 没权限建符号链接(未开开发者模式的 Windows)—— 这一类跳过
  }

  if (!linked) {
    console.log("  ..   (这台机器建不了符号链接,跳过这一整类;上面 19 条词法用例已覆盖到那四道闸)");
  } else {
    let readOut = "";
    let readThrew = "";
    try {
      readOut = ((await call(MEMORY_READ_CHANNEL, { path: "rules/linked.md" })) as { content: string }).content;
    } catch (err) {
      readThrew = (err as Error).message;
    }
    check(
      "指向库外的符号链接**读不到**库外文件",
      readThrew.includes("不是合法的记忆路径") && !readOut.includes("库外的东西"),
      { readThrew, readOut },
    );
    const linkedList = (await call(MEMORY_LIST_CHANNEL, { category: "rules" })) as { files: MemoryFileMeta[] };
    check(
      "指向库外的符号链接不会混进记忆列表",
      !linkedList.files.some((f) => f.path === "rules/linked.md"),
      linkedList.files,
    );

    let writeThrew = "";
    let writeOut: unknown = null;
    try {
      writeOut = await call(MEMORY_SAVE_CHANNEL, { path: "rules/linked.md", content: "写到库外去了" });
    } catch (err) {
      writeThrew = (err as Error).message;
    }
    const outsideAfter = readFileSync(outside, "utf8");
    check(
      "指向库外的符号链接**写不坏**库外的文件",
      !outsideAfter.includes("写到库外去了"),
      { writeThrew, writeOut, outsideAfter },
    );
    const deleteOut = (await call(MEMORY_DELETE_CHANNEL, { path: "rules/linked.md" })) as {
      ok?: unknown;
      error?: unknown;
    };
    check(
      "delete 也拒绝符号链接路径",
      deleteOut.ok === false && existsSync(link),
      deleteOut,
    );
    rmSync(link, { force: true });
  }
  rmSync(outside, { force: true });
  rmSync(linkDir, { recursive: true, force: true });
}

// Windows 上普通文件 symlink 往往需要开发者模式，但目录 junction 不需要。
// 这一组保证 CI/本机至少能真的跑到一次“重解析到 memory 根外”的 I/O 路径。
{
  const outsideDir = join(DATA_ABS, "outside-memory-dir");
  const outsideFile = join(outsideDir, "escaped.md");
  const linkDir = join(MEMORY_ROOT, "rules");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(outsideFile, "junction 外的内容", "utf8");
  rmSync(linkDir, { recursive: true, force: true });
  mkdirSync(MEMORY_ROOT, { recursive: true });
  let junction = true;
  try {
    symlinkSync(outsideDir, linkDir, "junction");
  } catch {
    junction = false;
  }

  if (!junction) {
    console.log("  ..   (这台机器也建不了 junction，跳过目录重解析用例)");
  } else {
    let readThrew = "";
    try {
      await call(MEMORY_READ_CHANNEL, { path: "rules/escaped.md" });
    } catch (err) {
      readThrew = (err as Error).message;
    }
    check("junction 类目目录不能越权读取", readThrew.includes("不是合法的记忆路径"), readThrew);

    const listed = (await call(MEMORY_LIST_CHANNEL, { category: "rules" })) as { files: MemoryFileMeta[] };
    check("junction 类目目录不会被 list 展开", listed.files.length === 0, listed.files);

    const saved = (await call(MEMORY_SAVE_CHANNEL, { path: "rules/escaped.md", content: "不该写出去" })) as { ok?: unknown };
    check("junction 类目目录不能越权写入", saved.ok === false && readFileSync(outsideFile, "utf8") === "junction 外的内容", saved);

    const deleted = (await call(MEMORY_DELETE_CHANNEL, { path: "rules/escaped.md" })) as { ok?: unknown };
    check("junction 类目目录不能越权删除", deleted.ok === false && existsSync(outsideFile), deleted);
  }
  rmSync(linkDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}

/* ──────────────── 3. Codex 供应商 ──────────────── */

console.log("\nCodex 供应商:list 绝不带明文 Key");

const FAKE_KEY = "sk-smoke-绝不许跨IPC-0123456789";
const PROVIDER = {
  id: "smoke-gw",
  name: "Smoke 网关",
  baseUrl: "https://gw.example.com/v1",
  models: [{ id: "gpt-5-codex", label: "GPT-5", contextWindow: 128000 }],
};

/** provider 对象上出现了这把 Key 的**任何痕迹**都算泄露 —— 连密文里的 base64 也算。 */
function leaksKey(value: unknown, key: string): boolean {
  return JSON.stringify(value).includes(key);
}

{
  const saved = (await call(IPC.CODEX_MODELS_SAVE, { ...PROVIDER, apiKey: FAKE_KEY })) as {
    providers: Array<Record<string, unknown>>;
  };
  eq("save 之后列表里正好这一个", saved.providers.length, 1);
  const p = saved.providers[0]!;
  eq("save 回来的对象带 hasApiKey = true", p.hasApiKey, true);
  check("save 回来的对象里**没有**明文 Key", !leaksKey(p, FAKE_KEY), p);
  check("save 回来的对象里连 apiKey 这个字段都没有", !("apiKey" in p), Object.keys(p));
  check("save 回来的对象里没有密文 key 映射", !("codexProviderKeys" in p), Object.keys(p));

  const listed = (await call(IPC.CODEX_MODELS_LIST)) as { providers: Array<Record<string, unknown>> };
  eq("list 回一个供应商", listed.providers.length, 1);
  check("list 的每一条都不带明文 Key", !leaksKey(listed.providers, FAKE_KEY), listed.providers);
  check("list 的每一条都没有 apiKey 字段", listed.providers.every((x) => !("apiKey" in x)));
  check("list 只给 hasApiKey 这种布尔标记", listed.providers.every((x) => x.hasApiKey === true));
  // 密文是 base64 的,明文不会原样出现 —— 所以还要单独盯一眼"整段 JSON 里有没有 key 的
  // 可打印部分"。上面 leaksKey 已经覆盖明文;这里再盯 base64 与 hex 两种编码。
  const b64 = Buffer.from(FAKE_KEY, "utf8").toString("base64");
  check("list 里也没有那把 Key 的 base64", !JSON.stringify(listed.providers).includes(b64));
}

console.log("\nCodex 供应商:config.toml 真的重生成、且不含 Key");

{
  const toml = join(codexHomePath(), "config.toml");
  check("config.toml 落在临时目录里(没跑到用户家目录去)", insideTmpHome(toml), {
    toml,
    codexHome: codexHomePath(),
  });
  check("save 之后 config.toml 真的存在", existsSync(toml), toml);
  const body = existsSync(toml) ? readFileSync(toml, "utf8") : "";
  check("config.toml 里有这个供应商的表", body.includes(`[model_providers.${PROVIDER.id}]`), body);
  check("config.toml 里 base_url 写对了", body.includes(`base_url = "${PROVIDER.baseUrl}"`), body);
  check(
    "config.toml 里 key 走的是环境变量名(env_key)",
    body.includes(`env_key = "${codexKeyEnvVar(PROVIDER.id)}"`),
    { want: codexKeyEnvVar(PROVIDER.id) },
  );
  check("config.toml 里**没有**明文 Key", !body.includes(FAKE_KEY), body);
  check("config.toml 里也没有那把 Key 的 base64", !body.includes(Buffer.from(FAKE_KEY, "utf8").toString("base64")));
  check("wire_api 钉死在 responses", body.includes(`wire_api = "responses"`), body);
  // 没开 imageGeneration 就不该有那个解锁用的 header。
  check("没开 imageGeneration 时不写那个 header", !body.includes("x-openai-actor-authorization"), body);
}

console.log("\nCodex 供应商:eye-icon 那条路");

{
  const got = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: PROVIDER.id })) as { apiKey: string | null };
  // 本机的 safeStorage 桩走"没有钥匙串"那条真路(base64 往返),所以这里拿得到明文。
  eq("getApiKey 对一个存在的供应商回明文(UI 的眼睛图标要用)", got.apiKey, FAKE_KEY);

  let missingThrew = "";
  let missing: { apiKey: string | null } | null = null;
  try {
    missing = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: "没有这个供应商" })) as { apiKey: string | null };
  } catch (err) {
    missingThrew = (err as Error).message;
  }
  check("getApiKey 对不存在的 id 不抛", missingThrew === "", missingThrew);
  eq("getApiKey 对不存在的 id 回 { apiKey: null }", missing?.apiKey, null);

  // 入参连形状都不对(zod 直接拒)—— handler 的 catch 把它也吞成同一个 null。
  // ⚠️ 这正是那两个 catch 的毛病:它**分不清**"供应商不存在""入参不合法""解密失败",
  //    三种都变成 `{ apiKey: null }`,只在日志里留一句。断言钉住当前行为,免得
  //    以后有人以为这里回 null 是"供应商不存在"一个意思。
  let shapeThrew = "";
  let shape: { apiKey: string | null } | null = null;
  try {
    shape = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: "" })) as { apiKey: string | null };
  } catch (err) {
    shapeThrew = (err as Error).message;
  }
  check("getApiKey 入参不合法时也不抛(被 catch 吞了)", shapeThrew === "", shapeThrew);
  eq("...而且和不存在的 id 回的是同一个形状", shape?.apiKey, null);
}

console.log("\nCodex 供应商:delete 之后两边都干净");

{
  const after = (await call(IPC.CODEX_MODELS_DELETE, { id: PROVIDER.id })) as { providers: unknown[] };
  eq("delete 之后列表空了", after.providers.length, 0);
  const toml = readFileSync(join(codexHomePath(), "config.toml"), "utf8");
  check("config.toml 里那个供应商的表没了", !toml.includes(`[model_providers.${PROVIDER.id}]`), toml);
  check("config.toml 里那把 Key 也没了", !toml.includes(FAKE_KEY));

  const gone = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: PROVIDER.id })) as { apiKey: string | null };
  eq("删完再问 eye-icon 那条路,回 null", gone.apiKey, null);

  // 密钥表也真的清了 —— 不然同 id 再存一次会被当成"编辑",而空 apiKey 会被当成
  // "沿用旧 Key",用户就再也换不掉那把 Key 了。
  const reSave = (await call(IPC.CODEX_MODELS_SAVE, { ...PROVIDER, apiKey: FAKE_KEY })) as {
    providers: Array<{ hasApiKey: boolean }>;
  };
  eq("删完再存一次,hasApiKey 还是 true", reSave.providers[0]?.hasApiKey, true);
  const reKey = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: PROVIDER.id })) as { apiKey: string | null };
  eq("...而且拿到的是新存的那把", reKey.apiKey, FAKE_KEY);

  // 不带 apiKey 的更新有一条明确的规矩:新建必须给 Key,改老的可以不给(沿用)。
  let newNoKeyThrew = "";
  try {
    await call(IPC.CODEX_MODELS_SAVE, { ...PROVIDER, id: "brand-new", name: "新的" });
  } catch (err) {
    newNoKeyThrew = (err as Error).message;
  }
  check("新建一个不给 Key 会被拒", newNoKeyThrew.includes("API Key"), newNoKeyThrew);

  let updateNoKeyThrew = "";
  let updateNoKey: { providers: Array<{ id: string; hasApiKey: boolean }> } | null = null;
  try {
    updateNoKey = (await call(IPC.CODEX_MODELS_SAVE, {
      ...PROVIDER,
      name: "改个名字",
    })) as { providers: Array<{ id: string; hasApiKey: boolean }> };
  } catch (err) {
    updateNoKeyThrew = (err as Error).message;
  }
  check("改老的可以不给 Key(沿用)", updateNoKeyThrew === "", updateNoKeyThrew);
  eq("...改完 hasApiKey 还是 true", updateNoKey?.providers[0]?.hasApiKey, true);
  eq("...而且名字真的改了", updateNoKey?.providers[0] && (updateNoKey.providers[0] as { name?: string }).name, "改个名字");
  const kept = (await call(IPC.CODEX_MODELS_GET_API_KEY, { id: PROVIDER.id })) as { apiKey: string | null };
  eq("...Key 还是原来那把", kept.apiKey, FAKE_KEY);

  // 入参不合法时不该静默成功。
  let badBaseUrl = "";
  try {
    await call(IPC.CODEX_MODELS_SAVE, { ...PROVIDER, id: "bad", baseUrl: "gw.example.com", apiKey: "k" });
  } catch (err) {
    badBaseUrl = (err as Error).message;
  }
  check("baseUrl 不是 http(s):// 开头会被拒", badBaseUrl.includes("http"), badBaseUrl);

  let noModel = "";
  try {
    await call(IPC.CODEX_MODELS_SAVE, { ...PROVIDER, id: "bad2", models: [], apiKey: "k" });
  } catch (err) {
    noModel = JSON.stringify((err as Error).message);
  }
  check("一个模型都不配会被拒", noModel.length > 2, noModel);

  await call(IPC.CODEX_MODELS_DELETE, { id: PROVIDER.id });
}

/** `codexHomePath()` 是不是落在临时家目录里(绝不能是用户真的 `~/.mcode/codex`)。 */
function insideTmpHome(p: string): boolean {
  const home = resolve(process.env.USERPROFILE ?? process.env.HOME ?? "");
  if (home === "" || home === resolve("/")) return false;
  return resolve(p).startsWith(home + sep);
}

/* ──────────────── 4. 总注册表 ──────────────── */

console.log("\n总注册表:registerIpcHandlers");

{
  const { registerIpcHandlers } = await import("@main/ipc/index.js");

  /**
   * `registerIpcHandlers()` **不走参数** —— 它自己 `import { ipcMain } from "electron"`,
   * 再包一层 `createDbGuardedIpc`。所以这里能拿到的只有 `run.sh` 把整个 `electron`
   * 包换成本套的桩之后,桩里那份**记名表**(`stubs/electron.ts` 的 `registeredChannels`,
   * 它的 `handle` 对重复渠道**当场抛**,照抄真的 Electron)。
   *
   * ⚠️ `"electron"` 在 tsc 眼里是**真的那个包**(`run.sh` 的 `--alias` 只作用于
   * esbuild,类型检查看不到),所以这里要绕开类型走 `await import` + 断言。
   */
  const stub = (await import("electron")) as unknown as {
    registeredChannels: Map<string, (event: unknown, raw: unknown) => unknown>;
  };
  const { registeredChannels } = stub;

  let threw = "";
  try {
    registerIpcHandlers();
  } catch (err) {
    threw = (err as Error).message;
  }
  // **一个重复的 channel 就会抛** —— 那等于应用启动即崩。这条断言就是那道闸。
  eq("registerIpcHandlers() 正常返回(没有重复注册)", threw, "");

  const registered = [...registeredChannels.keys()].sort();
  const table = new Set<string>(Object.values(IPC) as string[]);
  // 数量级对得上:37 个域、三百多条 invoke。低于 200 基本就是有一整片域没注册进来。
  check("注册了不止一条(37 个域都进来了)", registered.length > 200, registered.length);
  check("注册表里没有空 channel / 没有非字符串", registered.every((c) => typeof c === "string" && c.length > 0));

  // 表里有、注册表里没有 = 那一条**只能**是推送方向(主进程 → 渲染端,preload 用
  // `ipcRenderer.on` 收,主进程侧压根不该有 handler)。
  const missing = [...table].filter((c) => !registeredChannels.has(c)).sort();
  same(`表里有、注册表没有的正好是这 ${PUSH_CHANNELS.length} 条推送渠道`, missing, PUSH_CHANNELS);

  // 注册表里有、表里没有 = 裸 channel 字面量。MAINT M36 把最后一条(dialog:pickFolder)
  // 补进了共享 IPC 表,从此应为空;再出现就是新的接线债(`ipc-wiring-smoke` 同步收紧)。
  const extra = registered.filter((c) => !table.has(c));
  same("主进程注册的每条 invoke 通道都在共享 IPC 表里(零裸 channel,M36)", extra, []);

  // 每个域都注册到了:拿 memory / codex 两条已知的当锚,防止"数量对但内容整体错位"。
  check("记忆助手主页面入口真实注册", registeredChannels.has(IPC.MEMORY_ASSISTANT));
  check("memory 那条域真的在注册表里", registeredChannels.has(MEMORY_LIST_CHANNEL));
  check("codexModels 那条域真的在注册表里", registeredChannels.has(IPC.CODEX_MODELS_LIST));

  // 两个无参 channel:`preload` 是个**裸 invoke**,不传第二个参数 —— 转手到 handler
  // 时 `raw` 就是 `undefined`,而这两句都没有 `?? {}` / 默认值。直接拿注册表里那份
  // (而不是 §0 自己那份)再走一遍,确认总注册表包的那一层也没把它弄挂。
  for (const bare of ["claude:healthCheck", "dialog:pickFolder"] as const) {
    const fn = registeredChannels.get(bare);
    let bareThrew = "";
    let out: unknown;
    try {
      out = await fn!(null, undefined);
    } catch (err) {
      bareThrew = (err as Error).message;
    }
    // dialog:pickFolder 无头下会走到 electron 的 dialog 桩(显式抛)—— 那不算
    // "入参处理坏了",所以判据只落在"不是 zod/参数那类错"上。
    const looksLikeParamBug = /zod|undefined is not an object|cannot read properties/i.test(bareThrew);
    check(`裸 channel ${bare} 传 undefined 不炸在入参上`, !looksLikeParamBug, { bareThrew, out });
  }

  // `createDbGuardedIpc` 那一层:handler 抛错时 `awaitDb()` 还得先被等到 ——
  // 顺序反了的话,DB 还没就绪的 handler 会先炸在 `getDb()` 上,用户看到的是
  // "getDb() called before initDb() resolved"这种内部句子。
  const guarded = registeredChannels.get(MEMORY_LIST_CHANNEL)!;
  let guardOk = false;
  let guardDetail = "";
  try {
    const out = (await guarded(null, {})) as { files: unknown[] };
    guardOk = Array.isArray(out.files);
  } catch (err) {
    guardDetail = (err as Error).message;
  }
  check("awaitDb() 就绪后,被包过的 handler 照常出结果", guardOk, guardDetail);

  // 抛错那条路:给一个入参不合法的,得**原样**把错抛出来(包装层不许吞)。
  let surfaced = "";
  try {
    await guarded(null, { category: 12345 });
  } catch (err) {
    surfaced = (err as Error).message;
  }
  check("入参不合法时包装层把错原样抛出来(不吞)", surfaced.length > 0, surfaced);

  eq("等待 DB 用的那个 promise 已经有主了", awaitDb().constructor.name, "Promise");
}

/* ────────────────────────── 汇总 ────────────────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nmemory-codex-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
