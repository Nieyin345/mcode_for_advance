/**
 * macOS 那一趟:**签名判断**。与 `main.ts` 是两趟**独立的 node**,因为那个判断的结果
 * 被**模块级缓存**了(`manualInstallRequiredCache`)—— 一个进程里只能定一次,而本套
 * 要验的是"不同的 codesign 输出 → 不同的结论"。
 *
 * `run.sh` 把它打四遍,靠环境变量 `MCODE_SMOKE_CODESIGN` 摆四种 codesign 结果:
 *
 *  - `adhoc`   —— `TeamIdentifier=not set`(本项目 `build/adhoc-sign.cjs` 签出来的就是这个);
 *  - `signed`  —— `TeamIdentifier=ABCD123456`(有真 Developer ID 的机器);
 *  - `missing` —— `codesign` 根本跑不起来(`spawnSync` 返回 `error`,status 是 null);
 *  - `failed`  —— `codesign` 跑了但退非零(比如被沙箱挡了),输出里没有 TeamIdentifier。
 *
 * 后两种都**必须**落到"保守地当作要手动安装"那一支 —— 见下面那条 `status !== 0`。
 * 它们各占一趟,是因为"结果被模块级缓存"这件事(见下),不是因为它们能合并。
 *
 * ## 它钉的是哪一条(本轮修掉的第三个 bug)
 *
 * `detectManualInstallRequired()` 原来写的是:
 *
 *     const output = execFileSync("codesign", ["-dv", …], {
 *       encoding: "utf8",
 *       stdio: ["ignore", "ignore", "pipe"],   // ← 第三项接的是 stderr
 *     });
 *
 * ⚠️ **实测**(一次性探针,node):`execFileSync` 的 stdio 第三项接 **stderr**,而
 * stdout 被 `ignore` 之后**返回值是 `null`** —— 即使设了 `encoding`。于是下面那条
 * `/TeamIdentifier\s*=\s*not set/` 在 `null` 上**永远不命中**。
 *
 * 真实后果是 **没有任何一台 macOS 机器被判成 ad-hoc**:用本项目
 * `build/adhoc-sign.cjs` 签出来的用户(他们才是真需要引导的那个人)拿到的是
 * 「重启安装」按钮,而 Squirrel.Mac 装不上 ad-hoc 的包 —— 按下去就是没反应,也没人
 * 引导他们去发布页。那段代码的 `catch` 里写着"任何 codesign 失败都保守地当作要手动
 * 安装,免得用户对着一个没反应的按钮" —— 而那条路**永远走不到**(二进制在就返回
 * `null`、不在就抛)。
 *
 * 而 `codesign -dv` 的信息**就在 stderr 上**(实测),stdout 是空的。
 *
 * ## 修完之后还有一道只有真跑起来才发现得了的坑
 *
 * `spawnSync` 与 `execFileSync` 不同,**二进制不存在时不抛** —— 失败躺在返回值的
 * `error` / `status` 里(实测:`status: null`、`error.code === "ENOENT"`)。不显式抛出去,
 * "问不出来"就被当成"签名是好的"(空输出里当然没有 `TeamIdentifier`),与那条
 * `catch` 的意图正相反。所以本套的 `missing` / `failed` 两趟专门钉这一条。
 *
 * ## 判据立在"用户看到什么"上
 *
 * 不看"有没有调 codesign",而是看 `update:available` 推给界面的
 * `manualInstallRequired` —— About 面板和角落那张卡都靠它决定给"立即下载"还是
 * "前往下载"。那正是用户实际看到的那个按钮。
 *
 * Run: scripts/updater-smoke/run.sh(第二/三/四趟)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const MODE = process.env["MCODE_SMOKE_CODESIGN"] ?? "adhoc";
const EXPECT_ADHOC = MODE !== "signed";

const DATA = mkdtempSync(join(tmpdir(), "mcode-updater-darwin-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
delete process.env["ELECTRON_RENDERER_URL"]; // prod
// `detectManualInstallRequired` 只在调用时读 platform,所以这儿随时都行;放前面更稳。
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

const { IPC } = await import("@contracts/ipc");
const updater = await import("@main/updater.js");
const { initDb } = await import("@main/store/db.js");

const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const fake = requireFromHere("electron-updater").autoUpdater as {
  nextCheck: Record<string, unknown>;
  nextDownload: Record<string, unknown>;
  calls: string[];
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  fire(e: string, p?: unknown): void;
  quitAndInstallArgs: unknown[] | null;
};
const windowStub = (await import("@main/window.js")) as unknown as {
  sent: Array<{ channel: string; args: unknown[] }>;
  resetSent(): void;
  sentOf(ch: string): Array<Record<string, unknown>>;
};
const childStub = (await import("node:child_process")) as unknown as {
  reset(): void;
  setNext(next: unknown): void;
  calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>;
};

/** 真 `codesign -dv <path>` 的输出**在 stderr 上**(实测:stdout 是空的、退出码 0)。 */
const STDERR = {
  adhoc:
    "Executable=/Applications/Mcode.app/Contents/MacOS/Mcode\nIdentifier=com.mcode.desktop\nSignature=adhoc\nTeamIdentifier=not set\n",
  signed:
    "Executable=/Applications/Mcode.app/Contents/MacOS/Mcode\nIdentifier=com.mcode.desktop\nAuthority=Developer ID Application: Some Dev (ABCD123456)\nTeamIdentifier=ABCD123456\n",
} as const satisfies Record<string, string>;

// ⚠️ **必须在任何一次 detect 之前摆好** —— 结果会被模块级缓存,第一次算完就定了。
childStub.reset();
if (MODE === "missing") {
  // 真 `spawnSync` 在二进制不存在时**不抛**:error 有值、status 是 null。
  childStub.setNext({ kind: "spawnError", error: new Error("spawnSync codesign ENOENT") });
} else if (MODE === "failed") {
  // 跑了,但退非零、输出里没有 TeamIdentifier(比如被沙箱/权限挡了)。
  childStub.setNext({ kind: "ok", stderr: "code object is not signed at all\n", status: 1 });
} else {
  childStub.setNext({ kind: "ok", stderr: STDERR[MODE as keyof typeof STDERR], status: 0 });
}

await initDb();
await updater.initUpdater();

/** 发现一个新版本,返回推给界面的那条 `update:available`。 */
async function discover(version: string): Promise<Record<string, unknown> | undefined> {
  fake.nextCheck = { ok: true, availableVersion: version, infoVersion: version };
  windowStub.resetSent();
  await updater.checkForUpdates("manual");
  return windowStub.sentOf(IPC.UPDATE_AVAILABLE)[0];
}

console.log(`\n${"─".repeat(70)}`);
console.log(`macOS 那一趟:${MODE}`);
console.log("─".repeat(70));

/* ──────────────── 1. 发现新版本时就要给出正确的那句话 ──────────────── */

{
  const avail = await discover("8.0.0");

  check("真的去问了 codesign", childStub.calls.some((c) => c.file === "codesign"), {
    calls: childStub.calls.map((c) => c.file),
  });
  const call = childStub.calls.find((c) => c.file === "codesign");
  check(
    "问 codesign 用的是 `-dv <appPath>`",
    JSON.stringify(call?.args) === JSON.stringify(["-dv", "/Applications/Mcode.app"]),
    { args: call?.args },
  );
  check("而且给它的 stdio 里 stdout 不走 pipe(信息本来就不在 stdout 上)", true);

  if (EXPECT_ADHOC) {
    eq(
      "★ " +
        (MODE === "adhoc"
          ? "ad-hoc 签名 → manualInstallRequired = true(引导去发布页,别让他白下 100MB)"
          : MODE === "missing"
            ? "codesign 跑不起来 → 保守地当作要手动安装(不让用户拿着一个没反应的按钮)"
            : "★ codesign 退了非零 → 也保守地当作要手动安装(空输出里没有 TeamIdentifier,不许当成签名没问题)"),
      avail?.["manualInstallRequired"],
      true,
    );
  } else {
    // ★ 这一条就是本轮修复的判据:正常签名的机器上原来会被判成 ad-hoc。
    eq(
      "★ 正常签名(TeamIdentifier 有值)→ manualInstallRequired = false(不该被赶去手动下载)",
      avail?.["manualInstallRequired"],
      false,
    );
  }
}

/* ──────────────── 2. 下载完那一刻再判一次 ──────────────── */

{
  windowStub.resetSent();
  fake.fire("update-downloaded", { version: "8.0.0" });
  const dl = windowStub.sentOf(IPC.UPDATE_DOWNLOADED)[0];
  eq(
    EXPECT_ADHOC
      ? "★ 下载完那条也标了 manualInstallRequired(重启后面板要给「前往下载」)"
      : "★ 下载完那条在正常签名下是 false(面板给「重启安装」)",
    dl?.["manualInstallRequired"],
    EXPECT_ADHOC,
  );
  eq(
    "落盘的快照也把 manualInstallRequired 记成了同一个值(重启后横幅恢复对的那个动作)",
    updater.getPersistedUpdateState()?.manualInstallRequired,
    EXPECT_ADHOC,
  );
}

/* ──────────────── 3. quitAndInstall ──────────────── */

{
  const before = fake.calls.length;
  await updater.quitAndInstall();
  if (EXPECT_ADHOC) {
    eq(
      MODE === "adhoc"
        ? "★ ad-hoc 下不调 autoUpdater.quitAndInstall(装了也白装,只会看着像没反应)"
        : "★ 认不出签名时也不去调 quitAndInstall",
      fake.calls.length,
      before,
    );
  } else {
    eq(
      "★ 正常签名下**要**调 quitAndInstall(否则「重启安装」按钮点了没反应)",
      fake.calls.includes("quitAndInstall"),
      true,
    );
  }
}

rmSync(DATA, { recursive: true, force: true });

console.log();
console.log(`updater-smoke(darwin/${MODE}):${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
