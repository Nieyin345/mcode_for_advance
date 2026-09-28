/**
 * 文档工具链的**检测** —— 「设置 → 内核」那块新面板的左半边。
 *
 * ## 它检测的是什么
 *
 * 四个内置文档技能(docx / pptx / xlsx / pdf)要调的外部工具。技能本身随应用
 * 发布,这些工具是机器级的 —— 换一台干净电脑,技能装好了也跑不动。这一节把
 * "能不能跑"变成面板上看得见的状态。
 *
 * 清单不是拍脑袋列的是数出来的:把技能目录下所有 SKILL.md 与脚本里的
 * subprocess / 命令行过了一遍,实际会出现的就是这五个。
 *
 * ## 只回数据,不回文案
 *
 * `components` 里是**机器名**(`pandoc` / `unzip` / `openpyxl`),`path` / `version`
 * 是事实。措辞("缺 openpyxl、markitdown")由渲染端按 zh/en 自己拼 —— 和
 * `runtimes` 面板同一条纪律(那边主进程只给 source/version,文案全在 i18n)。
 *
 * ## 为什么探测结果要缓存几秒
 *
 * 一次检测要 spawn 十来个子进程(每个工具一次 where/which,每个 python 候选一次
 * 导入探测)。面板打开、装完刷新、React 重渲染都会调它 —— 没有缓存的话,光是
 * 在面板上点几下就会反复起进程。5 秒足够短(用户点"重新检测"也等得起),又足够
 * 挡住密集重复调用。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolchainToolId, ToolchainToolState, ToolchainSource } from "@contracts/ipc";
import { TOOLCHAIN_TOOL_IDS } from "@contracts/ipc";
import { managedToolExecutable } from "./managedToolRoots.js";
import { knownInstallPaths } from "./systemToolPaths.js";
import { detectLocal } from "@main/onlyoffice/localInstall.js";
import { getOnlyOfficeConfig } from "@main/onlyoffice/OnlyOfficeBridge.js";

/** 技能脚本会 import 的第三方包(python-deps 这一项的全部内容)。
 *
 * 这份名单是**扫出来的**,不是猜的:把四个技能目录下所有 `.py` 的顶层 import 用
 * AST 过一遍,去掉标准库和技能内部的本地模块(`office.*` / `validators` /
 * `helpers` 那些),剩下的就是它。加包之前先扫一遍,别凭印象写。 */
const PY_PACKAGES = [
  "openpyxl",
  "pptx",
  "markitdown",
  "pypdf",
  "defusedxml",
  "PIL",
  "pdf2image",
  "pdfplumber",
  "lxml",
] as const;

/** 找 python 解释器的候选顺序 —— 与大多数人的 PATH 习惯一致。 */
const PY_CANDIDATES = ["python", "python3", "py"] as const;

/** 探测缓存时长。见文件头「为什么要缓存」。 */
const CACHE_TTL_MS = 5_000;

interface ProbeResult {
  ok: boolean;
  stdout: string;
}

/** 跑一个命令并收 stdout。**任何**失败(不存在 / 超时 / 非零退出)都只是
 *  `ok:false` —— 探测不该抛异常。 */
function run(file: string, args: string[], timeoutMs = 10_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout ?? "" });
    });
  });
}

/** 在 PATH 上找一个可执行文件,返回第一个真实存在的绝对路径。 */
async function findExecutable(name: string): Promise<string | null> {
  // Windows 用 where.exe,别的地方用 which。都不走 shell —— 参数里可能有用户
  // 路径,经 shell 解析就多了注入面。
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  const res = await run(cmd, [name]);
  if (!res.ok) return null;
  for (const line of res.stdout.split(/\r?\n/)) {
    const p = line.trim();
    if (p && existsSync(p)) return p;
  }
  return null;
}

// `knownInstallPaths` / `systemToolBinDirs` 住在 ./systemToolPaths.ts(见那边文件头)。
export { systemToolBinDirs } from "./systemToolPaths.js";

/** 只在系统里找(PATH → 标准安装位置),**不碰自管副本**。
 *
 * 单独抽出来是因为 LaTeX:TinyTeX 的四个组件(xelatex/pdflatex/biber/tlmgr)都在
 * 同一个自管 bin 目录里,而 `findTool` 的"自管优先"是按**工具**判断的 —— 它对
 * 任何一个组件名都会返回 xelatex 的路径,于是 biber 会被误报成"有"。 */
async function findSystemTool(
  tool: ToolchainToolId,
  name: string,
): Promise<{ path: string; source: ToolchainSource } | null> {
  const onPath = await findExecutable(name);
  if (onPath) return { path: onPath, source: "system" };
  for (const candidate of knownInstallPaths(tool)) {
    if (existsSync(candidate)) return { path: candidate, source: "system" };
  }
  return null;
}

/** 先看自管副本,再看系统。 */
async function findTool(
  tool: ToolchainToolId,
  name: string,
): Promise<{ path: string; source: ToolchainSource } | null> {
  const managed = managedToolExecutable(tool);
  if (managed) return { path: managed, source: "managed" };
  return findSystemTool(tool, name);
}

/** 某个目录里有没有这个名字的可执行文件。
 *
 * **Windows 上不是所有工具都叫 `.exe`** —— `tlmgr` 就只是个 `tlmgr.bat`(真逻辑
 * 在 `runscript.exe` + `runscript.tlu` 里)。所以候选后缀要按 PATHEXT 常见的那几个
 * 都试一遍:只认 `.exe` 的话,自管的 TinyTeX 会被报成"缺 tlmgr",而系统那份又找
 * 得到,同一台机器上两个来源给出互相矛盾的结论。
 *
 * 注意这里只判**存在**,不执行 —— `.bat` 没法用 execFile 直接起(要 shell),
 * 而版本探测只对引擎做,那几个都是真的 .exe。 */
function executableInDir(dir: string, name: string): string | null {
  const candidates =
    process.platform === "win32" ? [`${name}.exe`, `${name}.bat`, `${name}.cmd`, name] : [name];
  for (const file of candidates) {
    const p = join(dir, file);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 从 `pandoc --version` 的首行里抠出版本号。 */
function parsePandocVersion(stdout: string): string | null {
  const m = stdout.match(/^pandoc\s+([0-9][0-9A-Za-z.\-+]*)/m);
  return m ? m[1] : null;
}

/**
 * 一次 python 导入探测:对每个包报 `+包名` / `-包名`。
 *
 * 走 argv 而不是把包名拼进代码字符串 —— 拼字符串在 Windows 上会被引号规则咬,
 * 而且没必要。
 */
const PY_IMPORT_PROBE =
  "import importlib.util as u,sys;print(' '.join(('+' if u.find_spec(m) else '-')+m for m in sys.argv[1:]))";

async function probePython(exe: string): Promise<Set<string> | null> {
  const res = await run(exe, ["-c", PY_IMPORT_PROBE, ...PY_PACKAGES], 20_000);
  if (!res.ok) return null;
  const found = new Set<string>();
  for (const token of res.stdout.trim().split(/\s+/)) {
    if (token.startsWith("+")) found.add(token.slice(1));
  }
  return found;
}

/** 所有能找到的 python 解释器里,包最全的那一个 + 它缺什么。 */
async function pickPython(): Promise<{
  exe: string;
  found: Set<string>;
} | null> {
  let best: { exe: string; found: Set<string> } | null = null;
  for (const name of PY_CANDIDATES) {
    const exe = await findExecutable(name);
    if (!exe) continue;
    const found = await probePython(exe);
    if (!found) continue;
    if (!best || found.size > best.found.size) best = { exe, found };
    // 已经全有了就不必再试别的解释器 —— 后面的只会一样或更差
    if (found.size === PY_PACKAGES.length) break;
  }
  return best;
}

/* ── 各工具的检测 ── */

async function detectPandoc(): Promise<ToolchainToolState> {
  const hit = await findTool("pandoc", "pandoc");
  let version: string | null = null;
  if (hit) {
    const res = await run(hit.path, ["--version"], 15_000);
    // `--version` 非零退出时还是可能打了东西 —— 尽力解析,拿不到就 null
    version = parsePandocVersion(res.stdout);
  }
  return {
    id: "pandoc",
    ok: !!hit,
    source: hit ? hit.source : "missing",
    version,
    path: hit?.path ?? null,
    installable: true,
    installing: false,
    lastError: "",
    components: [{ name: "pandoc", found: !!hit }],
  };
}

async function detectPythonDeps(): Promise<ToolchainToolState> {
  const best = await pickPython();
  if (!best) {
    return {
      id: "python-deps",
      ok: false,
      source: "missing",
      version: null,
      path: null,
      installable: false, // 没有解释器就没法 pip —— 那要用户自己先装 python
      installing: false,
      lastError: "",
      components: PY_PACKAGES.map((name) => ({ name, found: false })),
    };
  }
  const versionRes = await run(best.exe, ["-V"], 10_000);
  const version = versionRes.stdout.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? null;
  const components = PY_PACKAGES.map((name) => ({ name, found: best.found.has(name) }));
  const ok = components.every((c) => c.found);
  return {
    id: "python-deps",
    ok,
    // 包是装进**用户自己的**解释器里的,所以永远算 system;没装全就是 missing
    source: ok ? "system" : "missing",
    version,
    path: best.exe,
    installable: true,
    installing: false,
    lastError: "",
    components,
  };
}

/**
 * LaTeX 要看四样东西:两个引擎(CJK 论文走 xelatex,老模板可能只认 pdflatex)、
 * 参考文献工具 biber、以及 TeX Live 的包管理器 tlmgr(缺宏包时靠它补装)。
 *
 * `ok` 的判据是**至少有一个引擎**,不是四个全有 —— 一个发行版没装 biber 照样能
 * 编译大部分文档,把它整个判成"缺失"会误导。缺的那几个照旧在 components 里列出,
 * 面板会显示「缺 biber」。这也是为什么组件的 found 列表要一直渲染,不能只在
 * `!ok` 时显示。
 */
async function detectLatex(): Promise<ToolchainToolState> {
  const NAMES = ["xelatex", "pdflatex", "biber", "tlmgr"] as const;
  const managedExe = managedToolExecutable("latex");
  const managedBin = managedExe ? dirname(managedExe) : null;

  const found = new Map<string, { path: string; source: ToolchainSource }>();
  for (const name of NAMES) {
    // 自管副本的四个组件都在同一个 bin 目录里,先在它里面找;没有再看系统。
    // 不能直接用 findTool —— 它是按**工具**判自管的,对任何组件名都会返回
    // xelatex 的路径,于是 biber 会被误报成"有"。
    const inManaged = managedBin ? executableInDir(managedBin, name) : null;
    const hit = inManaged
      ? { path: inManaged, source: "managed" as const }
      : await findSystemTool("latex", name);
    if (hit) found.set(name, hit);
  }

  const primary = found.get("xelatex") ?? found.get("pdflatex") ?? found.get("tlmgr") ?? null;
  const engineDir = (found.get("xelatex") ?? found.get("pdflatex"))?.path;
  return {
    id: "latex",
    ok: found.has("xelatex") || found.has("pdflatex"),
    source: primary ? primary.source : "missing",
    version: await readTexVersion(found.get("xelatex")?.path ?? found.get("pdflatex")?.path ?? null),
    path: primary?.path ?? null,
    installable: true,
    installing: false,
    lastError: "",
    components: [
      ...NAMES.map((name) => ({ name, found: found.has(name) })),
      // ctex 不是可执行文件而是宏包,所以单独查一次。**它必须在检测里**:两个
      // TinyTeX 发行版都不带它,而缺了它中文论文一行都编不过 —— 不显示出来的话,
      // 用户会以为"装好了",然后在第一次编译时撞上一堆看不懂的宏包错误。
      {
        name: "ctex",
        found: engineDir ? await hasTexPackage(dirname(engineDir), "ctex.sty") : false,
      },
    ],
  };
}

/** 某个 TeX 发行版里有没有这个宏包。
 *
 *  用 `kpsewhich` 而不是拼路径:它走的是整个 texmf 树,所以对自管的 TinyTeX 和
 *  用户自己那套 TeX Live 一样有效 —— 拼 `texmf-dist/tex/latex/...` 只对前者成立。 */
async function hasTexPackage(binDir: string, file: string): Promise<boolean> {
  const kpsewhich = join(binDir, process.platform === "win32" ? "kpsewhich.exe" : "kpsewhich");
  if (!existsSync(kpsewhich)) return false;
  const res = await run(kpsewhich, [file], 20_000);
  return res.ok && res.stdout.trim().length > 0;
}

/**
 * `xelatex --version` 首行形如
 * `XeTeX 3.141592653-2.6-0.999995 (TeX Live 2026)` —— 取**发行年份**,那是用户
 * 真正关心的那个数(引擎那串版本号没人记得住)。取不到就退回首行原文。
 */
async function readTexVersion(exe: string | null): Promise<string | null> {
  if (!exe) return null;
  const res = await run(exe, ["--version"], 20_000);
  const year = res.stdout.match(/TeX Live (\d{4})/);
  if (year) return year[1];
  return res.stdout.split(/\r?\n/)[0]?.trim().slice(0, 40) || null;
}

/** 由多个可执行文件组成、缺一不可的工具(zip 这一项要 zip + unzip 都全)。 */
async function detectMulti(
  id: ToolchainToolId,
  names: string[],
  installable = false,
): Promise<ToolchainToolState> {
  const parts: Array<{ name: string; found: boolean }> = [];
  let first: { path: string; source: ToolchainSource } | null = null;
  for (const name of names) {
    const hit = await findTool(id, name);
    parts.push({ name, found: !!hit });
    if (hit && !first) first = hit;
  }
  const ok = parts.every((p) => p.found);
  return {
    id,
    ok,
    source: first ? first.source : "missing",
    version: null,
    path: first?.path ?? null,
    installable,
    installing: false,
    lastError: "",
    components: parts,
  };
}

/**
 * ONLYOFFICE Document Server。
 *
 * ## 它和这张表里别的项**不同形**
 *
 * 上面几个都是 PATH 上的可执行文件,"找得到"就等于"能用"。这个是一套跑在本机的
 * 服务:目录在、服务在跑、healthcheck 应答 —— 三样缺一不可,而且端口未必是安装时
 * 请求的那个(安装器在端口被占时会自己挪)。
 *
 * 判据**不在这里重写一遍**,直接用 `onlyoffice/localInstall.ts` 的 `detectLocal()`:
 * 那边是这套服务的真相源(IDE 里的编辑器面板读的也是它)。分开写两份,迟早互相矛盾
 * —— 这正是 `knownInstallPaths` / `systemToolBinDirs` 共用一份路径表的同一条理由。
 */
async function detectOnlyOffice(): Promise<ToolchainToolState> {
  const d = await detectLocal();
  const responding = d.serviceState === "running" && d.port !== null;
  const configured = Boolean(getOnlyOfficeConfig().serverUrl.trim());
  return {
    id: "onlyoffice",
    // 光装上不算可用:服务得在跑,而且 `allowPrivateIPAddress` 得是开的 —— 否则 DS
    // 回连不到 Mcode 在 127.0.0.1 上的回调桥,编辑器会开出一片空白。这一项装完由
    // 提权脚本自动打开,列在 components 里是为了"它又被关上了"时能看见。
    ok: d.installed && responding && d.privateIpAllowed !== false && configured,
    source: d.installed ? "system" : "missing",
    version: d.version,
    path: d.installDir,
    // 只有 Windows 有官方静默安装包;别的平台连装都装不了,只显示状态。
    installable: d.supported,
    installing: false,
    lastError: "",
    components: [
      { name: "DocumentServer", found: d.installed },
      { name: "DsDocServiceSvc", found: d.serviceState === "running" },
      { name: "healthcheck", found: responding },
      { name: "allowPrivateIPAddress", found: d.installed && d.privateIpAllowed !== false },
      { name: "Mcode server URL", found: configured },
    ],
  };
}

/* ── 对外 ── */

let cache: { at: number; tools: ToolchainToolState[] } | null = null;

/** 检测本机工具链。安装/卸载之后请调 {@link invalidateToolchainCache}。 */
export async function checkToolchain(): Promise<ToolchainToolState[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.tools;
  const tools = await Promise.all([
    detectPandoc(),
    detectLatex(),
    detectPythonDeps(),
    detectMulti("zip-tools", ["unzip", "zip"]),
    detectMulti("soffice", ["soffice"]),
    detectMulti("pdftoppm", ["pdftoppm"]),
    detectOnlyOffice(),
  ]);
  cache = { at: Date.now(), tools };
  return tools;
}

/** 让下一次检测真的去探(装/卸、或用户点「重新检测」时调)。 */
export function invalidateToolchainCache(): void {
  cache = null;
}

/** pip 要装进哪个解释器 —— 和面板显示的那个必须是同一个。 */
export async function pickPythonForInstall(): Promise<string | null> {
  return (await pickPython())?.exe ?? null;
}

/** 真正需要 pip 装的包(名字是 pip 认的包名,不是 import 名)。
 *
 * `pdf2image` 是漏过一次的:pdf 技能里"把 PDF 转成图片"那个脚本用它,而它不在
 * 任何依赖清单里 —— 扫了一遍 import 才发现。它还需要 poppler 的 `pdftoppm` 在
 * PATH 上(TeX Live 自带),所以单装它不够,那一项在面板上是分开列的。 */
export const PIP_PACKAGES = [
  "pypdf",
  "defusedxml",
  "pillow",
  "openpyxl",
  "python-pptx",
  "pdf2image",
  "pdfplumber",
  "lxml",
  "markitdown[docx,pptx,xlsx,pdf]",
] as const;
