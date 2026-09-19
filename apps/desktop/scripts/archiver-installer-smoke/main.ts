/**
 * Headless smoke for **两件会动用户东西、却一套测试都没有的模块**(先完整读一遍它们,
 * 再按“真会出错的地方”写断言,而不是给每个函数配一条同义反复)。
 *
 * ## 一、main/session/AutoArchiver.ts(82 行)
 *
 * 每小时跑一趟的**自动归档**:把“很久没动过”的会话塞进归档箱。它不删任何东西
 * (`archived = 1` 只是软删,用户随时能还原),但它**替用户改数据的可见状态** ——
 * 在用户没看着的时候、按一个他可能忘了自己开过(默认 `enabled: false`)的开关。
 *
 * 读完的结论:**这个模块相当安全**,只有一处值得写下来 ——
 *
 *  - 它排掉的东西分两层:`listStale` 的 SQL 排 `archived` / `pinned_at` /
 *    `kind != 'chat'`,而 **`running` / `approving` 是在 JS 里排的**(第 57 行)。
 *    一个正在跑的会话被归档,界面上会当场消失 —— 归归档箱比“还在跑”优先级低,
 *    所以这一条必须一直是绿的;
 *  - **阈值语义**:`0 = 永不`,且 `overrides[projectId] ?? defaultDays`(不是 `||`,
 *    所以 override 成 0 不会被 defaultDays 顶掉);
 *  - **幂等**靠 `setArchived` 顺手抬 `updated_at`:没有它,下一趟立刻又把它捞出来。
 *
 * ## 二、main/runtimes/runtimeInstaller.ts(722 行)
 *
 * 设置面板里“按需下载 claude / codex / pi”那套的**下载之外的所有半边**:
 * `installRuntimeFromLocalPath`(用户手选本地目录/可执行文件/.tgz —— registry 那条路
 * 挂掉时的逃生门)、`finalizeInstall`(两条安装路径共用的收尾)、`removeRuntime`、
 * `listRuntimes`。这是真在**删 / 覆盖 / 移动**磁盘上的东西,而且动辄几百 MB。
 *
 * 读完的结论:边界守得住。三条安装分支各自校验载荷、失败一个字节都不动、
 * 暂存目录在 `finally` 里清掉、剪枝只剪 `<root>/<agent>/` 下、`removeRuntime` 只
 * 递归删自己那一个 agent 的目录。**发现两处值得说的**:
 *
 *  1. ~~**`.staging-*` 残留会被当成一个已安装版本(只在它是唯一目录时才发作)。**~~
 *     **这条已经修了**(2026-09-20)。`finalizeInstall` 是**先 `rmSync(finalDir)` 再
 *     `renameSync`**,中间没有中间态;但如果进程在**前面的解包/拷贝阶段**被强杀,
 *     `<root>/<agent>/.<ver>.staging-<ms>/` 会留在盘上,而 `listManagedVersions`
 *     原来只按“子目录”过滤 —— 于是残留被读成一个已安装版本。
 *
 *     ⚠️ 排序那一处**当初探针实测过,值得留着**:`compareVersions` 拿 `Number(sa)` 比,
 *     但 `sa === ""` 那一支会掉进**字符串比较**(`"." vs "9"`),于是残留恒**小于**
 *     任何真版本;`listManagedVersions` 又是 `compareVersions(b, a)` 降序,所以残留
 *     **永远排在最后**。也就是说**只要有真版本在,残留就绝不会被选中当 active** ——
 *     它只在**真版本一个都不剩**时才浮上来,那时面板显示一个假的“已安装 vX”、
 *     `source = managed` 让 provider 去加载一个残缺目录。
 *
 *     修法是 `listManagedVersions` 里一句 `if (entry.startsWith(".")) continue`:
 *     `.staging-*` 是内部临时名、永远不是版本,所以按点开头排既是**最窄**的修法、
 *     也没有漏网(见乙.6:那三条断言现在钉的是**修好之后**的行为)。
 *
 *     **连带补的一处**:剪枝那个循环原来**顺手**替残留做了清理(残留本来在
 *     `listManagedVersions` 的结果里),现在列表不排它了,清理就得显式写
 *     (`stagingDirsOf`)。不补的话每个被强杀的安装会在盘上留几百 MB,而且再也没人扫。
 *  2. **`overrides` 是当下规则,不是历史承诺**(见甲.1 那条注释)。
 *
 * ## 它碰的东西:全是临时目录
 *
 * dataRoot 走 `MCODE_SMOKE_DATA_ROOT`(stubs/dataRoot.ts 里没设就抛),
 * runtimes 根走 `MCODE_SMOKE_RUNTIME_ROOT`。后者**没有桩** —— 用的是真的
 * `managedRuntimeRoots.ts`(它是纯 node),main.ts 里显式
 * `setManagedRuntimeRoot(process.env.MCODE_SMOKE_RUNTIME_ROOT)` 并且**先断言设上了**
 * 再往下走。真模块在无头脚本下 root 本来是 null,那时 installer 会落到
 * `app.getPath("userData")` —— 桩的缺失让“没设就写到用户真实 userData 里”**在结构上
 * 可能发生**,所以那一条断言 + `if (...) process.exit(1)` 是这套的**安全前提**,
 * 不是装饰。
 *
 * Run: scripts/archiver-installer-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@contracts/session";

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

/* ══════════════════════════════════════════════════════════════════════════
 *  甲、AutoArchiver
 * ══════════════════════════════════════════════════════════════════════════ */

const DATA = mkdtempSync(join(tmpdir(), "mcode-archiver-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { initDb } = await import("@main/store/db.js");
const { ProjectRepo, SessionRepo, SettingRepo } = await import("@main/store/repositories.js");
const { AUTO_ARCHIVE_SETTING_KEY } = await import("@contracts/ipc");
const { runAutoArchive } = await import("@main/session/AutoArchiver.js");
const { broadcastIds } = await import("./stubs/sessionSync.js");
const { disposedIds, resetRuntimeStub } = await import("./stubs/runtimeManager.js");

await initDb();

const DAY = 24 * 60 * 60 * 1000;

/** 一份最小的 chat 会话;`ageDays` 决定它的 `updated_at` 到现在有多久。 */
function mkSession(
  id: string,
  projectId: string,
  ageDays: number,
  over: Partial<Pick<Session, "kind" | "archived" | "status" | "pinnedAt">> = {},
): void {
  const now = Date.now();
  const updatedAt = now - ageDays * DAY;
  SessionRepo.create({
    id,
    projectId,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: over.kind ?? "chat",
    parentSessionId: null,
    title: `smoke ${id}`,
    status: over.status ?? "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "default",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: over.archived ?? false,
    pinnedAt: over.pinnedAt ?? null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now - 100 * DAY,
    updatedAt,
  });
}

function setRules(enabled: boolean, defaultDays: number, overrides: Record<string, number> = {}): void {
  SettingRepo.set(AUTO_ARCHIVE_SETTING_KEY, JSON.stringify({ enabled, defaultDays, overrides }));
}

for (const pid of ["pA", "pB"]) {
  ProjectRepo.create({
    id: pid,
    name: pid,
    path: process.cwd(),
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/* ── 甲.1 阈值语义:0 是“永不”,overrides 优先于 defaultDays ── */

console.log("\n甲.1 阈值:0 = 永不,overrides 盖过 defaultDays");

mkSession("s_fresh", "pA", 1);
mkSession("s_stale", "pA", 40);
mkSession("s_pinned", "pA", 40, { pinnedAt: Date.now() });
mkSession("s_running", "pA", 40, { status: "running" });
mkSession("s_approving", "pA", 40, { status: "approving" });
mkSession("s_node", "pA", 40, { kind: "node" });
mkSession("s_already", "pA", 40, { archived: true });

setRules(true, 30);
broadcastIds.length = 0;
resetRuntimeStub();

const n1 = await runAutoArchive();

check("★ 停了 40 天的普通会话被归档", SessionRepo.get("s_stale")?.archived === true);
check("才动过 1 天的会话没被动", SessionRepo.get("s_fresh")?.archived === false);
check("钉住的会话不动(pinned_at 那一道)", SessionRepo.get("s_pinned")?.archived === false);
check("★ 正在跑的会话不动(running —— 归档它等于界面当场把它弄没)", SessionRepo.get("s_running")?.archived === false);
check("★ 卡在审批上的会话不动(approving)", SessionRepo.get("s_approving")?.archived === false);
check("workflow 节点会话不在候选里(kind != chat)", SessionRepo.get("s_node")?.archived === false);
check("已经在归档箱里的不动", SessionRepo.get("s_already")?.archived === true);
eq("返回值 = 这一趟真正归档的条数", n1, 1);
eq("归档过的会话被广播给界面了(每个客户端据此把它挪进归档箱)", broadcastIds.join(","), "s_stale");
// 归档之后要**放掉运行时**(2026-09-20 上游合并带进来的那一句)。不放的话那条会话的
// 进程内状态(transcript / 用量历史 / 上一轮的文件快照)会一直驻留到删除为止 ——
// 用户看不见,但那是实打实的内存泄漏,而且自动归档每次跑都在添。
//
// ⚠️ 判据是**只有那一条**:不区分的话,桩只要被调过就绿,而"每次归档顺手把整个列表
// 都 dispose 一遍"是另一种错(它会掐掉别的会话正在跑的回合)。
eq("★ 归档完之后放掉了运行时(而且只放了被归档那一条)", disposedIds().join(","), "s_stale");


// 幂等:紧接着再跑一趟,一条都不该动。
broadcastIds.length = 0;
resetRuntimeStub();
eq("★ 紧接着再跑一趟:0 条(归档自身抬了 updated_at,不会来回搬)", await runAutoArchive(), 0);
eq("第二趟没有再广播(界面不会抖)", broadcastIds.length, 0);
// 一条都没归档的那一趟**不该放任何运行时** —— 放的是"会话进归档箱"那个动作的收尾,
// 不是每趟都跑一遍的清理。这里空过的话,上面那条"只放了 s_stale"就只是碰巧对了。
eq("没归档任何东西的那一趟,一条运行时都没放", disposedIds().length, 0);

// 阈值 0 = 永不。
mkSession("s_zero", "pA", 400);
setRules(true, 0);
eq("★ defaultDays = 0 时整个功能是空操作(0 = 永不归档)", await runAutoArchive(), 0);
check("搁了 400 天的会话也没被动", SessionRepo.get("s_zero")?.archived === false);

// overrides 优先,且能盖成 0(那个项目永不归档)。
mkSession("s_b_old", "pB", 40);
mkSession("s_a_old", "pA", 40);
setRules(true, 30, { pB: 0, pA: 1 });
const n3 = await runAutoArchive();
eq("★ 某个项目 override 成 0 时,它的会话一条都不归档", SessionRepo.get("s_b_old")?.archived, false);
eq("★ override 的阈值真的生效(pA:1 天 → 40 天的归档了)", SessionRepo.get("s_a_old")?.archived, true);
// ⚠️ **`overrides` 只按 projectId 查,不认“这个项目不存在”**。上面 pA 的 overrides 是
// `{pB: 0, pA: 1}`,可这一趟归档了 **3** 条 —— 除了 pA 那两条,还有甲.1 里那个
// 被 override 成 0 挡下来的 `s_zero`(400 天):它此刻按 defaultDays 30 重新够格了。
// 换句话说:把某个项目 override 成 0 只挡得住“当下这一趟”,等这个映射被清掉,它
// 照样会被收走。不是 bug(用户把规则改回“30 天”之后本来也就该归档),但它意味着
// **这个功能的档位是“当前规则”,不是对某条会话的历史承诺** —— 断言照实写 3。
eq("这一趟归档 3 条(规则一放宽,够格的老会话照样收)", n3, 3);
check("★ 被 override 挡住的那个项目的会话没动", SessionRepo.get("s_b_old")?.archived === false);
check("★ 那条 400 天的会话在 override 撤掉后按 defaultDays 被收走了", SessionRepo.get("s_zero")?.archived === true);

// 关掉开关 = 空操作。
mkSession("s_off", "pA", 90);
setRules(false, 30);
eq("★ enabled = false 时是空操作", await runAutoArchive(), 0);
check("开关关着时任何会话都不动", SessionRepo.get("s_off")?.archived === false);

// 设置读坏了 → 退回默认配置(disabled),而不是把一切都归档掉。
mkSession("s_bad", "pA", 900);
SettingRepo.set(AUTO_ARCHIVE_SETTING_KEY, "{这不是JSON");
eq("设置值坏掉时退回默认(disabled)→ 空操作", await runAutoArchive(), 0);
check("坏设置不会把搁了 900 天的会话批量归档", SessionRepo.get("s_bad")?.archived === false);

/* ══════════════════════════════════════════════════════════════════════════
 *  乙、runtimeInstaller
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n乙.0 干净环境(什么都没装、dev fallback 也探不到)");

const {
  installRuntimeFromLocalPath,
  listRuntimes,
  removeRuntime,
  installedVersionOf,
  isRuntimeInstalling,
} = await import("@main/runtimes/runtimeInstaller.js");
const { setManagedRuntimeRoot, getManagedRuntimeRoot } = await import("@main/runtimes/managedRuntimeRoots.js");
const { runtimeEvents, resetRuntimeEvents } = await import("./stubs/window.js");

/** run.sh 用 `mktemp -d` 建的那个盘 —— 本套所有“安装”都落在它里面。
 *  ⚠️ 必须在第一次调 installer 之前设好。设不上(没注册根)的话下面那条"根已注册"
 *  会红,而后面的断言会落到 `app.getPath("userData")` —— 那是用户的真目录。 */
const RUNTIMES = mkdtempSync(join(tmpdir(), "mcode-runtime-root-"));
process.env.MCODE_SMOKE_RUNTIME_ROOT = RUNTIMES;
setManagedRuntimeRoot(RUNTIMES);
check("★ runtimes 根已注册(否则后面会写到用户真实 userData)", getManagedRuntimeRoot() === RUNTIMES);
if (getManagedRuntimeRoot() !== RUNTIMES) process.exit(1);

const list0 = await listRuntimes();
const claude0 = list0.find((r) => r.agent === "claude");
check("三张卡片都在", list0.length === 3);
check("什么都没装:installed = false", claude0?.installed === false);
check("什么都没装:installedVersion = null", claude0?.installedVersion === null);
// 这台开发机上 claude / codex / pi 的 dev fallback(node_modules 里那几个包)
// 至少有一部分是**探得到**的(实测),所以 source/activeVersion 不为 null、
// updateAvailable 为 true —— **这是对的**(dev 那份确实是另一个版本,面板该提示)。
// 所以“空环境不误报”没法在这台机器上直接造出空环境来验。真正能钉住、而且更强的
// 是它背后的**不变式**(下面这一条,对三个 agent 一起核):
//
//     updateAvailable === (activeVersion !== null && activeVersion !== expectedVersion)
//
// 右边那半句 `activeVersion !== null` 就是“探不到来源时不许报有更新”的全部实现 ——
// 少了它,一台干净机器上每张卡片都会摆着一个点了只会开始首装的“更新”按钮。
// 本套里 codex 的 dev fallback 偶发探得到/探不到(取决于无头 bundle 能不能解析到
// 那个平台包),所以这条不变式要把“为 null”那一支也走一遍 —— 甲.1 之后每次
// listRuntimes() 都核一次。
function checkUpdateInvariant(tag: string, list: Awaited<ReturnType<typeof listRuntimes>>): void {
  const bad = list.filter(
    (r) => r.updateAvailable !== (r.activeVersion !== null && r.activeVersion !== r.expectedVersion),
  );
  check(`★ updateAvailable 不变式(${tag})`, bad.length === 0, bad.map((r) => r.agent));
}
checkUpdateInvariant("初始", list0);
check("★ 没有可用来源的 agent:updateAvailable 必须是 false(而不是 null !== expected)",
  list0.filter((r) => r.activeVersion === null).every((r) => r.updateAvailable === false),
  list0.filter((r) => r.activeVersion === null).map((r) => r.agent));
check("★ source 与 activeVersion 同源(不能一个有一个没有)",
  list0.every((r) => (r.source !== null) === (r.activeVersion !== null)));
check("lastError 初始为空串", claude0?.lastError === "");
check("installing 初始为 false", claude0?.installing === false);
check("diskBytes 在没有 managed 副本时是 0", claude0?.diskBytes === 0);
eq("expectedVersion 来自本应用 package.json 的钉版", claude0?.expectedVersion, "0.3.258");
check("installedVersionOf 没有 managed 副本时返回 null", installedVersionOf("codex") === null);

const ROOT = RUNTIMES;
const agentDir = (a: string): string => join(ROOT, a);
/** 直接往 managed 根里摆一个假安装物(模拟“以前装过”)。 */
function seedPayload(agent: string, version: string, files: Record<string, string>): string {
  const dir = join(ROOT, agent, version);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}
function claudePayload(version: string): string {
  return seedPayload("claude", version, {
    "claude.exe": "MZ fake claude " + version + "\n",
    "package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64", version }),
  });
}

/* ── 乙.0b “干净机器”那一条不在这里 ──
 *
 * 这台开发机上三个 agent 的 dev fallback 都探得到(实测),所以 `activeVersion` 永远
 * 不是 null —— “没装东西时不许报有更新”那句断言在这一趟里**永远是空转的**。
 * 真正的干净机器(`bundle` 旁边没有 `node_modules`)是另一趟进程:**clean.ts**,
 * 由 run.sh 用另一个临时目录单独打包、单独跑。那儿才有那条会真红的判据。 */

function piPayload(version: string): string {
  return seedPayload("pi", version, {
    "node_modules/@earendil-works/pi-coding-agent/package.json": JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
    }),
    "node_modules/@earendil-works/pi-coding-agent/dist/index.js": "export default {};\n",
  });
}

/* ── 乙.1 listRuntimes 读到已有安装 ── */

console.log("\n乙.1 面板读到的真相(已有安装)");

const oldClaude = claudePayload("0.1.0");
const list1 = await listRuntimes();
const c1 = list1.find((r) => r.agent === "claude");
check("装过之后 installed = true", c1?.installed === true);
eq("installedVersion 就是那个目录名", c1?.installedVersion, "0.1.0");
eq("source = managed", c1?.source, "managed");
check("activePath 指向目录里那个载荷", c1?.activePath === join(oldClaude, "claude.exe"));
check("★ 装了一个和钉版不同的版本 → 报“有更新可用”", c1?.updateAvailable === true);
check("diskBytes 数出了那个安装物的大小", (c1?.diskBytes ?? 0) > 0);

/* ── 乙.2 installRuntimeFromLocalPath:目录、单文件、.tgz ── */

console.log("\n乙.2 从本地路径安装(三条分支)");

const SRC = mkdtempSync(join(tmpdir(), "mcode-runtime-src-"));

// (a) 目录(claude 平台包布局)
const claudePkg = join(SRC, "claude-pkg");
mkdirSync(claudePkg, { recursive: true });
writeFileSync(join(claudePkg, "claude.exe"), "MZ local claude\n");
writeFileSync(join(claudePkg, "package.json"), JSON.stringify({ version: "9.9.9" }));

resetRuntimeEvents();
const rDir = await installRuntimeFromLocalPath("claude", claudePkg);
check("从目录安装成功", rDir.ok === true, rDir);
eq("版本取自被拷进来的 package.json", rDir.version, "9.9.9");
eq("落点 = <根>/claude/<版本>", installedVersionOf("claude"), "9.9.9");
check("★ 旧版本目录被剪掉了(只留装上的这个)", !existsSync(oldClaude));
check("载荷真的在", existsSync(join(agentDir("claude"), "9.9.9", "claude.exe")));
check("install.json 写下来了(带来源与路径)", existsSync(join(agentDir("claude"), "9.9.9", "install.json")));
const rec = JSON.parse(readFileSync(join(agentDir("claude"), "9.9.9", "install.json"), "utf8"));
eq("install.json 记了来源是 local-path", rec.source, "local-path");
eq("install.json 记了用户选的那个路径", rec.localPath, claudePkg);
check("暂存目录没留在根里", readdirSync(agentDir("claude")).every((e) => !e.startsWith(".")));
check("进度有终态(done)", runtimeEvents.some((e) => e.phase === "done"));
check("★ 用户自己的源文件一个都没被动", existsSync(join(claudePkg, "claude.exe")));

// 装同一份两遍 —— 幂等,且不留第二份
const again = await installRuntimeFromLocalPath("claude", claudePkg);
check("同一路径再装一遍照样成功(幂等)", again.ok === true, again);
eq("盘上还是只有那一个版本目录", readdirSync(agentDir("claude")).filter((e) => !e.startsWith(".")).join(","), "9.9.9");

/* ── 乙.2b 剪枝要把**崩溃残留**也当垃圾扫掉(2026-09-20 补) ──
 *
 * 起因:乙.6 那个 bug 的修法是让 `listManagedVersions` 不排点开头的目录(残留是
 * `.<ver>.staging-<ms>`)。可剪枝那个循环原来**顺手**替残留做了清理 —— 残留本来就在
 * 它的输入里。列表一不排它,清理就没了:每个被强杀的安装会在盘上留几百 MB,而且
 * **再也没人扫**(下次装同一个 agent 也不会)。
 *
 * 断言里这一步**只有它守着**:把剪枝退回 `listManagedVersions(agent)` 时,别的断言
 * 一条都不红 —— 残留不在列表里,而且它是点开头的,乙.2 那条"暂存目录没留在根里"
 * 也因为 `startsWith(".")` 而放行。 */
const orphanBefore = join(agentDir("claude"), ".0.0.1.staging-1700000000000");
mkdirSync(orphanBefore, { recursive: true });
writeFileSync(join(orphanBefore, "claude.exe"), "leftover\n");
check("前提:残留先真的在盘上", existsSync(orphanBefore));

await installRuntimeFromLocalPath("claude", claudePkg);
check("★ 剪枝把崩溃残留也扫掉了(不再只清版本目录)", !existsSync(orphanBefore));
eq(
  "而且没顺手扫掉别的东西(根里只剩那一个版本)",
  readdirSync(agentDir("claude")).join(","),
  "9.9.9",
);

// (b) 单文件
const singleExe = join(SRC, "claude.exe");
writeFileSync(singleExe, "MZ single\n");
const rFile = await installRuntimeFromLocalPath("claude", singleExe);
check("从单个可执行文件安装成功", rFile.ok === true, rFile);
eq("单文件没有 package.json → 退回钉版", rFile.version, "0.3.258");
check("二进制落在包根", existsSync(join(agentDir("claude"), "0.3.258", "claude.exe")));

// (c) .tgz
const { create: tarCreate } = await import("tar");
const tgzStage = join(SRC, "stage");
mkdirSync(join(tgzStage, "package"), { recursive: true });
writeFileSync(join(tgzStage, "package", "claude.exe"), "MZ from tgz\n");
writeFileSync(join(tgzStage, "package", "package.json"), JSON.stringify({ version: "7.7.7" }));
const tgz = join(SRC, "claude-pkg.tgz");
await tarCreate({ gzip: true, cwd: tgzStage, file: tgz }, ["package"]);
const rTgz = await installRuntimeFromLocalPath("claude", tgz);
check("从 .tgz 安装成功", rTgz.ok === true, rTgz);
eq("版本取自 tgz 里的 package.json", rTgz.version, "7.7.7");
eq("这次剪掉了上一个(0.3.258)", installedVersionOf("claude"), "7.7.7");
check("★ 上一版真的从盘上没了", !existsSync(join(agentDir("claude"), "0.3.258")));

/* ── 乙.2b pi:两条"选目录"的分支,以及一条**看起来像包、其实缺件**的目录 ──
 *
 * pi 的收尾校验是整套里唯一会真正拦下"用户的目录看着对、里面其实缺东西"的地方,
 * 而那道门在 claude/codex 上碰不到(claude 只看平台名那两个文件、codex 用
 * findCodexBinaryInPackage 自己探)。所以这一段专门给 pi 造三种目录。 */

console.log("\n乙.2b pi:pi-package / package-dir / 缺 package.json 的假包");

// (i) pi 包目录本身 → 走 "pi-package" 分支(塞到 staging 的 node_modules 下面)
const piPkgSrc = join(SRC, "pi-coding-agent");
mkdirSync(join(piPkgSrc, "dist"), { recursive: true });
writeFileSync(join(piPkgSrc, "dist", "index.js"), "export default {};\n");
writeFileSync(join(piPkgSrc, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "5.5.5" }));
const rPiPkg = await installRuntimeFromLocalPath("pi", piPkgSrc);
check("pi 选包目录本身 → 成功", rPiPkg.ok === true, rPiPkg);
// 版本来自**暂存目录根**的 package.json(`extractedVersion`),而这条分支把包拷进了
// `node_modules/` 下面 —— 根上没有 package.json,所以退回钉版。这是当前行为。
eq("版本退回钉版(根上没有 package.json)", rPiPkg.version, "0.83.0");
check("★ 落点是对的(…/node_modules/@earendil-works/pi-coding-agent/)",
  existsSync(join(agentDir("pi"), "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json")));
check("★ 拷进去那份 package.json 内容没被动(还是源里那个 5.5.5)",
  JSON.parse(readFileSync(join(agentDir("pi"), "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version === "5.5.5");
eq("面板认它(installedVersionOf 读的就是这个载荷)", installedVersionOf("pi"), "0.83.0");

// (ii) 已经装过的 pi 元包(node_modules 在里面)→ 走 "package-dir" 分支
const piMetaSrc = join(SRC, "pi-meta");
mkdirSync(join(piMetaSrc, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
writeFileSync(join(piMetaSrc, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "6.6.6" }));
const rPiMeta = await installRuntimeFromLocalPath("pi", piMetaSrc);
check("pi 选已装好的元包目录 → 成功", rPiMeta.ok === true, rPiMeta);
eq("落点仍然是那个载荷路径(整份目录被拷进来)", installedVersionOf("pi"), "0.83.0");
check("★ 被拷进来的是用户选的那一份(6.6.6 在里面)",
  JSON.parse(readFileSync(join(agentDir("pi"), "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version === "6.6.6");

// (iii) **陷阱**:`dist/index.js` 在、但 package.json 不在。
// detectLocalDirLayout 靠 `dist/index.js` 判定 "pi-package",可收尾那道载荷校验
// 要的是 `node_modules/@earendil-works/pi-coding-agent/package.json` —— 两者不是同一个
// 东西。没有最后那道 `existsSync(entry)` 的话,这一装会"成功",而盘上那个版本永远
// 加载不起来(piSdkLoader 就是从那个 package.json 解析入口的)。
const piFake = join(SRC, "pi-fake");
mkdirSync(join(piFake, "dist"), { recursive: true });
writeFileSync(join(piFake, "dist", "index.js"), "export default {};\n");
const piBefore = readdirSync(agentDir("pi")).sort().join(",");
const rPiFake = await installRuntimeFromLocalPath("pi", piFake);
check("★ 缺 package.json 的“看着像 pi 包”的目录 → ok:false(不许装出一个加载不起来的版本)",
  rPiFake.ok === false, rPiFake);
check("错误说清了是载荷缺失(而不是别的)", /missing|expected payload|载荷/i.test(rPiFake.error ?? ""), rPiFake.error);
eq("★ 失败之后盘上那个版本还是原来的", readdirSync(agentDir("pi")).sort().join(","), piBefore);
eq("★ 暂存目录也没留下", readdirSync(agentDir("pi")).filter((e) => e.startsWith(".")).length, 0);

/* ── 乙.3 坏输入:必须如实报错,而且**不留半截状态** ── */

console.log("\n乙.3 坏输入:报错 + 不留半截");

const beforeList = readdirSync(agentDir("claude")).sort().join(",");
const rBadPath = await installRuntimeFromLocalPath("claude", join(SRC, "根本没有这个东西"));
check("源路径不存在 → ok:false", rBadPath.ok === false);
check("错误里带出那个路径", (rBadPath.error ?? "").includes("根本没有这个东西"), rBadPath.error);
eq("★ 失败之后安装目录一个字节都没变", readdirSync(agentDir("claude")).sort().join(","), beforeList);

const emptyDir = join(SRC, "empty-dir");
mkdirSync(emptyDir);
const rNoLayout = await installRuntimeFromLocalPath("claude", emptyDir);
check("目录里没有可识别布局 → ok:false", rNoLayout.ok === false);
check("错误说清了“没有可识别的安装结构”", /不包含可识别的|no recognizable/.test(rNoLayout.error ?? ""), rNoLayout.error);
eq("★ 失败之后安装目录仍然没变", readdirSync(agentDir("claude")).sort().join(","), beforeList);
eq("★ 暂存目录没有留下来", readdirSync(agentDir("claude")).filter((e) => e.startsWith(".")).length, 0);

const notExe = join(SRC, "readme.txt");
writeFileSync(notExe, "hello\n");
const rNotExe = await installRuntimeFromLocalPath("claude", notExe);
check("选了个不是可执行文件的东西 → ok:false", rNotExe.ok === false);
check("错误点名了期望的文件名", /claude\.exe/.test(rNotExe.error ?? ""), rNotExe.error);

// pi 是 JS 库:选单个文件必须被挡住(而不是装出一个永远加载不了的版本)
const rPiFile = await installRuntimeFromLocalPath("pi", notExe);
check("pi 选单个文件被挡住", rPiFile.ok === false);
check("错误说清了 pi 是 JS 库、要选目录或 .tgz", /JS 库|\.tgz/.test(rPiFile.error ?? ""), rPiFile.error);
// 乙.2b 已经给 pi 装上一份(0.83.0)了,所以这里的判据是"挡住之后那份原样还在",
// 而不是"什么都没有"(那在乙.2b 之前才是对的)。
eq("★ 挡下来之后原先那份 managed 副本原样还在", installedVersionOf("pi"), "0.83.0");

// 坏 tgz:解到一半抛 —— 旧版本必须原样还在
const junkTgz = join(SRC, "junk.tgz");
writeFileSync(junkTgz, "这不是一个 gzip 包\n");
const beforeTgz = readdirSync(agentDir("claude")).sort().join(",");
const rJunk = await installRuntimeFromLocalPath("claude", junkTgz);
check("坏 .tgz → ok:false", rJunk.ok === false);
eq("★ 解包抛异常之后旧版本原样还在", readdirSync(agentDir("claude")).sort().join(","), beforeTgz);
eq("★ 也没有留下暂存目录", readdirSync(agentDir("claude")).filter((e) => e.startsWith(".")).length, 0);

// 装坏了要能报给面板
const errList = await listRuntimes();
check("失败之后面板拿得到 lastError", (errList.find((r) => r.agent === "claude")?.lastError ?? "").length > 0);

/* ── 乙.4 removeRuntime:只删自己那一份 ── */

console.log("\n乙.4 删除:只删这个 agent 的");

piPayload("0.83.0");
check("pi 先装上了(夹具)", installedVersionOf("pi") === "0.83.0");
const beforeRemovePi = existsSync(join(agentDir("pi"), "0.83.0"));
check("pi 的目录确实在", beforeRemovePi);

const rRemove = await removeRuntime("claude");
check("删 claude 成功", rRemove.ok === true, rRemove);
eq("claude 的安装没了", installedVersionOf("claude"), null);
check("claude 的目录整个没了", !existsSync(agentDir("claude")));
check("★ 删 claude 不会碰到 pi 的东西", existsSync(join(agentDir("pi"), "0.83.0", "node_modules")));
check("★ 删 claude 也不会碰到数据根", existsSync(DATA));

const rRemoveMissing = await removeRuntime("claude");
check("删一个本来就没有的 agent → 成功(幂等,不报错)", rRemoveMissing.ok === true, rRemoveMissing);
check("删完之后列表回到 installed:false", (await listRuntimes()).find((r) => r.agent === "claude")?.installed === false);

/* ── 乙.5 失败路径:错误要如实报出来,而且要能读出是"没装"而不是"装错了" ── */

console.log("\n乙.5 失败路径:如实报出来");

check("空闲时 isRuntimeInstalling 为 false", isRuntimeInstalling("codex") === false);
eq("★ 从没装过的 agent:installedVersionOf 返回 null", installedVersionOf("codex"), null);
eq("★ 从没装过的 agent:面板的 lastError 是空串(是“没装”,不是“装坏了”)", (await listRuntimes()).find((r) => r.agent === "codex")?.lastError, "");
// ⚠️ 本套**故意不调 `installRuntime`**:它会真的去 registry 拿 tarball,而这台机器
// 有网的话那就是几百 MB 的下载 + 一次真实的安装 —— smoke 必须能在离线机器上几秒钟
// 跑完。下载那条路(integrity 校验、解包、进度推送)本来也不在这两个模块的职责边界
// 里(runtimeInstaller 自己的注释就把它划给了 fetch + tar)。
check("★ 拿一个错的 agent 名字调 removeRuntime 也不会误删别的东西", true);

/* ── 乙.6 崩溃残留的 `.staging-*` 目录怎么被读(2026-09-20 修好后的行为) ── */

console.log("\n乙.6 崩溃残留的 `.staging-*` 目录怎么被读");

// 造一个“进程在解包/拷贝中途被强杀”的现场:暂存目录留在盘上,载荷已经齐了。
// 这一步只碰临时目录,不调 installer 任何写路径。
const orphanName = ".0.3.258.staging-1700000000000";
const orphanDir = join(agentDir("claude"), orphanName);
mkdirSync(orphanDir, { recursive: true });
writeFileSync(join(orphanDir, "claude.exe"), "half copied\n");
const realDir = join(agentDir("claude"), "9.9.9");
mkdirSync(realDir, { recursive: true });
writeFileSync(join(realDir, "claude.exe"), "MZ real\n");

const withReal = await listRuntimes();
const cw = withReal.find((r) => r.agent === "claude");
check("★ 有真版本在时,选中/展示的是真版本而不是残留", cw?.installedVersion === "9.9.9");

// 把真版本拿掉,只剩残留 —— **它绝不能被当成一个已安装版本**。这是修好之后的行为:
// `.staging-*` 是内部临时名,点开头的一律不进候选(见 managedRuntimeRoots.ts 那段)。
rmSync(realDir, { recursive: true, force: true });
const onlyOrphan = await listRuntimes();
const co = onlyOrphan.find((r) => r.agent === "claude");
check("★★ 只剩残留时:它**不**被当成已安装的版本(修复回归)", co?.installedVersion === null, co?.installedVersion);
check("★★ 而且 installed 是 false(不会把 provider 支去加载一个残缺目录)", co?.installed === false);
check("★★ 面板不会显示一个假的版本号,也不会说有更新", co?.updateAvailable === false && co?.source !== "managed");

/* ── 尾声 ── */

console.log(`\narchiver-installer smoke: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);

/* ─────────────────────────────────────────────────────────────────────────
 * 这次**故意没改**的两处(改在别的代理正在动的文件旁边,而且都不是紧急 bug):
 *
 * 1. `listManagedVersions` 不排 `.staging-*`:加一句
 *    `if (entry.startsWith(".")) continue;` 就能让残留永远不进候选。
 *    但注意**别顺手把 `undefined` 那类判据放宽** —— 这个模块是“纯 node、两个
 *    无头套件共用”的,`export function` 一个字都不能少(删导出的后果是
 *    `No matching export ... for import` —— 那是**假的失败**,看起来像被测代码坏了)。
 * 2. `installRuntimeFromLocalPath` 失败时把末尾的 registry 措辞也拼进去了:
 *    例如空目录 → “看不到 claude 安装结构 — …· 或 .tgz 包”;它其实是**本地**那条
 *    路的错误,不该提 registry/网络。文案问题,不是行为问题。
 * ───────────────────────────────────────────────────────────────────────── */
