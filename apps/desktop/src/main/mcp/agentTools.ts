/**
 * **mcode-agent** —— 网页端模型的通用 agent 工具集(读写文件、目录、搜索、执行命令、
 * 读技能)。只进 `webToolHost` 那张表,**不**注册给桌面三引擎 —— claude/codex/pi
 * 自带 Read/Write/Bash 这类原生工具,同一套东西再造一份只会让审批与权限矩阵多一列。
 *
 * ## 为什么这些必须是 mcode 侧的工具
 *
 * 网页模型唯一能"动手"的途径就是 `tools/call` 打回来(见 `webToolHost.ts`)。挂载的
 * 资料库条目(通用文件管理:文件/论文/笔记/模版,分类用户自定义)在提示词里只是一行
 * `@路径`(渲染端刻意不内联正文,见 `composePromptWithTags`),
 * claude 引擎用原生 Read 就能读,网页模型却没有任何文件工具 —— 这就是"模型说看不到
 * 挂载的文献"的根因。这一套补齐之后,网页端与 API 源的能力才真正对齐。
 *
 * ## 工作目录:相对路径的解析基准
 *
 * handler 拿到的 ctx 只有 sessionId,会话的 cwd 由 {@link AgentToolsDeps.cwdFor}
 * 注入(真实实现是 `RuntimeManager.cwdFor`:live 运行时的 lastCwd,兜底会话所属
 * 项目的路径)。绝对路径永远原样接受 —— 和 claude 引擎一样的自由度,写操作反正
 * 有审批闸门兜着。
 *
 * ## 审批分级(与 toolGate.ts 的两份清单对齐)
 *
 *   - 只读({@link AGENT_READONLY_TOOLS}):读文件 / 列目录 / glob / grep / 读技能,
 *     任何权限模式都放行;
 *   - 改文件({@link AGENT_EDIT_TOOLS}):写 / 改,`acceptEdits` 档放行(与 claude 的
 *     Write/Edit 同档),default 模式弹卡;
 *   - bash:风险最高,**不在任何自动放行清单里**,除了 bypass/dontAsk/「始终允许」
 *     一律弹卡。
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  defaultSkillsRoot,
  engineEnabled,
  parseSkillFrontmatter,
  readEnginesMap,
} from "@main/lib/skillEngines.js";
import { fail, text, type McpToolContext, type McpToolSpec } from "./sdk.js";

/** MCP server 名 —— 只用于 toolGate 的只读索引;这份表不走 SDK server。 */
export const AGENT_MCP_SERVER = "mcode-agent";

/** 只读工具:任何权限模式都自动放行。 */
export const AGENT_READONLY_TOOLS = new Set([
  "agent_read_file",
  "agent_list_dir",
  "agent_glob",
  "agent_grep",
  "agent_skill_list",
  "agent_skill_read",
]);

/** 改文件工具:acceptEdits 档放行(与 claude 的 Write/Edit 同档)。 */
export const AGENT_EDIT_TOOLS = new Set(["agent_write_file", "agent_edit_file"]);

export interface AgentToolsDeps {
  /** 会话 id → 工作目录(相对路径的解析基准)。null = 会话没有可用的 cwd,
   *  相对路径会被拒绝并提示用绝对路径。 */
  cwdFor(sessionId: string): string | null;
}

/* ────────────────────────────── 共用小件 ────────────────────────────── */

/** 读出来的文本单行上限 —— 与 claude 引擎的 Read 同款取舍,超长行截断。 */
const MAX_LINE_CHARS = 2000;
/** read_file 单次最多读的字节数(先整读再按行切)。 */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** bash 输出(stdout/stderr 各自)的保留字符数。 */
const MAX_OUTPUT_CHARS = 30_000;
/** bash 默认与最大超时。 */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
/** 递归走目录时的深度与结果上限。 */
const MAX_WALK_DEPTH = 15;
const MAX_WALK_RESULTS = 800;
/** 这些目录在任何递归遍历里都不进去 —— 搜索工具的基本卫生。 */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "out"]);

/** 相对路径按会话 cwd 解析;没有 cwd 就拒绝(模型能自己改成绝对路径)。 */
function resolveAgainstCwd(cwd: string | null, p: string): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Error("路径为空");
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) return path.normalize(trimmed);
  if (!cwd) throw new Error(`这个会话没有工作目录,相对路径「${trimmed}」无法解析,请使用绝对路径`);
  return path.resolve(cwd, trimmed);
}

/** 统一的错误包装 —— handler 不抛,失败也走 ToolResult(模型读得懂、能自己改)。 */
async function attempt(run: () => Promise<string>): Promise<ReturnType<typeof text>> {
  try {
    return text(await run());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

function truncateOutput(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n…[${label} 超过 ${MAX_OUTPUT_CHARS} 字符,已截断]`;
}

/* ────────────────────────────── 目录遍历 ────────────────────────────── */

interface WalkHit {
  abs: string;
  rel: string;
  isDir: boolean;
}

/**
 * 从 `root` 往下递归收集文件(含 `root` 自身)。`include` 是可选的 glob 过滤
 * (只对**文件名**匹配,如 `*.md`),跳过 {@link SKIP_DIRS} 与超出深度上限的分支。
 * 返回量到 {@link MAX_WALK_RESULTS} 就停 —— 搜索工具必须有底,不然一次调用
 * 能把主进程泡在 IO 里。
 */
async function walkFiles(root: string, include: RegExp | null): Promise<WalkHit[]> {
  const hits: WalkHit[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || hits.length >= MAX_WALK_RESULTS) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 已被删 —— 跳过,不炸整次遍历
    }
    for (const entry of entries) {
      if (hits.length >= MAX_WALK_RESULTS) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (include && !include.test(entry.name)) continue;
      hits.push({ abs, rel: path.relative(root, abs), isDir: false });
    }
  };
  await walk(root, 0);
  return hits;
}

/**
 * 一个够用的 glob → RegExp:支持 `**`(跨段)、`*`/`?`(段内),`/` 统一成正斜杠。
 * 不追求完整 glob 语义 —— 模型用的是"找某个名字的文件"这类粗模式,这里覆盖的就是它。
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` 或段内 `**` 都按"跨任意层级"处理
        i += 2;
        if (normalized[i] === "/") i += 1;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`, "i");
}

/* ────────────────────────────── 工具表 ────────────────────────────── */

export function agentMcpTools(deps: AgentToolsDeps): McpToolSpec[] {
  /** 每个工具共用的前置:解析 cwd。失败统一转 fail 文本。 */
  const cwdOf = (ctx: McpToolContext): string | null => deps.cwdFor(ctx.sessionId);

  return [
    {
      name: "agent_read_file",
      description:
        "读取本地文本文件(带行号,供后续 agent_edit_file 精确定位)。" +
        "相对路径按会话工作目录解析。大文件用 offset(起始行,从 1 起)/ limit(行数)分片读。",
      inputSchema: {
        path: z.string().min(1).describe("文件路径(绝对,或相对会话工作目录)"),
        offset: z.number().int().min(1).optional().describe("起始行号(从 1 起),默认从头"),
        limit: z.number().int().min(1).max(5000).optional().describe("最多读取的行数,默认 2000"),
      },
      handler: (args: { path: string; offset?: number; limit?: number }, ctx) =>
        attempt(async () => {
          const abs = resolveAgainstCwd(cwdOf(ctx), args.path);
          const st = await fs.stat(abs).catch(() => null);
          if (!st) return `文件不存在:${abs}`;
          if (st.isDirectory()) return `这是一个目录,不是文件:${abs}(列目录用 agent_list_dir)`;
          if (st.size > MAX_READ_BYTES) {
            return `文件太大(${st.size} 字节,上限 ${MAX_READ_BYTES}),请用支持分片的工具或让用户提供子文件`;
          }
          const buf = await fs.readFile(abs);
          if (isBinary(buf)) return `看起来是二进制文件,读不了正文:${abs}`;
          const all = buf.toString("utf-8").split(/\r?\n/);
          const start = Math.max(0, (args.offset ?? 1) - 1);
          const limit = args.limit ?? 2000;
          const slice = all.slice(start, start + limit);
          const numbered = slice.map((line, i) => {
            const clipped =
              line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…(行超长已截断)` : line;
            return `${start + i + 1}\t${clipped}`;
          });
          const head = `[${abs} 共 ${all.length} 行]`;
          const tail =
            start + slice.length < all.length
              ? `\n…(还有 ${all.length - start - slice.length} 行,用 offset=${start + slice.length + 1} 继续)`
              : "";
          return `${head}\n${numbered.join("\n")}${tail}`;
        }),
    },

    {
      name: "agent_write_file",
      description:
        "把 UTF-8 文本写入本地文件(整体覆盖;append=true 则追加到末尾)。" +
        "父目录不存在会自动创建。需要用户在 mcode 里确认。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径"),
        content: z.string().describe("要写入的完整内容"),
        append: z.boolean().optional().describe("true = 追加到文件末尾而不是覆盖,默认覆盖"),
      },
      handler: (args: { path: string; content: string; append?: boolean }, ctx) =>
        attempt(async () => {
          const abs = resolveAgainstCwd(cwdOf(ctx), args.path);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, args.content, { flag: args.append ? "a" : "w" });
          return `已${args.append ? "追加" : "写入"} ${abs}(${args.content.length} 字符)`;
        }),
    },

    {
      name: "agent_edit_file",
      description:
        "对本地文本文件做精确替换:old_string 必须与文件内容逐字一致。" +
        "同一处出现多次时会拒绝(除非 replace_all=true);建议先用 agent_read_file 拿到原文再改。",
      inputSchema: {
        path: z.string().min(1).describe("目标文件路径"),
        old_string: z.string().min(1).describe("要被替换的原文(逐字一致)"),
        new_string: z.string().describe("替换后的内容"),
        replace_all: z.boolean().optional().describe("原文出现多次时全部替换,默认只允许恰好一处"),
      },
      handler: (
        args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
        ctx,
      ) =>
        attempt(async () => {
          const abs = resolveAgainstCwd(cwdOf(ctx), args.path);
          const st = await fs.stat(abs).catch(() => null);
          if (!st || !st.isFile()) return `文件不存在:${abs}`;
          const buf = await fs.readFile(abs);
          if (isBinary(buf)) return `看起来是二进制文件,改不了:${abs}`;
          const content = buf.toString("utf-8");
          const first = content.indexOf(args.old_string);
          if (first < 0) return "没找到 old_string —— 内容必须逐字一致,先用 agent_read_file 确认原文";
          const second = content.indexOf(args.old_string, first + 1);
          if (second >= 0 && !args.replace_all) {
            return "old_string 在文件里出现多次;请扩大上下文让匹配唯一,或传 replace_all=true";
          }
          const next = args.replace_all
            ? content.split(args.old_string).join(args.new_string)
            : content.slice(0, first) + args.new_string + content.slice(first + args.old_string.length);
          await fs.writeFile(abs, next, "utf-8");
          return `已修改 ${abs}`;
        }),
    },

    {
      name: "agent_list_dir",
      description: "列出一个目录的直接子项(目录在前,带大小;不递归)。",
      inputSchema: {
        path: z.string().optional().describe("目录路径,默认会话工作目录"),
      },
      handler: (args: { path?: string }, ctx) =>
        attempt(async () => {
          const abs = resolveAgainstCwd(cwdOf(ctx), args.path ?? ".");
          const entries = await fs.readdir(abs, { withFileTypes: true });
          const dirs: string[] = [];
          const files: string[] = [];
          for (const e of entries.slice(0, 1000)) {
            if (e.isDirectory() || e.isSymbolicLink()) {
              dirs.push(`- ${e.name}/`);
              continue;
            }
            const size = await fs
              .stat(path.join(abs, e.name))
              .then((s) => s.size)
              .catch(() => 0);
            files.push(`- ${e.name} (${size} B)`);
          }
          const note = entries.length > 1000 ? `\n…(共 ${entries.length} 项,只列了前 1000)` : "";
          return `[${abs}]\n${[...dirs, ...files].join("\n") || "(空目录)"}${note}`;
        }),
    },

    {
      name: "agent_glob",
      description:
        "按 glob 模式找文件(如 `**/*.pdf`、`notes/*.md`),返回相对会话工作目录的路径列表。只搜文件名,不搜内容。",
      inputSchema: {
        pattern: z.string().min(1).describe("glob 模式,支持 **、*、?"),
        path: z.string().optional().describe("搜索起点目录,默认会话工作目录"),
      },
      handler: (args: { pattern: string; path?: string }, ctx) =>
        attempt(async () => {
          const base = resolveAgainstCwd(cwdOf(ctx), args.path ?? ".");
          const re = globToRegExp(args.pattern);
          const hits = await walkFiles(base, null);
          const matched = hits.filter((h) => re.test(h.rel.replace(/\\/g, "/")));
          if (matched.length === 0) return `没有匹配「${args.pattern}」的文件(从 ${base} 搜起)`;
          const listed = matched
            .slice(0, 500)
            .map((h) => `- ${h.rel.replace(/\\/g, "/")}`)
            .join("\n");
          const more =
            matched.length > 500 ? `\n…(共 ${matched.length} 个,只列前 500,请收窄模式)` : "";
          return `匹配 ${matched.length} 个:\n${listed}${more}`;
        }),
    },

    {
      name: "agent_grep",
      description:
        "在文件内容里按正则搜索(类似 ripgrep),跳过 .git/node_modules 等目录与二进制文件。" +
        "返回「文件:行号: 该行内容」。pattern 是 JavaScript 正则。",
      inputSchema: {
        pattern: z.string().min(1).describe("正则表达式(JavaScript 语法)"),
        path: z.string().optional().describe("搜索的文件或目录,默认会话工作目录"),
        glob: z.string().optional().describe("只搜文件名匹配这个 glob 的文件,如 *.md"),
        max_results: z.number().int().min(1).max(500).optional().describe("最多返回的匹配行数,默认 100"),
      },
      handler: (args: { pattern: string; path?: string; glob?: string; max_results?: number }, ctx) =>
        attempt(async () => {
          const base = resolveAgainstCwd(cwdOf(ctx), args.path ?? ".");
          let re: RegExp;
          try {
            re = new RegExp(args.pattern, "i");
          } catch (err) {
            return `pattern 不是合法正则:${err instanceof Error ? err.message : String(err)}`;
          }
          const include = args.glob ? globToRegExp(args.glob) : null;

          const st = await fs.stat(base).catch(() => null);
          if (!st) return `路径不存在:${base}`;
          const targets = st.isFile()
            ? [{ abs: base, rel: path.basename(base) }]
            : (await walkFiles(base, include)).map((h) => ({ abs: h.abs, rel: h.rel }));

          const cap = args.max_results ?? 100;
          const lines: string[] = [];
          let scanned = 0;
          for (const t of targets) {
            if (lines.length >= cap) break;
            const buf = await fs.readFile(t.abs).catch(() => null);
            if (!buf || isBinary(buf)) continue;
            scanned += 1;
            const textLines = buf.toString("utf-8").split(/\r?\n/);
            for (let i = 0; i < textLines.length && lines.length < cap; i += 1) {
              if (!re.test(textLines[i])) continue;
              const clipped =
                textLines[i].length > 300 ? `${textLines[i].slice(0, 300)}…` : textLines[i];
              lines.push(`${t.rel}:${i + 1}: ${clipped}`);
            }
          }
          if (lines.length === 0) return `没有匹配「${args.pattern}」的内容(扫了 ${scanned} 个文件)`;
          const more = lines.length >= cap ? `\n…(达到上限 ${cap} 行,可能没搜完)` : "";
          return lines.join("\n") + more;
        }),
    },

    {
      name: "agent_bash",
      description:
        "在用户机器上执行一条 shell 命令并返回 stdout / stderr / 退出码(无持久状态,每次独立执行;" +
        "需要保持目录/环境变量的多步操作请在一条命令里用 && 串联)。默认超时 120 秒。执行前用户会在 mcode 里确认。",
      inputSchema: {
        command: z.string().min(1).describe("要执行的命令(单条;多步用 && 串联)"),
        cwd: z.string().optional().describe("工作目录,默认会话工作目录"),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(MAX_BASH_TIMEOUT_MS)
          .optional()
          .describe("超时毫秒数,默认 120000,最大 600000"),
      },
      handler: (args: { command: string; cwd?: string; timeout_ms?: number }, ctx) =>
        attempt(
          () =>
            new Promise<string>((resolve, reject) => {
              const cwd = resolveAgainstCwd(cwdOf(ctx), args.cwd ?? ".");
              const timeout = Math.min(args.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
              const child = spawn(args.command, {
                shell: true,
                cwd,
                windowsHide: true,
                env: { ...process.env },
              });
              let stdout = "";
              let stderr = "";
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error(`命令超过 ${timeout}ms 没跑完,已终止;可拆成多步或加大 timeout_ms 重试`));
              }, timeout);
              child.stdout.on("data", (d: Buffer) => {
                if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString("utf-8");
              });
              child.stderr.on("data", (d: Buffer) => {
                if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString("utf-8");
              });
              child.on("error", (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
              });
              child.on("close", (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const parts = [`exit: ${code ?? "null"}`];
                if (stdout.trim()) parts.push(`--- stdout ---\n${truncateOutput(stdout.trim(), "stdout")}`);
                if (stderr.trim()) parts.push(`--- stderr ---\n${truncateOutput(stderr.trim(), "stderr")}`);
                resolve(parts.join("\n"));
              });
            }),
        ),
    },

    {
      name: "agent_skill_list",
      description:
        "列出这个会话可用的技能(/skill)。返回每条技能的名字、一句话说明和 SKILL.md 的路径 —— " +
        "用 agent_read_file 或 agent_skill_read 都能读到内容。",
      inputSchema: {},
      handler: (_args: Record<string, never>, _ctx) =>
        attempt(async () => {
          const root = defaultSkillsRoot();
          const engines = readEnginesMap(root);
          let entries: import("node:fs").Dirent[];
          try {
            entries = await fs.readdir(root, { withFileTypes: true });
          } catch {
            return "技能库(~/.mcode/skills)还不存在或读不了 —— 用户还没装任何技能";
          }
          const lines: string[] = [];
          for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            if (!engineEnabled(engines, entry.name, "claude")) continue;
            const dir = path.join(root, entry.name);
            const mdPath = path.join(dir, "SKILL.md");
            const md = await fs.readFile(mdPath, "utf-8").catch(() => null);
            if (md == null) continue;
            const fm = parseSkillFrontmatter(md);
            const name = fm.name?.trim() || entry.name;
            lines.push(`- ${name}${fm.description ? ` — ${fm.description.trim()}` : ""}\n  ${mdPath}`);
          }
          if (lines.length === 0) return "技能库里没有可用的技能(~/.mcode/skills 下没有带 SKILL.md 的目录)";
          return `可用技能 ${lines.length} 条:\n${lines.join("\n")}`;
        }),
    },

    {
      name: "agent_skill_read",
      description:
        "读取一条技能的完整 SKILL.md 内容(按名字)。读了之后照着里面的步骤执行;" +
        "技能里提到的相对路径文件在技能目录下,用 agent_read_file 读。",
      inputSchema: {
        name: z.string().min(1).describe("技能名(agent_skill_list 里列出的名字)"),
      },
      handler: (args: { name: string }, ctx) =>
        attempt(async () => {
          const root = path.resolve(defaultSkillsRoot());
          // 名字里的路径分隔符一律拒掉 —— 只允许一层目录名,防越出技能根。
          if (args.name.includes("/") || args.name.includes("\\") || args.name.includes("..")) {
            return `技能名不合法:${args.name}`;
          }
          const dir = path.join(root, args.name);
          if (!pathWithin(root, dir)) return `技能名不合法:${args.name}`;
          const mdPath = path.join(dir, "SKILL.md");
          const md = await fs.readFile(mdPath, "utf-8").catch(() => null);
          if (md == null) {
            return `没有叫「${args.name}」的技能(或它没有 SKILL.md);用 agent_skill_list 看看有哪些`;
          }
          void ctx;
          return `# skill: ${args.name}\n(目录:${dir})\n\n${md}`;
        }),
    },
  ];
}

/** True if `abs` is inside `root`(或等于),解析归一化之后比。与 files.ts 的
 *  pathWithin 同款逻辑 —— 这里不 import 那份是为了不把它的依赖链拉进这张表。 */
function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  const rel = path.relative(r, a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// homedir 目前只被 defaultSkillsRoot 间接覆盖;这里显式引用避免"看起来没用"的 import
// 被误删 —— 技能根的语义就是"用户主目录下的 .mcode/skills"。
void homedir;
