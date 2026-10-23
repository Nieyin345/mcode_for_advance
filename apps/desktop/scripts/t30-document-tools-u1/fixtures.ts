/**
 * T30 —— 夹具工厂（跑在探针主进程里）。
 *
 * 为什么不照抄 T7 的 fixtures.ts：T7 用 vendor 的 docx-engine / pptx-engine
 * （静态 `require` + `--alias` 到 TS 源码）造夹具。那套东西会把 vendor 的
 * renderer 依赖拖进**本套件的 journeys bundle**，而本卡只做「工具面」，不需要
 * 自己拼 docx/pptx 字节。
 *
 * 这里改用**产品自己的 CLI**（`genoffice convert` / `sheet read`）造夹具：
 *   - docx：Markdown → docx（`convert md --to docx`）；
 *   - xlsx：vendor shell 的 `blank.xlsx` 原样拷贝。
 * 两者都是磁盘上的真格式文件，编辑断言才有意义。
 *
 * 幂等：文件已存在且非空就复用 —— 重开进程后不能把上一代写过的内容重置，
 * 否则「重开后改动还在」会变成假绿。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 每份夹具里的一行唯一文本（编辑断言据此区分「原内容」与「AI 写入」）。 */
export const UNIQUE = {
  docs: "T30-DOCS-5c7e19",
  sheets: "T30-XLSX-2b8f4a",
};

export interface FixturePaths {
  docs: string;
  sheets: string;
}

export interface CliRun {
  ok: boolean;
  envelope: Record<string, unknown> | null;
  raw: string;
  reason: string;
}

/**
 * 直接跑产品 CLI（与 `genofficeCli.ts` 同一条 `dist/genoffice.cjs`）。
 * 旅程里的「独立读取」用它 —— 不经过被测的 `document.tool_call`，才算独立证据。
 */
export function runGenofficeCli(
  repoRoot: string,
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
): CliRun {
  const cli = join(repoRoot, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
  // ⚠️ 本函数在**探针主进程（Electron）里**跑：`process.execPath` 是 electron.exe。
  // 不设 `ELECTRON_RUN_AS_NODE=1` 会再起一个 Electron 应用（弹窗 + 错误进程）——
  // 与生产 `genofficeCli.invoke` 的最小环境逐项一致：只给 PATH 与这一个开关。
  const path = process.env.PATH ?? process.env.Path ?? "";
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? join(repoRoot, "genoffice"),
    encoding: "utf8",
    timeout: 60_000,
    env: { ELECTRON_RUN_AS_NODE: "1", ...(path ? { PATH: path } : {}) },
    ...(options.stdin !== undefined ? { input: options.stdin } : {}),
  });
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(out.trim());
    envelope = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch { envelope = null; }
  const ok = run.status === 0 && envelope?.status === "ok";
  return {
    ok,
    envelope,
    raw: out,
    reason: ok ? "" : (typeof envelope?.message === "string" ? envelope.message : out.slice(0, 400)),
  };
}

/** 用 CLI 读 xlsx 的某个单元格（独立读取器，不经过页面/Univer/我们的 handler）。 */
export function readCellWithCli(repoRoot: string, file: string, address = "A1"): { ok: boolean; value: string; raw: string } {
  const result = runGenofficeCli(repoRoot, ["sheet", "read", file, "--range", `${address}:${address}`, "--json"]);
  const detail = result.envelope?.detail as { rows?: unknown[][] } | undefined;
  const value = detail?.rows?.[0]?.[0];
  return { ok: result.ok, value: String(value ?? ""), raw: result.raw.slice(0, 400) };
}

/**
 * 生成两份夹具。幂等：已存在且非空即复用。
 * 返回前会断言「文件真的在盘上且非空」，避免旅程在错误的前提上跑。
 */
export function ensureFixtures(projectDir: string, repoRoot: string): FixturePaths {
  const paths: FixturePaths = {
    docs: join(projectDir, "t30-docs.docx"),
    sheets: join(projectDir, "t30-sheets.xlsx"),
  };
  mkdirSync(projectDir, { recursive: true });
  const nonEmpty = (p: string): boolean => existsSync(p) && readFileSync(p).length > 0;

  if (!nonEmpty(paths.docs)) {
    const source = join(projectDir, "t30-docs-source.md");
    if (!nonEmpty(source)) {
      writeFileSync(source, `# T30 fixture\n\n${UNIQUE.docs}\n\nsecond paragraph\n`, "utf8");
    }
    const made = runGenofficeCli(repoRoot, ["convert", source, "--to", "docx", "--out", paths.docs, "--force", "--json"]);
    if (!made.ok) throw new Error(`T30 fixtures: docs convert 失败：${made.reason}`);
  }

  if (!nonEmpty(paths.sheets)) {
    const blank = join(repoRoot, "genoffice", "apps", "shell", "build", "shell-new", "blank.xlsx");
    if (!existsSync(blank)) throw new Error(`T30 fixtures: vendor blank.xlsx 不存在：${blank}`);
    writeFileSync(paths.sheets, readFileSync(blank));
  }

  for (const [kind, path] of Object.entries(paths)) {
    if (!nonEmpty(path)) throw new Error(`T30 fixtures: ${kind} 夹具为空（${path}）`);
  }
  return paths;
}
