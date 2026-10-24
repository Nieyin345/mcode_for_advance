/**
 * O3 —— 启动**已打包的** `Mcode.exe`（`release/win-unpacked`），并给出一个可控句柄。
 *
 * ## 为什么不是 `pnpm dev` / electron-u1 的 electron
 *
 * 本卡验的是「装完能不能用」。`win-unpacked` 里的主进程、asar、`resources/genoffice`
 * 都是**产物**，和源码树走的是**不同的资源分支**（`genofficeViewFactories.ts` 的
 * `nativeViewsRoot()` 两个后缀）。所以必须启动那个 exe 本身。
 *
 * ## 隔离纪律（与仓库其它 Electron 套件同一条）
 *
 *  - 每次运行一个全新的 `mkdtemp` 目录：`userData`（经 `--user-data-dir`，Chromium
 *    与 Electron 的 `app.getPath("userData")` 都落在这里）、`dataRoot`、`project`；
 *  - **数据根指针**写在 `<userData>/data-root.json`（`lib/dataRoot.ts` 的唯一事实源），
 *    指向本次的临时目录 —— 绝不碰用户真实的 `~/Mcode` 与 `%APPDATA%`；
 *  - 单实例锁在 `userData` 里，因此与本机正在运行的真实 Mcode **互不影响**（实测：
 *    用户那份 PID 25092 全程在跑，本套件照常启动）；
 *  - 退出用 `taskkill /T /F` 只杀自己这棵进程树。
 *
 * ## 调试端口
 *
 * `--remote-debugging-port=<自由端口>`。端口先探测一次（`/json/version` 有响应就换），
 * 与 `scripts/ui-probe/probe.mjs` 同一做法 —— 并发跑两个套件时不会接错到别人的浏览器
 * （接错时症状是"输入叠加/事件翻倍"，与真正原因毫无关系）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCdp } from "./cdp.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 产物根。本卡**只读**它（除变异期的两处临时改名/改字段，见 main.mjs）。 */
export function unpackedDir(repo) {
  return join(repo, "apps/desktop/release/win-unpacked");
}

export async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const candidate = 9500 + Math.floor(Math.random() * 500);
    const busy = await fetch(`http://127.0.0.1:${candidate}/json/version`).then(() => true, () => false);
    if (!busy) return candidate;
  }
  throw new Error("找不到空闲的调试端口（50 次探测全被占）");
}

/** CDP 的 `/json/list`；进程还没起来时返回空数组（调用方轮询）。 */
async function listTargets(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return [];
  }
}

/**
 * 启动产物应用并连上**主窗口**的渲染页。
 *
 * @returns {{
 *   child, runDir, userData, dataRoot, projectDir, port, log,
 *   main: Awaited<ReturnType<typeof connectCdp>>, mainTarget,
 *   stop(): Promise<void>,
 * }}
 */
export async function launchPackagedApp({ repo, evidenceDir, label = "main", mainTimeoutMs = 90_000 }) {
  const unpacked = unpackedDir(repo);
  const exe = join(unpacked, "Mcode.exe");
  if (!existsSync(exe)) throw new Error(`打包产物不存在：${exe}（本套件不负责打包）`);

  const runDir = mkdtempSync(join(tmpdir(), `mcode-o3-${label}-`));
  const userData = join(runDir, "userdata");
  const dataRoot = join(runDir, "dataroot");
  const projectDir = join(runDir, "project");
  for (const d of [userData, dataRoot, projectDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userData, "data-root.json"), JSON.stringify({ root: dataRoot }), "utf8");

  const port = await pickFreePort();
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (b) => { log += b; });
  child.stderr.on("data", (b) => { log += b; });

  let stopRequested = false;
  const stop = async () => {
    if (stopRequested) return;
    stopRequested = true;
    try {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    } catch { /* 已退出 */ }
    await sleep(500);
    try {
      writeFileSync(join(evidenceDir, `${label}-app.log`), log, "utf8");
    } catch { /* 证据目录不可写不该拖垮清理 */ }
  };

  // 主窗口 target：asar 里的 renderer/index.html（设置/配对页是别的 html，排除）。
  const deadline = Date.now() + mainTimeoutMs;
  let mainTarget = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`应用在找到主窗口前退出（exit=${child.exitCode}）。日志尾部：\n${log.slice(-2500)}`);
    }
    const targets = await listTargets(port);
    mainTarget = targets.find((t) => t.type === "page" && /app\.asar\/out\/renderer\/index\.html/.test(t.url ?? ""));
    if (mainTarget) break;
    await sleep(300);
  }
  if (!mainTarget) {
    await stop();
    throw new Error(`90s 内没有出现主窗口 target（端口 ${port}）。日志尾部：\n${log.slice(-2500)}`);
  }

  const main = await connectCdp(mainTarget.webSocketDebuggerUrl, { label: "main-window" });
  const mounted = await main.waitFor("!!document.querySelector('[data-testid=workspace-main]')", { timeoutMs: 60_000 });
  if (!mounted) {
    await main.waitFor("({root: document.getElementById('root')?.childElementCount ?? -1, body: (document.body?.innerText ?? '').slice(0,200)})", { timeoutMs: 1000 });
    await stop();
    throw new Error("主窗口 target 已连上，但 60s 内 [data-testid=workspace-main] 没有挂载（渲染端没起来）");
  }

  return { child, runDir, userData, dataRoot, projectDir, port, log: () => log, main, mainTarget, stop };
}

/** 等一个**还没被用过**的 target（同一 URL 会有多个 docs 视图，不能靠 URL 去重）。 */
export async function waitForTarget(port, predicate, { timeoutMs = 45_000, usedIds = new Set() } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const targets = await listTargets(port);
    const hit = targets.find((t) => t.type === "page" && !usedIds.has(t.id) && predicate(t));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

/** 读产物的 availability.json（卡 2.1 第 3 条）。文件小、纯 JSON。 */
export function readAvailability(repo) {
  const file = join(unpackedDir(repo), "resources/genoffice/availability.json");
  return { file, info: JSON.parse(readFileSync(file, "utf8")) };
}
