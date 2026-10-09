/**
 * Headless smoke for **语音输入那条路**:`main/voice/models.ts` +
 * `main/voice/speechRecognizer.ts` + `ipc/voice.ts`(三个文件零覆盖)。
 *
 * ## 这套东西存在的理由
 *
 * 这条路上有三处「用户会信」的形状,而且**全都没有回归网**:
 *
 *  1. **模型缺失时是显式报错还是静默不工作。** 用户点了录音、什么都没发生,
 *     而界面上一句提示都没有 —— 这是最坏的那种形状。这里的判据立在**用户看到
 *     的那行字**上(`尚未选择语音模型…` / `语音模型未下载或不完整…`),不是立在
 *     "函数抛了没有"上。
 *  2. **「已下载」这份名单只有磁盘一个真相。** 它同时活在 `settings` 表的
 *     `ui.voiceDownloadedModels` 和文件系统里;写盘是原子的(`.part` → `rename`),
 *     所以残留的 `.part` 绝不能被读成"这个模型下好了"。⚠️ 本仓库刚修过同形状的
 *     bug:崩溃残留的 `.staging-*` 目录被读成"已安装版本"(见
 *     `runtimes/managedRuntimeRoots.ts` 里那段注释),那正是本套 §2 照抄的范本。
 *  3. **每条失败路径都要把状态收干净。** 半截的会话、取消的下载、加载挂掉的
 *     识别器 —— 任何一个留在那儿,下一次"看着在录"就会复现。
 *
 * ## 它怎么做到不碰真东西
 *
 *  - **不碰外网**:见下面 §0 的 `fetch` 替身 —— catalog 里 huggingface.co /
 *    hf-mirror.com 两个 origin 在**出网那一层**被映射到 127.0.0.1 上的两个本地
 *    服务(不靠改 URL,**也不靠拦截**)。先钉一条"没人能绕过它"的守卫。
 *  - **不碰真麦克风**:PCM 是脚本自己造的 Float32Array。
 *  - **不碰真模型文件**:夹具是几个空文件;`sherpa-onnx-node` 整个换成桩
 *    (见 `stubs/sherpaOnnx.ts`,它默认不抛,于是"模型没选"那条 RPC 能验到底)。
 *  - **不碰真数据库**:数据根是 `run.sh` 用 `mktemp -d` 建的目录
 *    (`MCODE_SMOKE_DATA_ROOT`,桩里没设就抛)。
 *
 * Run: scripts/voice-smoke/run.sh
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { IpcMain } from "electron";

/* ════════════════════════ §0 前置条件 ════════════════════════ */

/** 数据根 = `mcode.db` 的副本所在。**必须在 import 任何被测模块之前设** ——
 *  `models.ts` 会读它拼默认模型根。 */
const DATA = mkdtempSync(join(tmpdir(), "mcode-voice-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/** 临时目录:自定义模型根、诱饵目录。必须在 userData 之外(那是 `setCustomModelRoot`
 *  会挡的条件之一)。 */
const SCRATCH = mkdtempSync(join(tmpdir(), "mcode-voice-scratch-"));

/** `app.getPath("userData")` 的替身值 —— 默认模型根 = `<DATA>/models/voice`。 */
const { __setUserData } = await import("./stubs/electron.js");
__setUserData(DATA);

const stubWindow = await import("./stubs/window.js");
const sherpaStub = await import("./stubs/sherpaOnnx.js");

/* ════════════════════════ 本地 HTTP:唯一的"网络" ════════════════════════ */

/** 请求模式。`holdFirstGet` = 第一条 GET 挂在半路(验半截状态)。 */
type ServerMode = "fail500" | "holdFirstGet" | "ok";

let serverMode: ServerMode = "ok";
let serverHits = 0;
/** 分开数 HEAD 与 GET:HEAD 是 `probeFileSizes()` 探文件大小的,**不是**下载正文。 */
let serverHeadHits = 0;
let serverGetHits = 0;
let serverHeld = false;
let releaseHold: (() => void) | null = null;

/** 每次要"卡住第一个 GET"之前调一次 —— 否则第二次起 `serverHeld` 还是 true,
 *  那个分支再也不会命中(夹具会静默空过)。 */
function armHold(): void {
  serverMode = "holdFirstGet";
  serverHeld = false;
  releaseHold = null;
}
function release(): void {
  (releaseHold as (() => void) | null)?.();
}

function makeServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    serverHits += 1;
    if (req.method === "HEAD") serverHeadHits += 1;
    else serverGetHits += 1;
    if (serverMode === "fail500") {
      res.writeHead(500, { "content-length": "0" });
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": "4096" });
      res.end();
      return;
    }
    if (serverMode === "holdFirstGet" && !serverHeld) {
      serverHeld = true;
      res.writeHead(200, { "content-length": "4096" });
      res.write("abc"); // 先来 3 个字节 —— 这时盘上的 `.part` 该出现了
      const waiter = new Promise<void>((r) => {
        releaseHold = r;
      });
      void waiter.then(() => {
        res.write(Buffer.alloc(4093, 0x41));
        res.end();
      });
      return;
    }
    res.writeHead(200, { "content-length": "4096" });
    res.end(Buffer.alloc(4096, 0x41));
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      r({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

/** 两个 origin(对应 huggingface.co 与 hf-mirror.com 的兜底路径)。 */
const srvA = await makeServer();
const srvB = await makeServer();

const ORIGIN_MAP = new Map<string, string>([
  ["https://huggingface.co", `http://127.0.0.1:${srvA.port}`],
  ["https://hf-mirror.com", `http://127.0.0.1:${srvB.port}`],
]);

/** 把 URL 上的 origin 换成本地服务 —— **不在 URL 串上做手脚**,只换真正出门的那一段。 */
function toLocalOrigin(url: string): string {
  for (const [remote, local] of ORIGIN_MAP) {
    if (url.startsWith(remote)) return local + url.slice(remote.length);
  }
  return url;
}

/** ⚠️ **这一条是整套东西的安全前提**:换成映射版之后,拿 catalog 里**第一条真 URL**
 *  探一次 —— 本地服务必须收到它。没收到就说明出口没被堵住,后面所有"下载"断言都会
 *  真的打到 huggingface.co 上去。跑在 §0.5(断言助手与 catalog 都就位之后)。 */
async function assertLocalOriginTrapWorks(): Promise<void> {
  const probeUrl = VOICE_MODEL_CATALOG[0]!.files[0]!.url;
  const hitsBefore = serverHits;
  const res = await globalThis.fetch(probeUrl, { method: "HEAD" });
  check(
    "★ catalog 的 URL 被本地服务接住了(没人能绕过这层映射去碰外网)",
    res.ok && serverHits === hitsBefore + 1,
    { ok: res.ok, hits: serverHits - hitsBefore, probeUrl },
  );
}

const realFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const raw =
    typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  return realFetch(toLocalOrigin(raw), init);
};

/* ════════════════════════ 断言助手 ════════════════════════ */

let failures = 0;
let total = 0;
/** 断言名重复会被判红 —— 复制粘贴出来的两条同名断言等于少验一条。 */
const seenNames = new Set<string>();

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (seenNames.has(name)) {
    failures += 1;
    console.log(`  FAIL 断言名重复(复制粘贴的坑): ${name}`);
    return;
  }
  seenNames.add(name);
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

/** 数组/对象比较(`Object.is` 对内容相同的数组是 false)。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 取一段会抛的代码的 message —— "用户看到的那行字"就是它。 */
async function messageOf(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return String((err as Error)?.message ?? err);
  }
  return "";
}

/** 等一个条件成立(下载是异步的,推送要等它回来)。 */
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

/* ════════════════════════ 被测模块 ════════════════════════ */

const {
  VOICE_MODEL_CATALOG,
  UI_VOICE_MODEL_DIR_SETTING_KEY,
  UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY,
  IPC,
} = await import("@contracts/ipc");

/** `SettingRepo.set` 内部就是 `persist()` —— 每一句都在重写 `mcode.db` 的副本。 */
const { SettingRepo } = await import("@main/store/repositories.js");
const { getDb, awaitDb, initDb } = await import("@main/store/db.js");

const {
  customModelRoot,
  voiceModelRoot,
  setCustomModelRoot,
  modelDirFor,
  selectedModelId,
  setSelectedModel,
  downloadedModelIds,
  listModels,
  downloadModel,
  cancelDownload,
  isDownloading,
  removeLocalModel,
  requireModelDir,
  transducerFilesFor,
  getModelDirInfo,
} = await import("@main/voice/models.js");

const {
  startSession,
  feedPcm,
  stopSession,
  cancelSession,
  resetRecognizerCache,
  warmupRecognizer,
} = await import("@main/voice/speechRecognizer.js");

/** catalog 里的两个模型 —— 一个当"主角",一个当"另一个"。 */
const M1 = VOICE_MODEL_CATALOG[0]!.id;
const M2 = VOICE_MODEL_CATALOG[1]!.id;
const INFO1 = VOICE_MODEL_CATALOG[0]!;
const INFO2 = VOICE_MODEL_CATALOG[1]!;

/** 模型目录里的所有文件名(含 `.part` 残留)。 */
function dirEntries(modelId: string): string[] {
  const dir = modelDirFor(modelId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** 把一个模型要求的**每个文件**都写成空文件(夹具,不是真模型)。 */
function installModel(modelId: string): void {
  const info = VOICE_MODEL_CATALOG.find((m) => m.id === modelId)!;
  const dir = modelDirFor(modelId);
  mkdirSync(dir, { recursive: true });
  for (const f of info.files) writeFileSync(join(dir, f.rel), "x");
}

/** 只写前 n 个文件 —— 造"下到一半"的现场。 */
function installPartial(modelId: string, n: number): void {
  const info = VOICE_MODEL_CATALOG.find((m) => m.id === modelId)!;
  const dir = modelDirFor(modelId);
  mkdirSync(dir, { recursive: true });
  for (const f of info.files.slice(0, n)) writeFileSync(join(dir, f.rel), "x");
}

function wipeModel(modelId: string): void {
  const dir = modelDirFor(modelId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** 收集脚本这一侧的推送(判据就是"用户看到的那些帧")。 */
function progressFrames(modelId?: string): Array<Record<string, unknown>> {
  return stubWindow
    .pushesOn(IPC.VOICE_DOWNLOAD_PROGRESS)
    .map((p) => p.payload)
    .filter((p) => !modelId || p.modelId === modelId);
}

/* ════════════════════════ §0.5 数据库先起来 ════════════════════════ */

console.log("\n§0 先把库起来,并把两个模型清干净");

// ⚠️ 真启动路径是 `registerIpcHandlers()` → `createDbGuardedIpc` 对每一条 handler
// 都先 `await awaitDb()`。无头脚本里没人替我们跑这一步,得自己来 —— 否则第一次
// `SettingRepo.get` 就是 `getDb() called before initDb() resolved`。
await initDb();
eq("库起来了", typeof getDb().prepare === "function", true);
await awaitDb();

for (const m of VOICE_MODEL_CATALOG) wipeModel(m.id);
setSelectedModel("");
eq("清场:一个模型都没装", listModels().downloaded.length, 0);

await assertLocalOriginTrapWorks();

/* ════════════════════════ §0.6 注册真的 handler(推送从这一刻起才有人接) ════════════════════════ */

console.log("\n§0.6 注册真的 IPC handler(后面 §4/§5 的推送断言都靠它接线)");

/** 记名 `ipcMain`。⚠️ **注册必须发生在 §4 之前** —— `registerVoiceHandlers` 的
 *  `wirePushes()` 是**唯一**把 `voice:result` / `voice:downloadProgress` 接到
 *  `sendToRenderer` 上的地方。不先注册的话,§4/§5 里所有"界面收到了什么"的断言
 *  都会看到空数组然后**全绿**,而实际上什么都没验。 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
{
  const fakeIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  // ⚠️ `registerVoiceHandlers` 里有一句 `setTimeout(() => warmupRecognizer(), 8000)`。
  //    照实跑会让脚本多等 8 秒。这里把它截下来单独验(它的存在本身是产品行为:
  //    启动 8 秒后才预热,免得抢首屏)。
  const realSetTimeout = globalThis.setTimeout;
  let warmupDelay = -1;
  let warmupTimer: (() => void) | null = null;
  (globalThis as { setTimeout: unknown }).setTimeout = (
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ): unknown => {
    if (ms === 8000) {
      warmupDelay = ms;
      warmupTimer = fn;
      return 0;
    }
    return (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
  };
  const { registerVoiceHandlers } = await import("@main/ipc/voice.js");
  registerVoiceHandlers(fakeIpc);
  (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;

  eq("启动预热被推迟到 8 秒后(不抢首屏)", warmupDelay, 8000);
  check("预热回调被排上了", typeof warmupTimer === "function");

  const channels = [
    IPC.VOICE_START,
    IPC.VOICE_FEED,
    IPC.VOICE_STOP,
    IPC.VOICE_CANCEL,
    IPC.VOICE_MODEL_LIST,
    IPC.VOICE_DOWNLOAD_MODEL,
    IPC.VOICE_CANCEL_MODEL_DOWNLOAD,
    IPC.VOICE_SELECT_MODEL,
    IPC.VOICE_REMOVE_MODEL,
    IPC.VOICE_GET_MODEL_DIR,
    IPC.VOICE_SET_MODEL_DIR,
  ];
  check(
    "★ 契约里那 11 条 voice RPC 全都注册上了(缺一条渲染端就调不到)",
    channels.every((c) => handlers.has(c)),
    channels.filter((c) => !handlers.has(c)),
  );
  eq(
    "★ 推送接线也装上了(否则界面收不到任何进度/文字)",
    stubWindow.pushes.length,
    0,
  );
}

/** 调一条真的注册进去的 handler。
 *
 *  ⚠️ **这里是 `async function`,不能写成 `Promise.resolve(fn(...))** ——
 *  `ipc/voice.ts` 里的 handler 有一半是**同步**的(比如 `voice.selectModel`),
 *  它的 zod 拒绝是**同步抛**出来的;而 `Promise.resolve(x)` 的实参在调用前就求值了,
 *  于是那个 throw 会在 `Promise.resolve` 之前逃出去,绕过所有 `.then(onRejected)`。
 *  Electron 真的 `ipcMain.handle` 会把同步 throw 归一成一次 rejection,这里照做。 */
async function call(channel: string, raw?: unknown): Promise<unknown> {
  return handlers.get(channel)!(null, raw);
}

/* ════════════════════════ §1 模型根:选、校验、半截状态 ════════════════════════ */

console.log("\n§1 模型根:用户挑的位置进得去吗,坏位置挡住了吗");

eq("没设过 → customModelRoot() 是 null", customModelRoot(), null);
eq(
  "默认根落在 userData 下",
  resolve(voiceModelRoot()),
  resolve(join(DATA, "models", "voice")),
);
eq("没设过时 isCustom=false", getModelDirInfo().isCustom, false);

// ── 坏路径一律**显式报错**(这行字会直接进 toast,所以断言断的是它) ──
{
  const rel = await messageOf(() => setCustomModelRoot("models/voice"));
  check("相对路径被挡住,且话说得清楚", /绝对路径/.test(rel), rel);

  const driveRoot = await messageOf(() => setCustomModelRoot("C:\\"));
  check("驱动器根被挡住", /驱动器根目录/.test(driveRoot), driveRoot);

  const missing = await messageOf(() => setCustomModelRoot(join(SCRATCH, "还没建的目录")));
  check("不存在的目录被挡住,并告诉用户先建", /目录不存在/.test(missing), missing);

  const inside = await messageOf(() => setCustomModelRoot(join(DATA, "别的地方")));
  check("userData 里的其它位置被挡住(免得 rmdir 误伤应用数据)", /userData/.test(inside), inside);

  // ★ 被挡住的每一次都**不该**留下半截状态:设置键必须还是"没设过"的样子。
  eq(
    "★ 挡住之后设置键没有被写脏(还是没设过)",
    SettingRepo.get(UI_VOICE_MODEL_DIR_SETTING_KEY),
    null,
  );
  eq(
    "★ 挡住之后根还是默认那个",
    resolve(voiceModelRoot()),
    resolve(join(DATA, "models", "voice")),
  );
}

// ── 一个**好的**自定义根:接受、落盘、并重扫 ──
const GOOD_ROOT = join(SCRATCH, "语音模型");
const GOOD_ROOT_2 = join(SCRATCH, "另一个根");
{
  mkdirSync(GOOD_ROOT, { recursive: true });
  const res = setCustomModelRoot(GOOD_ROOT);
  eq("好路径被接受(绝对 + 可写 + 在 userData 之外)", res.isCustom, true);
  eq("返回的根就是它", resolve(res.modelDir), resolve(GOOD_ROOT));
  same("新根里还没有模型 → downloaded 是空的", res.downloaded, []);
  eq(
    "落盘了(重启后还在)",
    SettingRepo.get(UI_VOICE_MODEL_DIR_SETTING_KEY),
    resolve(GOOD_ROOT),
  );
  eq("此后 voiceModelRoot() 认它", resolve(voiceModelRoot()), resolve(GOOD_ROOT));

  // 装进新根,再换一个根:**非破坏性**,而且不自动迁移(换根之后新根就是空白的)。
  installModel(M1);
  mkdirSync(GOOD_ROOT_2, { recursive: true });
  const res2 = setCustomModelRoot(GOOD_ROOT_2);
  same(
    "★ 换根时新根里没有这个模型 → 如实报「没有」,不假装在旧根里见过它",
    res2.downloaded,
    [],
  );
  check(
    "★ 旧根里的文件没被搬走(换根不动字节,也不自动迁移)",
    existsSync(join(GOOD_ROOT, INFO1.dir)),
  );
  setCustomModelRoot(GOOD_ROOT);
  same(
    "★ 换回旧根之后它又在名单里了(判定跟着根走,不是缓存的全局名单)",
    listModels().downloaded,
    [M1],
  );
}

// ── 根**消失了**之后 ──
{
  const ghost = join(SCRATCH, "待会儿删掉");
  mkdirSync(ghost, { recursive: true });
  setCustomModelRoot(ghost);
  rmSync(ghost, { recursive: true, force: true });
  eq("本来设了自定义根但它没了 → customModelRoot() 退回 null", customModelRoot(), null);
  eq(
    "于是模型根回落默认(下次下载不会往一个不存在的目录里写)",
    resolve(voiceModelRoot()),
    resolve(join(DATA, "models", "voice")),
  );
  // ⚠️ 这一条测的是**实际后果**,不是设置键的值 —— 键里仍然存着那个死路径。
  //    将来谁让它"复活"成有效路径,根就悄悄跳回去。见报告。
  eq(
    "设置键里**仍然**留着那个死路径(只是在读的时候被过滤掉了)",
    SettingRepo.get(UI_VOICE_MODEL_DIR_SETTING_KEY),
    ghost,
  );
  setCustomModelRoot(GOOD_ROOT);
}

/* ════════════════════════ §2 「已下载」这份名单:磁盘是唯一真相 ════════════════════════ */

console.log("\n§2 半截下载会不会被读成「已下载」");

{
  for (const m of VOICE_MODEL_CATALOG) wipeModel(m.id);
  setSelectedModel("");

  // ① **只写了一半文件** → 不算下载好。
  installPartial(M1, 1);
  same("只到一半的文件 → 不算「已下载」", listModels().downloaded, []);
  // ⚠️ **这里必须用 `eq` 而不是 `same`**:`same` 走 JSON.stringify,而
  //    `JSON.stringify("[]")` 就是 `"[]"` —— 一个"库里存着 `[]` 字符串"的
  //    bug 会被它测成绿的。真的行为是:第一次扫描就把空名单落盘了。
  eq(
    "空名单也会被落盘(存的是 `[]` 而不是留着 null)",
    SettingRepo.get(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY),
    "[]",
  );
  eq("而且它解析出来确实是空的", downloadedModelIds().length, 0);

  // ② **设置键说下好了,盘上却没有** → 以盘为准。
  //    这正是"换了自定义根 / 用户手工删了目录"之后的现场。
  SettingRepo.set(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY, JSON.stringify([M1, M2]));
  same("盘上没有 → 就算设置键说是也不算", listModels().downloaded, []);
  same("而且那份脏名单被就地清掉了(不是留着等下次骗人)", downloadedModelIds(), []);

  // ③ **崩溃残留的 `.part`**:写盘是原子的(`.part` → rename),所以一个没写完的
  //    文件叫 `xxx.onnx.part`,永远不会等于清单里要的 `xxx.onnx`。
  //    ⚠️ 本仓库刚修过同形状的 bug(崩溃残留的 `.staging-*` 被读成已安装版本),
  //    见 runtimes/managedRuntimeRoots.ts 里那段注释 —— 这里照它的范本钉住。
  {
    const dir = modelDirFor(M1);
    mkdirSync(dir, { recursive: true });
    for (const f of INFO1.files) writeFileSync(join(dir, `${f.rel}.part`), "半截");
    same("★ 一整套 `.part` 也不等于「已下载」", listModels().downloaded, []);
    installModel(M1);
    same("★ 补齐真文件之后才认", listModels().downloaded, [M1]);
    eq("此时设置键里也写上了", SettingRepo.get(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY), JSON.stringify([M1]));
  }

  // ④ 幂等:连扫两次结果一样,而且不再写盘(避免每次开面板都重写一次库)。
  {
    const before = SettingRepo.get(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY);
    listModels();
    listModels();
    eq(
      "反复扫描是幂等的(设置键内容不抖)",
      SettingRepo.get(UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY),
      before,
    );
  }

  // ⑤ requireModelDir:文件不全时那句话里要有**缺了哪个文件**、以及去哪儿下。
  {
    wipeModel(M2);
    installPartial(M2, 2);
    const missingRel = INFO2.files[2]!.rel;
    const msg = await messageOf(() => requireModelDir(M2));
    check(
      "★ 文件不全时报的是「缺哪一个 + 去哪儿下」,不是一句「失败」",
      msg.includes(missingRel) && msg.includes("设置"),
      msg,
    );
    check("而且它说的是这个模型的名字", msg.includes(INFO2.name), msg);
  }

  // ⑥ 清单→sherpa 配置角色的映射:文件名带了 epoch/量化后缀也得认出来。
  {
    const roles = transducerFilesFor(M1);
    same(
      "四个角色都能按前缀认出来(epoch/量化后缀不影响)",
      [roles.tokens, roles.encoder, roles.decoder, roles.joiner],
      [
        "tokens.txt",
        INFO1.files.find((f) => f.rel.startsWith("encoder"))!.rel,
        INFO1.files.find((f) => f.rel.startsWith("decoder"))!.rel,
        INFO1.files.find((f) => f.rel.startsWith("joiner"))!.rel,
      ],
    );
    eq(
      "而且四个角色互不重叠(一个文件不会被判成两个角色)",
      new Set([roles.tokens, roles.encoder, roles.decoder, roles.joiner]).size,
      4,
    );
  }
}

/* ════════════════════════ §3 识别器缓存:换根必须让缓存失效 ════════════════════════ */

console.log("\n§3 缓存下来的识别器跟不跟得上模型根的变化");

{
  installModel(M1);
  setSelectedModel(M1);
  resetRecognizerCache();
  sherpaStub.resetRecorder();

  await startSession("s1", "zh-CN", "zipformer");
  eq("模型齐 + 已选中 → 会话起得来", sherpaStub.createdStreams.length, 1);
  eq("识别器真的建了一次", sherpaStub.builtConfigs.length, 1);
  stopSession("s1");

  await startSession("s2", "zh-CN", "zipformer");
  eq(
    "同一份模型 → 复用缓存,不重建(加载要好几秒)",
    sherpaStub.builtConfigs.length,
    1,
  );
  stopSession("s2");

  // ★ 换根 → 旧缓存指向的是**老路径下的文件**。resetRecognizerCache() 是那条
  //   RPC 必须做的补救。这里用一个真的不同的根来验。
  setCustomModelRoot(GOOD_ROOT_2);
  installModel(M1); // 新根里也装一份,好让 start 走得下去
  resetRecognizerCache();
  await startSession("s3", "zh-CN", "zipformer");
  eq("★ reset 之后必须重建", sherpaStub.builtConfigs.length, 2);
  const cfgFromNewRoot = sherpaStub.builtConfigs[1];
  eq(
    "★ 重建用的是**新根**下的路径(不是在读已经不在的旧文件)",
    resolve(cfgFromNewRoot.modelConfig.transducer.encoder as string),
    resolve(join(modelDirFor(M1), transducerFilesFor(M1).encoder)),
  );
  check(
    "★ 那条路径落在新根里,不落在旧根里",
    resolve(cfgFromNewRoot.modelConfig.transducer.encoder as string).startsWith(
      resolve(GOOD_ROOT_2),
    ),
    cfgFromNewRoot.modelConfig.transducer.encoder,
  );
  stopSession("s3");
  setCustomModelRoot(GOOD_ROOT);

  // ★ 换成另一个模型 → 缓存也得失效(否则会用错模型听)。
  installModel(M2);
  setSelectedModel(M2);
  resetRecognizerCache();
  await startSession("s4", "zh-CN", "zipformer");
  eq("★ 换模型之后重建", sherpaStub.builtConfigs.length, 3);
  check(
    "★ 用的是新模型目录下的 encoder",
    resolve(sherpaStub.builtConfigs[2].modelConfig.transducer.encoder as string).startsWith(
      resolve(modelDirFor(M2)),
    ),
    sherpaStub.builtConfigs[2].modelConfig.transducer.encoder,
  );
  stopSession("s4");
  setSelectedModel(M1);
  resetRecognizerCache();
}

/* ════════════════════════ §4 下载:失败、半截、取消 ════════════════════════ */

console.log("\n§4 下载:失败要显式报出来,半截不能留下");

{
  // ── (a) 未知模型:显式 reject ──
  const unknownMsg = await messageOf(() => downloadModel("没这个模型"));
  check("未知模型下载 → 显式报错", unknownMsg.length > 0, unknownMsg);
  eq("不会留下「正在下载」的标记", isDownloading("没这个模型"), false);

  // ── (b) 文件已经全在 → 正文一个字节都不该传 ──
  {
    for (const m of VOICE_MODEL_CATALOG) wipeModel(m.id);
    installModel(M1);
    stubWindow.resetPushes();
    const getsBefore = serverGetHits;
    await downloadModel(M1);
    eq("★ 文件都在时一个字节的正文都不下载(GET 请求数为 0)", serverGetHits - getsBefore, 0);
    const frames = progressFrames(M1);
    eq("★ 而且推一条 done(界面要据此把按钮切成「使用」)", frames.at(-1)?.stage, "done");
    eq("done 的进度是 100", frames.at(-1)?.percent, 100);
  }

  // ── (c) 真的失败:两个 origin 都 500 → 推一条 error,带一段人能读的话 ──
  {
    wipeModel(M2);
    serverMode = "fail500";
    stubWindow.resetPushes();
    const msg = await messageOf(() => downloadModel(M2));
    check("下载失败 → 调用方拿到 rejection", msg.length > 0, msg);
    check(
      "★ 那句话里说清了「两个镜像都试过了」",
      msg.includes("huggingface.co") && msg.includes("hf-mirror.com"),
      msg,
    );
    eq("失败之后没有「正在下载」的残留", isDownloading(M2), false);

    const frames = progressFrames(M2);
    const errFrame = frames.find((f) => f.stage === "error");
    check("★ 界面上收到了一条 error 进度帧", !!errFrame, frames.map((f) => f.stage));
    check(
      "★ 那帧里的 error 文案不是空的(设置面板就显示它)",
      typeof errFrame?.error === "string" && errFrame.error.length > 0,
      errFrame,
    );
    eq(
      "★ 而且失败之后它**没有**被算成「已下载」",
      listModels().downloaded.includes(M2),
      false,
    );
    same("★ 半截文件一个都不留", dirEntries(M2), []);
    eq("★ 一个 `.part` 都不许留下", dirEntries(M2).some((n) => n.endsWith(".part")), false);

    // ── (d) 失败之后还能重试(不是一次失败就永久卡住) ──
    serverMode = "ok";
    await downloadModel(M2);
    eq("★ 失败之后再下能成功", listModels().downloaded.includes(M2), true);
  }

  // ── (e) 半截状态:第一个文件还在传的**那一刻**,盘上该是什么样 ──
  {
    wipeModel(M1);
    const f0 = INFO1.files[0]!;
    armHold();
    stubWindow.resetPushes();
    const pending = downloadModel(M1);
    const arrived = await waitFor(() => serverHeld);
    check("第一个文件的请求已经发出去了(夹具有效,不是空过)", arrived);
    if (arrived) {
      eq(
        "★ 传输中:目标文件**不存在**(原子写:写完才 rename)",
        existsSync(join(modelDirFor(M1), f0.rel)),
        false,
      );
      same("★ 传输中:盘上只有一个 `.part`", dirEntries(M1), [`${f0.rel}.part`]);
      eq(
        "★ 传输中:界面已经把「正在下载」显示出来了(0% 也算)",
        progressFrames(M1).some((f) => f.stage === "downloading"),
        true,
      );
      eq("传输中:标记是「正在下载」", isDownloading(M1), true);
      eq("传输中:不算「已下载」", listModels().downloaded.includes(M1), false);
    }
    release();
    await pending;
    serverMode = "ok";
    eq("放行之后下完了", listModels().downloaded.includes(M1), true);
    eq("下完之后一个 `.part` 都不剩", dirEntries(M1).some((n) => n.endsWith(".part")), false);
  }

  // ── (f) 取消:取消之后既不能留半截文件,也不能留「正在下载」 ──
  {
    wipeModel(M1);
    armHold();
    stubWindow.resetPushes();
    const pending = downloadModel(M1);
    const arrived = await waitFor(() => serverHeld);
    check("取消那条路的夹具也真的命中了", arrived);
    eq("取消前算「正在下载」", isDownloading(M1), true);

    cancelDownload(M1);
    const msg = await messageOf(() => pending);
    check("取消 → 调用方拿到 cancellation", msg.toLowerCase().includes("cancel"), msg);
    eq("★ 取消之后标记清掉了", isDownloading(M1), false);
    eq("★ 界面上收到的是「已取消」,不是「失败」", progressFrames(M1).at(-1)?.stage, "cancelled");
    eq(
      "★ 界面**没有**收到「失败」(取消不是错误)",
      progressFrames(M1).some((f) => f.stage === "error"),
      false,
    );
    eq("★ 取消不算「已下载」", listModels().downloaded.includes(M1), false);
    eq("★ 取消之后没有 `.part` 残留", dirEntries(M1).some((n) => n.endsWith(".part")), false);
    serverMode = "ok";

    // 取消之后再下,要能正常下完(不是被取消状态卡住)。
    await downloadModel(M1);
    eq("★ 取消之后再下能成功", listModels().downloaded.includes(M1), true);
  }

  // ── (g) 删模型:正在下的时候不许删 ──
  {
    wipeModel(M2);
    armHold();
    const pending = downloadModel(M2);
    const arrived = await waitFor(() => serverHeld);
    check("删除那条路的夹具命中了", arrived);
    const msg = await messageOf(() => removeLocalModel(M2));
    check("★ 正在下载时删除被挡住,并说了为什么", /下载中/.test(msg), msg);
    release();
    await pending;
    serverMode = "ok";
    removeLocalModel(M2);
    eq("下完之后删得掉", existsSync(modelDirFor(M2)), false);
  }
}

/* ════════════════════════ §5 voice.start:模型缺失时用户看到那句话了吗 ════════════════════════ */

console.log("\n§5 模型缺失:是显式报错还是静默不工作");

{
  // ── (a) 什么都没选 ──
  setSelectedModel("");
  resetRecognizerCache();
  stubWindow.resetPushes();
  const msg = await messageOf(() => startSession("v-none", "zh-CN", "zipformer"));
  check(
    "★ 没选模型时说的话**指路**(设置 → 语音输入),不是一句「失败」",
    msg.includes("设置") && msg.includes("语音输入"),
    msg,
  );
  check("★ 而且那句里有「模型」两个字(用户能对上)", /模型/.test(msg), msg);

  // ★★ 这一条是这套里最值钱的一条,理由见 AGENT-RULES 第四节「两套实现只有一份」:
  //     主进程抛的那句话和渲染端**判断是哪一类错误**用的那个正则,是两份东西。
  //     `MicButton` 拿 `NO_MODEL_ERROR_RE` 决定弹「请去设置里下模型 + 直接把设置页
  //     打开」还是弹 `engineFail`(「语音模型加载失败,请检查网络后重试」)。
  //     主进程这边把这句话改写一个词,用户就会收到**指向错误方向**的建议 ——
  //     而两边的测试都不会红,因为谁都没在测这个耦合。
  //
  //     所以这里**读取真的那个正则**,不是抄一份。抄一份就成了自己给自己出题。
  {
    const mic = readFileSync(
      join(process.cwd(), "src/renderer/components/chat/MicButton.tsx"),
      "utf8",
    );
    const m = /const NO_MODEL_ERROR_RE\s*=\s*\/(.+?)\/;/.exec(mic);
    if (!m) {
      check(
        "★ 从 MicButton 里读出 NO_MODEL_ERROR_RE(读不到就没法验这条耦合)",
        false,
        "正则没匹配上 —— MicButton.tsx 里的写法变了,请同步这套脚本",
      );
    } else {
      const classifier = new RegExp(m[1]!);
      check(
        "★★ 模型没选时抛出的那句话,仍然能被渲染端的「去设置里下模型」分类器认出来",
        classifier.test(msg),
        { message: msg, classifier: m[1] },
      );
      const noModelMsgForIpc = await messageOf(() =>
        call(IPC.VOICE_START, { sessionId: "v-none-ipc", lang: "zh-CN", engine: "zipformer" }),
      );
      check(
        "★★ 走完真的 IPC handler 之后,那句话仍然认得出来(中间没被任何一层改写)",
        classifier.test(noModelMsgForIpc),
        { message: noModelMsgForIpc, classifier: m[1] },
      );
    }
  }

  // 失败之后不能留下半截会话 —— 否则之后每一次 feed/stop 都在跟一个空壳打交道。
  eq("★ start 失败没有留下会话", stopSession("v-none").text, "");
  stubWindow.resetPushes();
  feedPcm("v-none", new Float32Array([0.5, 0.5, 0.5]));
  eq("★ start 失败之后喂音频是空操作(不推半截文字)", stubWindow.pushes.length, 0);

  // ── (b) 选了,但文件不全 ──
  for (const m of VOICE_MODEL_CATALOG) wipeModel(m.id);
  installPartial(M1, 2);
  setSelectedModel(M1);
  resetRecognizerCache();
  const missing = INFO1.files.find((f) => !existsSync(join(modelDirFor(M1), f.rel)))!;
  const msg2 = await messageOf(() => startSession("v-part", "zh-CN", "zipformer"));
  check("★ 文件不全时点名缺了哪一个", msg2.includes(missing.rel), msg2);
  eq("★ 半截模型起不来(不是「看着在录」)", stopSession("v-part").text, "");

  // ── (c) 文件齐全,但**原生 addon 加载失败** ──
  installModel(M1);
  resetRecognizerCache();
  sherpaStub.__failNextLoad();
  const msg3 = await messageOf(() => startSession("v-addon", "zh-CN", "zipformer"));
  check("★ addon 挂了也确实报出来了(没有吞掉)", msg3.length > 0, msg3);
  check(
    "★ 但这句话是原生加载器原文(用户读不出「我该做什么」)",
    /sherpa-onnx/i.test(msg3),
    msg3,
  );
  // 半截状态:加载失败之后不能留下一个"半建好"的识别器。
  sherpaStub.resetRecorder();
  resetRecognizerCache();
  await startSession("v-after", "zh-CN", "zipformer");
  eq("★ addon 失败没有在半路留下缓存(修好之后能重建)", sherpaStub.builtConfigs.length, 1);
  stopSession("v-after");

  // ── (d) 会话的 start/stop 幂等与状态清理 ──
  resetRecognizerCache();
  sherpaStub.resetRecorder();
  await startSession("v1", "zh-CN", "zipformer");
  const streamsBefore = sherpaStub.createdStreams.length;
  await startSession("v1", "zh-CN", "zipformer");
  eq(
    "★ 同一个 sessionId 重复 start 不会多开一条流(泄漏的形状)",
    sherpaStub.createdStreams.length,
    streamsBefore,
  );
  eq("重复 start 之后会话还在(commit 能收尾)", stopSession("v1").text, "");
  await startSession("v1", "zh-CN", "zipformer");
  eq(
    "★ stop 会真的丢掉旧会话,再 start 开的是**新的一条流**",
    sherpaStub.createdStreams.length,
    streamsBefore + 1,
  );
  stopSession("v1");

  // 半截状态:**start 到一半失败**时,那个 sessionId 必须能被重新 start。
  sherpaStub.__failNextLoad();
  resetRecognizerCache();
  const failMsg = await messageOf(() => startSession("v-half", "zh-CN", "zipformer"));
  check("半截 start 确实失败了", failMsg.length > 0, failMsg);
  resetRecognizerCache(); // 修好(模拟下次录音)
  await startSession("v-half", "zh-CN", "zipformer");
  eq(
    "★ 半截失败的 sessionId 可以被重新 start(没被卡住)",
    stopSession("v-half").text === "" ? "started" : "stuck",
    "started",
  );

  // cancel 之后不许再有推送。
  stubWindow.resetPushes();
  feedPcm("v-half", new Float32Array([0.5]));
  eq("★ cancel 之后喂音频不再推任何东西", stubWindow.pushes.length, 0);
  eq("★ cancel 之后 stop 是空操作", stopSession("v-half").text, "");

  // cancel 必须**优雅关闭原生流**(inputFinished),而不是只丢引用 —— 否则反复取消
  // 会累积悬着的原生 OnlineStream。stub 把 `inputFinished` 记进模块级 `calls` 账本。
  {
    resetRecognizerCache();
    await startSession("v-cancel", "zh-CN", "zipformer");
    sherpaStub.resetRecorder();
    cancelSession("v-cancel");
    eq(
      "★ cancel 对原生流调了 inputFinished(不是直接丢引用)",
      sherpaStub.calls.filter((c) => c === "inputFinished").length,
      1,
    );
  }

  // ★★ 同一条纪律的另一处:commitSegment 里那条「reset 之后引擎还留着上下文 →
  //    换掉整条流」的分支(`speechRecognizer.ts` `s.stream = rec.createStream()`)。
  //    丢掉旧原生流之前必须 `inputFinished()`,否则每触发一次就漏一个悬着的
  //    OnlineStream —— 与 cancelSession 那次(M19)是同形状的泄漏。
  //    真包 reset 后是空的,所以这一支平时跑不到;`__keepAfterReset(true)` 把
  //    「引擎没扛住 reset」那种 build 造出来,才能验到它。
  {
    resetRecognizerCache();
    sherpaStub.resetRecorder();
    installModel(M1);
    setSelectedModel(M1);
    await startSession("v-rebuild", "zh-CN", "zipformer");
    sherpaStub.__setResultText("重复的句子");
    sherpaStub.__keepAfterReset(true);
    sherpaStub.resetRecorder();
    // 喂够 1.2 s 的静音(16000×1.2 = 19200 采样),触发我们自己的静音兜底 →
    // commitSegment → reset 后仍有文字 → 走换流分支。5×4000 = 20000 采样。
    for (let i = 0; i < 5; i++) feedPcm("v-rebuild", new Float32Array(4000));
    sherpaStub.__keepAfterReset(false);
    sherpaStub.__setResultText("");
    eq(
      "★ reset 后引擎还留着上下文时确实换了整条流(这一支真的被触发了,不是空过)",
      sherpaStub.createdStreams.length,
      1,
    );
    eq(
      "★★ 换流之前对**被丢掉的那条**原生流调了 inputFinished(漏了就是每触发一次漏一条原生流)",
      sherpaStub.calls.filter((c) => c === "inputFinished").length,
      1,
    );
    stopSession("v-rebuild");
  }

  // ── (e) 识别产出文字时,推的那一帧要带上 `channel` ──
  //  preload 是按 `msg.channel === IPC.VOICE_RESULT` 过滤的 —— 缺了它渲染端
  //  一条都收不到,而主进程这边看起来"发出去了"。
  resetRecognizerCache();
  stubWindow.resetPushes();
  await startSession("v-text", "zh-CN", "zipformer");
  sherpaStub.__setResultText("今天天气不错。");
  sherpaStub.__setReady(1);
  feedPcm("v-text", new Float32Array([0.5, 0.5, 0.5]));
  const partials = stubWindow.pushesOn(IPC.VOICE_RESULT);
  eq("★ feed 之后推的是 partial(边听边出)", partials.at(-1)?.payload.kind, "partial");
  eq("★ 那一帧的文字就是识别结果", partials.at(-1)?.payload.text, "今天天气不错。");
  eq("★ 那一帧带 channel 字段(少了它 preload 直接丢掉)", partials.at(-1)?.payload.channel, IPC.VOICE_RESULT);
  eq("★ sessionId 对得上", partials.at(-1)?.payload.sessionId, "v-text");

  // 「停止」时 decoder 已经排空(`isReady()` 归 false),文字**只剩**已提交的那段 ——
  // 这正是用户按停止键时的常见现场。
  sherpaStub.__stopDecoder();
  stubWindow.resetPushes();
  const finalText = stopSession("v-text").text;
  eq("★ stop 拿到的就是识别出来的文字", finalText, "今天天气不错。");
  const results = stubWindow.pushesOn(IPC.VOICE_RESULT);
  eq("★ stop 推了一帧 voice:result(final)", results.length, 1);
  eq("★ 那一帧 kind 是 final", results[0]?.payload.kind, "final");
  eq("★ 那一帧带 channel 字段(少了它渲染端收不到最终文字)", results[0]?.payload.channel, IPC.VOICE_RESULT);
  eq("★ final 的文字是完整的(不是只有最后一个字)", results[0]?.payload.text, "今天天气不错。");
  sherpaStub.__setResultText("");
  sherpaStub.__stopDecoder();

  // warmup 不该把错误抛给调用方(它在启动 8 秒后被无保护地调用)。
  let warmupThrew = false;
  let warmupUnhandled: unknown = null;
  const onUnhandled = (e: unknown): void => {
    warmupUnhandled = e;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    setSelectedModel("不存在的模型");
    resetRecognizerCache();
    warmupRecognizer();
    await new Promise((r) => setTimeout(r, 20));
  } catch (err) {
    warmupThrew = true;
  }
  process.off("unhandledRejection", onUnhandled);
  eq("★ warmup 吞掉错误(否则启动路径上会是个 unhandled rejection)", warmupThrew, false);
  eq("★ 而且它确实没漏出去变成 unhandledRejection", warmupUnhandled, null);
  setSelectedModel(M1);
  resetRecognizerCache();
}

/* ════════════════════════ §6 走真的 IPC handler ════════════════════════ */

console.log("\n§6 用户点的那条路:真的 handler,不是复述");

{
  // 校验真的拦在门口(zod) —— ⚠️ `call()` 保持 schema 拒绝(rejection),
  // 这才是渲染端拿到的形状:`MicButton` 的 `start()` 捕到之后弹的是
  // `chat.voice.engineFail`,而 `NO_MODEL_ERROR_RE` 那条通路捕的才是
  // 「尚未选择语音模型…」。所以下面两条用 `catch` 而不是 `messageOf`。
  const emptySession = await call(IPC.VOICE_START, {
    sessionId: "",
    lang: "zh-CN",
    engine: "zipformer",
  }).then(
    () => null,
    (e: Error) => e,
  );
  check("★ 空 sessionId 被 schema 挡住(ZodError,不是静默通过)", !!emptySession, emptySession?.name);
  const noModelId = await call(IPC.VOICE_SELECT_MODEL, {}).then(
    () => null,
    (e: Error) => e,
  );
  check(
    "★ 缺 modelId 被 schema 挡住(而且是同步 handler 的同步抛,没有逃逸)",
    !!noModelId,
    noModelId?.name,
  );

  // ── modelList:界面拿它渲染整块面板 ──
  installModel(M1);
  setSelectedModel(M1);
  const listed = (await call(IPC.VOICE_MODEL_LIST)) as Record<string, unknown>;
  same(
    "★ modelList 报的模型就是 catalog 那两条",
    (listed.models as Array<{ id: string }>).map((m) => m.id),
    VOICE_MODEL_CATALOG.map((m) => m.id),
  );
  eq("★ 已下载那份里包含 M1", (listed.downloaded as string[]).includes(M1), true);
  eq("★ 选中那份是 M1", listed.selected, M1);
  eq(
    "★ 根报的是当前那个(设置行要显示它)",
    resolve(listed.modelDir as string),
    resolve(voiceModelRoot()),
  );
  eq("isCustom 对得上", listed.isCustom, true);

  // ── start/feed/stop 真走一遍 ──
  stubWindow.resetPushes();
  sherpaStub.calls.length = 0; // 只数这一段喂进去的
  await call(IPC.VOICE_START, { sessionId: "ipc1", lang: "zh-CN", engine: "zipformer" });
  // feed 的两种线上形状都要收(number[] 与 Float32Array)。
  await call(IPC.VOICE_FEED, { sessionId: "ipc1", pcm: [0.1, 0.2, 0.3] });
  await call(IPC.VOICE_FEED, { sessionId: "ipc1", pcm: new Float32Array([0.1, 0.2, 0.3]) });
  const fed = sherpaStub.calls.filter((c) => c === "acceptWaveform").length;
  eq("★ 两种 pcm 形状都真的喂进引擎了(老的 number[] 不能因为升级就断)", fed, 2);
  sherpaStub.__setResultText("喂进来的音频。");
  sherpaStub.__setReady(1);
  const stopped = (await call(IPC.VOICE_STOP, { sessionId: "ipc1" })) as { text: string };
  eq("★ stop 回的是识别结果", stopped.text, "喂进来的音频。");
  sherpaStub.__setResultText("");
  sherpaStub.__stopDecoder();

  // ── 没选模型时,start 那条 rejection 的原文就是用户看到的那行字 ──
  setSelectedModel("");
  resetRecognizerCache();
  stubWindow.resetPushes();
  const noModelMsg = await messageOf(() =>
    call(IPC.VOICE_START, { sessionId: "ipc2", lang: "zh-CN", engine: "zipformer" }),
  );
  check(
    "★ 走到界面那一层的原文指了路(设置 → 语音输入)",
    noModelMsg.includes("设置") && noModelMsg.includes("语音输入"),
    noModelMsg,
  );
  eq("★ 而且没有推任何东西给界面(不是「静默不工作」)", stubWindow.pushes.length, 0);
  setSelectedModel(M1);
  resetRecognizerCache();

  // ── 未知模型下载:fire-and-forget,调用端**看不到**任何错误 ──
  //    界面只给 catalog 里的模型按钮,所以这条路今天够不到;但它是一个静默分支
  //    (`.catch(() => {})`),钉住它,免得将来有人拿它做"重下"入口。
  stubWindow.resetPushes();
  const dlUnknown = await messageOf(() =>
    call(IPC.VOICE_DOWNLOAD_MODEL, { modelId: "不存在的模型" }),
  );
  eq("★ 未知模型下载:IPC 层**不报错**(错误被 catch 掉了)", dlUnknown, "");
  eq(
    "★ 而且界面也不会收到任何进度帧(点了「下载」什么都没发生)",
    stubWindow.pushesOn(IPC.VOICE_DOWNLOAD_PROGRESS).length,
    0,
  );

  // ── selectModel / getModelDir / setModelDir ──
  await call(IPC.VOICE_SELECT_MODEL, { modelId: M2 });
  eq("★ selectModel 落盘了", selectedModelId(), M2);
  await call(IPC.VOICE_SELECT_MODEL, { modelId: M1 });

  const dirInfo = (await call(IPC.VOICE_GET_MODEL_DIR, {})) as {
    modelDir: string;
    isCustom: boolean;
  };
  eq(
    "getModelDir 与 listModels 报的是同一个根",
    resolve(dirInfo.modelDir),
    resolve(listed.modelDir as string),
  );

  // ★ 无参方法:`app_api_call` 对无参方法**明确让模型省略 input**(tools.ts 的
  //   `input` 是 `.optional()`),那时 handler 收到的是 `undefined`。`GetVoiceModelDirSchema`
  //   是 `z.object({})`,`.parse(undefined)` 抛 "Required" —— 渲染端走 `{}` 掩盖了它,
  //   模型会拿到一句 zod 报错而不是目录。同 `context.get` 的 ?#115。
  {
    const viaOmitted = (await call(IPC.VOICE_GET_MODEL_DIR, undefined)) as {
      modelDir: string;
    };
    eq(
      "★ getModelDir 接受省略的 input(undefined)",
      resolve(viaOmitted.modelDir),
      resolve(listed.modelDir as string),
    );
  }

  const badDir = await messageOf(() => call(IPC.VOICE_SET_MODEL_DIR, { modelDir: "C:\\" }));
  check("★ 坏目录经过 IPC 之后仍然是显式报错", /驱动器根目录/.test(badDir), badDir);

  // ★★ `voice.setModelDir` 的职责里有一条**不在 models.ts 里**:换根之后必须把
  //     已经建好的识别器丢掉。不丢的话缓存指向的是**旧根下的文件** —— 如果用户
  //     把模型搬走/删了,下一次录音会用一个打不开的模型去听。
  //     `resetRecognizerCache()` 就是那句;这里走真的 handler 验它。
  {
    const OTHER_ROOT = join(SCRATCH, "IPC 换过去的根");
    mkdirSync(OTHER_ROOT, { recursive: true });
    // 先在**当前**根上把识别器建热(缓存里有东西,才谈得上"该不该丢")。
    installModel(M1);
    resetRecognizerCache();
    await call(IPC.VOICE_START, { sessionId: "ipc-warm", lang: "zh-CN", engine: "zipformer" });
    await call(IPC.VOICE_STOP, { sessionId: "ipc-warm" });
    const before = sherpaStub.builtConfigs.length;

    // 换根 —— 然后**不手工 reset**,要验的就是 handler 自己有没有做。
    await call(IPC.VOICE_SET_MODEL_DIR, { modelDir: OTHER_ROOT });
    // 新根里放一份同样的模型文件(用户自己搬过来的那种情形)。
    installModel(M1);
    await call(IPC.VOICE_START, { sessionId: "ipcdir", lang: "zh-CN", engine: "zipformer" });
    await call(IPC.VOICE_STOP, { sessionId: "ipcdir" });

    eq("★★ 走 IPC 换根之后识别器重建了(handler 自己丢了缓存)", sherpaStub.builtConfigs.length, before + 1);
    check(
      "★★ 而且重建之后读的是新根下的文件(不是旧根里那一份)",
      resolve(sherpaStub.builtConfigs.at(-1)!.modelConfig.transducer.encoder as string).startsWith(
        resolve(OTHER_ROOT),
      ),
      sherpaStub.builtConfigs.at(-1)!.modelConfig.transducer.encoder,
    );
    setCustomModelRoot(GOOD_ROOT);
    resetRecognizerCache();
  }

  const resetDir = (await call(IPC.VOICE_SET_MODEL_DIR, { modelDir: "" })) as {
    isCustom: boolean;
  };
  eq("★ 空串 = 恢复默认", resetDir.isCustom, false);

  // ── removeModel:真的能删,并且把选中的那一个改指向别的 ──
  {
    installModel(M2);
    await call(IPC.VOICE_SELECT_MODEL, { modelId: M2 });
    eq("清场:M2 装着而且被选中", existsSync(modelDirFor(M2)), true);
    await call(IPC.VOICE_REMOVE_MODEL, { modelId: M2 });
    eq("★ 删完之后文件真的没了", existsSync(modelDirFor(M2)), false);
    eq(
      "★ 选中的那个不能让用户对着一个已经不存在的模型(回落或清空)",
      selectedModelId() === M2 ? "still-deleted" : "moved-away",
      "moved-away",
    );
    eq("★ 删完之后它不在「已下载」里", listModels().downloaded.includes(M2), false);
  }

  // ── 下载失败那条路走**真 handler**:界面靠这帧 error 显示失败原因 ──
  {
    wipeModel(M2);
    serverMode = "fail500";
    stubWindow.resetPushes();
    await call(IPC.VOICE_DOWNLOAD_MODEL, { modelId: M2 });
    const got = await waitFor(
      () => progressFrames(M2).some((f) => f.stage === "error"),
      25_000,
    );
    check(
      "★ 下载失败时界面**收得到**那条 error 帧(否则面板一直转)",
      got,
      progressFrames(M2).map((f) => f.stage),
    );
    const errFrame = progressFrames(M2).find((f) => f.stage === "error");
    check(
      "★ 那帧的 error 文案不是空的",
      typeof errFrame?.error === "string" && errFrame.error.length > 0,
      errFrame,
    );
    // 取消一条已经结束的下载:必须是安全的空操作。
    await call(IPC.VOICE_CANCEL_MODEL_DOWNLOAD, { modelId: M2 });
    eq("★ 对已经结束的下载再取消是空操作", isDownloading(M2), false);
    serverMode = "ok";
  }
}

/* ════════════════════════ §7 空过守卫 ════════════════════════ */

console.log("\n§7 这套断言有没有「登记了却没人命中」");

{
  check(
    "★ 桩识别器真的被用到了(没有它 §3/§5 全是空转)",
    sherpaStub.builtConfigs.length > 0,
    sherpaStub.builtConfigs.length,
  );
  check(
    "★ 桩窗口真的收到过推送(没有它所有「界面收到什么」的断言全是空转)",
    stubWindow.pushes.length > 0,
    stubWindow.pushes.length,
  );
  check("★ 「卡住第一个 GET」这条夹具真的被触发过", serverHeld, serverHeld);
  check(
    "★ 两个本地服务都真的被请求过(HF 与镜像的兜底不是空转)",
    serverHits > 0 && srvA.port > 0 && srvB.port > 0,
    { hits: serverHits, a: srvA.port, b: srvB.port },
  );
  check("断言总数 > 0", total > 0, total);
}

/* ════════════════════════ 收尾 ════════════════════════ */

await new Promise<void>((r) => srvA.server.close(() => r()));
await new Promise<void>((r) => srvB.server.close(() => r()));
rmSync(DATA, { recursive: true, force: true });
rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\nvoice-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
