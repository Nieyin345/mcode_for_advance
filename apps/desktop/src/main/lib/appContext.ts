/**
 * 托管上下文(设置面板):全局指令 + 记忆编辑器的存储与物化。
 *
 * ## 全局指令:一条事实源,三个消费点
 *
 * 唯一事实源是 `<dataRoot>/context/instructions.md`(跟着数据根走,用户看得见、
 * 备份得着)。保存时物化到各引擎的消费点:
 *  - claude: `~/.mcode/CLAUDE.md` —— settingSources=["user"] 之后 CLI 唯一会读
 *    的用户级记忆文件,物化过去即生效。
 *  - codex: **不**单独物化 —— `ensureCodexHomeIdentity` 在会话启动组装
 *    CODEX_HOME/AGENTS.md 时把同一份内容并进去(见 CodexAgentSdkProvider)。
 *    这里若再物化一份裸 AGENTS.md 会被组装链互相覆盖。
 *  - pi: 会话启动时读同一份源文件追加进系统提示词(mcodeExtension)。
 *
 * 物化文件一律带 {@link MANAGED_MARKER} 头:**有标记的文件 Mcode 才有权改写/
 * 删除;没有标记的手写文件绝不动**(防误删)。反向地,事实源缺失而消费点已有
 * 内容时,设置面板第一次读取会把既有内容**收养**进编辑器 —— 用户点保存后它
 * 才成为事实源,而不是被面板的空内容悄悄覆盖掉。⚠️ 收养只发生在「源缺失」时;
 * 源存在(哪怕是空文件)就以源为准 —— 「明确配置为空」和「从未配置」是两回事。
 *
 * ## 纯核心 + 注入路径
 *
 * 本文件**不 import electron**(dataRoot/logger 都不进),路径全部由调用方注入,
 * 无头 smoke(context-files-smoke)直接 bundle 本文件在 node 下跑。electron 侧的
 * 默认路径装配在 main/ipc/context.ts。原子写沿用 codexModelsStore / mcpConfig
 * 的 tmp+rename 姿势(rename 被占用目标挡住时退回直接写)。
 *
 * ## 记忆
 *
 * CLI 原生 auto-memory:`~/.mcode/projects/<slug>/memory/MEMORY.md`。注入是 CLI
 * 自己的行为,这里只做「列出 + 读 + 写」的 UI 托管。slug 是 CLI 的项目目录名
 * (路径中每个非 `[A-Za-z0-9-]` 字符折成一个 `-`),**不可逆** —— 显示名靠把已知
 * 项目路径按同一规则算 slug 来匹配,匹配不上就原样显示 slug(见
 * {@link listMemoryDirs} 的 labelHints)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextMemoryDir } from "@contracts/ipc";

/** 物化文件头部的托管标记。有它 = Mcode 写的,可以放心改写/删除。 */
export const MANAGED_MARKER = "<!-- mcode:managed -->";

/** CLI 的项目目录名:路径中每个非 `[A-Za-z0-9-]` 字符折成一个 `-`。
 *  例:`D:\destop\work_space` → `D--destop-work-space`。 */
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9-]/g, "-");
}

/** 事实源文件路径:`<dataRoot>/context/instructions.md`。 */
export function instructionsSourcePath(dataRootPath: string): string {
  return join(dataRootPath, "context", "instructions.md");
}

/* ─────────────────────────── 全局指令 ─────────────────────────── */

/** 去掉托管标记行,得到纯正文(收养已托管文件时用,编辑器里不该看到标记)。 */
export function stripManagedMarker(content: string): string {
  return content
    .split("\n")
    .filter((line) => line.trim() !== MANAGED_MARKER)
    .join("\n")
    .replace(/^\s+/, "");
}

function hasManagedMarker(content: string): boolean {
  return content.includes(MANAGED_MARKER);
}

/** 原子写:tmp + rename,rename 失败(Windows 目标被占用)退回直接写。
 *  供本模块的托管文件使用;skillEngines 的矩阵文件也复用同一姿势。 */
export function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.mcode-tmp`;
  try {
    writeFileSync(tmp, text, "utf-8");
    try {
      renameSync(tmp, file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort
      }
      writeFileSync(file, text, "utf-8");
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}

/** 设置面板读到的全局指令状态。 */
export interface InstructionsState {
  content: string;
  /** true = 源缺失,内容是从既有消费点收养来的(还没落盘成事实源)。 */
  adopted: boolean;
  /** 收养来源路径(adopted=true 时有意义,UI 可以提示「接管自 …」)。 */
  adoptedFrom?: string;
}

/**
 * 读全局指令。源存在(含空文件)→ 源内容;源缺失 → 依序收养第一个非空目标
 * (剥掉托管标记)。都没有 → 空串。
 */
export function readInstructionsState(
  sourcePath: string,
  adoptTargets: string[],
): InstructionsState {
  if (existsSync(sourcePath)) {
    return { content: readFileSync(sourcePath, "utf-8"), adopted: false };
  }
  for (const target of adoptTargets) {
    if (!existsSync(target)) continue;
    const raw = readFileSync(target, "utf-8");
    const body = stripManagedMarker(raw);
    if (body.trim() === "") continue;
    return { content: body, adopted: true, adoptedFrom: target };
  }
  return { content: "", adopted: false };
}

/** 只读事实源(codex/pi 组装链用 —— 它们不该触发收养语义)。 */
export function readInstructionsSource(sourcePath: string): string {
  try {
    return readFileSync(sourcePath, "utf-8");
  } catch {
    return "";
  }
}

/** 单个消费点的物化结果。 */
export interface MaterializeResult {
  target: string;
  action:
    | "written" // 内容已写入(或整文件重写)
    | "deleted" // 空内容 + 已托管 → 文件删除
    | "unchanged" // 内容已一致 / 无事可做
    | "skipped-unmanaged"; // 手写文件(无标记)没碰 —— 只发生在非强制的自动路径
}

/** 物化一份托管内容到消费点。
 *  - 非空内容:目标不存在 → 写入;目标已托管(有标记)→ 覆盖;目标无标记 →
 *    强制路径下覆盖(用户在面板里显式按了保存,面板即管理者),自动路径下跳过。
 *  - 空内容:已托管 → 删除;无标记手写文件 → 永远不动(防误删)。 */
export function materializeManagedFile(
  target: string,
  content: string,
  opts: { force: boolean },
): MaterializeResult {
  const current = existsSync(target) ? readFileSync(target, "utf-8") : null;
  const managed = current !== null && hasManagedMarker(current);
  const empty = content.trim() === "";
  if (empty) {
    if (current !== null && managed) {
      rmSync(target, { force: true });
      return { target, action: "deleted" };
    }
    return { target, action: "unchanged" };
  }
  if (current !== null && !managed && !opts.force) {
    return { target, action: "skipped-unmanaged" };
  }
  const desired = `${MANAGED_MARKER}\n\n${content.replace(/\r\n/g, "\n").trimEnd()}\n`;
  if (current === desired) return { target, action: "unchanged" };
  atomicWrite(target, desired);
  return { target, action: "written" };
}

/** 保存全局指令的返回。`warnings` 是逐目标物化的注意事项(空内容保存却留下
 *  手写文件时,面板要告诉用户为什么那个文件还在)。 */
export interface WriteInstructionsResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  materialized: MaterializeResult[];
}

/**
 * 写事实源 + 物化消费点。空内容 = 「明确配置为空」:源写成空文件(不是删除,
 * 避免下次读取又走收养分支),消费点按物化规则清掉已托管的。
 *
 * `targets` 里的顺序即物化顺序;`force` 见 {@link materializeManagedFile} ——
 * 面板显式保存传 true,自动补物化传 false。
 */
export function writeInstructionsAt(
  sourcePath: string,
  targets: string[],
  content: string,
  opts: { force: boolean },
): WriteInstructionsResult {
  try {
    atomicWrite(sourcePath, content.replace(/\r\n/g, "\n").trimEnd() + (content.trim() === "" ? "" : "\n"));
    const materialized = targets.map((t) => materializeManagedFile(t, content, opts));
    const warnings = materialized
      .filter((m) => m.action === "skipped-unmanaged")
      .map((m) => `${m.target} 不是 Mcode 托管文件,已保持原样`);
    return { ok: true, warnings: warnings.length > 0 ? warnings : undefined, materialized };
  } catch (err) {
    return { ok: false, error: (err as Error).message, materialized: [] };
  }
}

/** 自动补物化:事实源存在且非空、消费点缺失或已托管但内容过期时重写。
 *  供 CONTEXT_GET 触发(惰性,不动 index.ts)—— 面板打开即修复漂移;
 *  引擎侧(如 codex 组装链)有自己的会话启动时机,不走这里。 */
export function ensureMaterialized(
  sourcePath: string,
  targets: string[],
): MaterializeResult[] {
  const source = readInstructionsSource(sourcePath);
  if (source.trim() === "") return [];
  return targets.map((t) => materializeManagedFile(t, source, { force: false }));
}

/* ─────────────────────────── 记忆 ─────────────────────────── */

/** `<projectsRoot>/<slug>/memory/MEMORY.md` 的三个路径段。 */
export function memoryFilePath(projectsRoot: string, slug: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error(`invalid project slug: ${slug}`);
  return join(projectsRoot, slug, "memory", "MEMORY.md");
}

/**
 * 列出有记忆的项目目录。只扫 `<projectsRoot>/*` 下存在 `memory/` 子目录的;
 * 没有记忆文件的条目 updatedAt 为 null(编辑器显示空,保存即创建)。
 *
 * `labelHints` 是所有已知的项目绝对路径(ProjectRepo + ~/.mcode/.claude.json
 * 的 projects 键):按同一 slug 规则匹配出可读名 —— slug 不可逆,这是唯一的
 * 显示名来源。
 */
export function listMemoryDirs(
  projectsRoot: string,
  labelHints: string[],
): ContextMemoryDir[] {
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const labelBySlug = new Map<string, string>();
  for (const hint of labelHints) {
    const slug = projectSlug(hint);
    // 同一 slug 多个路径(理论上不该发生)时保留首个
    if (!labelBySlug.has(slug)) labelBySlug.set(slug, hint);
  }
  const out: ContextMemoryDir[] = [];
  for (const slug of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) continue;
    const file = join(projectsRoot, slug, "memory", "MEMORY.md");
    let updatedAt: number | null = null;
    try {
      updatedAt = statSync(file).mtimeMs;
    } catch {
      // memory/ 目录在但 MEMORY.md 还没落盘 —— CLI 建目录的间隙,正常
    }
    out.push({ slug, label: labelBySlug.get(slug) ?? slug, updatedAt });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 读一份记忆。缺失/不可读 → 空串(编辑器新建场景)。 */
export function readMemoryFile(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** 写一份记忆(直接覆盖 —— 记忆是 CLI 的原生文件,没有托管语义)。 */
export function writeMemoryFile(file: string, content: string): { ok: boolean; error?: string } {
  try {
    atomicWrite(file, content.replace(/\r\n/g, "\n"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
