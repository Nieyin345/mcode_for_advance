/**
 * **项目级 MCP** —— `<项目>/.mcp.json`(Claude Code 的标准格式)。
 *
 * ## 为什么又有项目级了
 *
 * 从前项目级来源被整体移除(settingSources 钉在 ["user"],外部 .mcp.json 一律不继承)。
 * 2026-10-03 用户要求 MCP 和技能一样能放进项目:跟着项目目录走、能分享给同事。所以这里
 * 是 **Mcode 自己读** 这份文件、自己投递,二进制那条路依旧关着 —— 投递口径只有一个。
 *
 * ## 信任
 *
 * stdio 服务器 = 在本机跑一条命令,克隆来的仓库可能自带 `.mcp.json`。所以只有**被信任过**
 * 的条目才投递:信任按「**项目来源** + 名字 + 配置内容」的指纹记(设置项 `mcp.projectTrust`,
 * 字符串数组),配置一改指纹就变、要重新信任。在 Mcode 里新增 / 编辑 / 从总库复制的条目
 * 自动信任。
 *
 * ⚠️ **MC-039:指纹必须绑项目身份。** 从前指纹只由「名字 + 配置内容」算 —— 于是仓库 B 的
 * `.mcp.json` 只要命令文本与仓库 A 相同(如 `node ./mcp-server.js`)就**继承**用户对 A 的
 * 信任,而 B 里那个脚本的内容完全不同 —— 等于一次克隆就拿到"跑任意命令"的授权。现在指纹
 * 里带上项目的**来源身份**({@link projectIdentity}):不同仓库(box 不同目录 / 不同 git 库)
 * 永不共享指纹;**同一仓库的 worktree** 通过显式来源映射(git 的 common dir,读文件得出、
 * 不跑子进程)复用 —— 靠的是"同一个源",不再是"命令文本相同"。
 * (旧格式指纹不含来源,升级后一律不匹配 → 项目条目需重新信任一次,是安全的一侧。)
 *
 * ## 投递
 *
 * - Claude:每轮注入 `options.mcpServers`(见 ClaudeAgentSdkProvider);
 * - Codex:每轮 `-c mcp_servers.<名>={...}` 覆盖(见 codexProjectScope.ts);
 * - Pi:没有 MCP。
 *
 * 值里的 `${VAR}` / `${VAR:-默认}` 投递前按本机环境变量展开(与 Claude Code 一致),
 * 所以密钥可以不写进项目文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_PROJECT_TRUST_SETTING_KEY,
  type McpProjectCopyResult,
  type McpProjectListResult,
  type McpProjectServer,
  type McpServerConfig,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { describeMcpConfig, parseMcpConfig } from "@main/lib/mcpConfig.js";
import { normPathKey } from "@main/lib/pathNorm.js";

export const PROJECT_MCP_FILE = ".mcp.json";

/** Trusted fingerprints kept at most (oldest dropped first). */
const MAX_TRUST = 2000;

/** MC-034: hard ceiling on the size of a project `.mcp.json` we will read.
 *  `readProjectFile` runs on the MAIN thread (它被投递路径 `getTrustedProjectMcpServers`
 *  每个回合同步调用),so a huge / hostile file must not be slurped into memory and
 *  `JSON.parse`d there. 8 MiB is far beyond any real `.mcp.json` (a handful of
 *  server entries) while small enough to parse instantly. Exceeding it is a
 *  refusal with a named reason — never a silent "empty". */
const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;

/** Names starting with `mcode-` belong to the app's own servers. Several of
 *  them are auto-approved BY NAME (`mcp__mcode-app__…`), so a project file
 *  must never be able to register one — it would inherit that trust. */
export function isReservedProjectServerName(name: string): boolean {
  return /^mcode[-_]/i.test(name);
}

export function projectMcpFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_MCP_FILE);
}

/** Reject relative / missing project directories before any read or write. */
function checkProjectDir(projectPath: string): string | null {
  if (!path.isAbsolute(projectPath)) return "项目路径必须是绝对路径";
  try {
    if (!statSync(projectPath).isDirectory()) return "项目目录不存在";
  } catch {
    return "项目目录不存在";
  }
  return null;
}

interface ProjectFile {
  exists: boolean;
  obj: Record<string, unknown>;
  error?: string;
}

function readProjectFile(projectPath: string): ProjectFile {
  const file = projectMcpFile(projectPath);
  if (!existsSync(file)) return { exists: false, obj: {} };
  try {
    // MC-034: check the size BEFORE reading. `readFileSync` on the main thread
    // would otherwise pull an arbitrarily large file into memory and hand it to
    // JSON.parse. Over the ceiling = a NAMED refusal (surfaced in the panel /
    // as a delivery-time skip), never a silent `{}` — a human reading "文件太大"
    // knows to slim the file; an empty list would read as "no servers".
    const { size } = statSync(file);
    if (size > MAX_PROJECT_FILE_BYTES) {
      return {
        exists: true,
        obj: {},
        error: `.mcp.json 太大(${size} 字节,超过 ${MAX_PROJECT_FILE_BYTES} 字节上限),拒绝读取`,
      };
    }
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return { exists: true, obj: {} };
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, obj: {}, error: ".mcp.json 不是一个 JSON 对象" };
    }
    return { exists: true, obj: parsed as Record<string, unknown> };
  } catch (err) {
    return { exists: true, obj: {}, error: `.mcp.json 读不了:${(err as Error).message}` };
  }
}

function serversOf(obj: Record<string, unknown>): Record<string, unknown> {
  const s = obj.mcpServers;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

async function writeProjectFile(projectPath: string, obj: Record<string, unknown>): Promise<void> {
  const file = projectMcpFile(projectPath);
  // MC-040: a same-millisecond PID+Date.now() suffix can collide between two
  // concurrent writers (`<file>.<pid>.<Date.now()>.tmp`). randomUUID makes the
  // staging name unique regardless of timing, so two writers never share (and
  // thus never corrupt) one temp file; the atomic rename still makes the swap
  // itself all-or-nothing.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/* ── MC-040: per-project write serialization ──
 *
 * Every mutation is a read-modify-write over the same `<project>/.mcp.json`
 * (read → merge one entry → write). Two mutations for the SAME project run
 * concurrently (they arrive from separate IPC calls, and the delivery path
 * never blocks them), each reads the file BEFORE the other writes → the
 * second write drops the first's entry ("save A then save B" ends with only
 * B). Serialize per project so the second read sees the first's write.
 *
 * The trust update (`setTrusted` / `writeTrust`) rides INSIDE the same
 * critical section as the file write: a trust change is only meaningful
 * relative to the config that was just written, so it must not interleave
 * with another project mutation's read-modify-write of the trust setting.
 *
 * Keyed by the resolved project path (per-project, not global — two DIFFERENT
 * projects may write their own files in parallel). The map is bounded by the
 * number of distinct project dirs touched; the tail entries are dropped once
 * their chain drains. */

const projectWriteTails = new Map<string, Promise<void>>();

/** Run `op` after all previously queued writes for the same project settle
 *  (success or failure), then queue the next one behind it. The returned
 *  promise settles with `op`'s own result — errors propagate to the caller
 *  and never poison the chain for the next queued write. */
function serializeProjectWrite<T>(projectPath: string, op: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath);
  const tail = projectWriteTails.get(key) ?? Promise.resolve();
  const run = tail.then(op, op);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  projectWriteTails.set(key, settled);
  // Drop the tail once the chain drains AND nothing new was queued behind it,
  // so the map does not grow without bound across many projects.
  void settled.then(() => {
    if (projectWriteTails.get(key) === settled) projectWriteTails.delete(key);
  });
  return run;
}

/* ── Trust ── */

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Canonical form of a filesystem path for identity comparison — resolves
 *  symlinks (so a symlinked checkout maps to its target) and folds case /
 *  separators (win32/darwin). Falls back to the resolved string when the path
 *  can't be realpath'd. */
function canonicalPath(p: string): string {
  let real = path.resolve(p);
  try {
    real = realpathSync.native(real);
  } catch {
    /* keep the resolved form */
  }
  return normPathKey(real);
}

/** MC-039: the git COMMON dir of the work tree containing `dir`, or null when
 *  `dir` is not inside a git work tree. The common dir is `<repo>/.git` for a
 *  main checkout and the SAME shared directory for every linked worktree /
 *  submodule — the "explicit source mapping" that lets one repo's checkouts
 *  pool their trust. Two different clones keep their own `.git` and never
 *  share. Reads the `.git` entry + `commondir` file directly (no subprocess,
 *  works on the main thread). */
function gitSourceKey(dir: string): string | null {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i += 1) {
    const gitPath = path.join(cur, ".git");
    let st: import("node:fs").Stats | null = null;
    try {
      // 【MC-055 反例二】**必须用 `lstatSync`(不跟链接)**,不是 `statSync`。
      //
      // 第十三/十六轮复查各堵了一种 `.git` 伪造,但都建立在"看 `.git` 这个入口**本身**
      // 是什么类型"上 —— 而 `statSync` 会**跟穿** Windows junction / symlink。于是
      // 待授权目录 B 里放一个 `.git` **junction 指向**已信任仓库 A 的 `.git` 目录时,
      // `statSync(B/.git).isDirectory()` 为真 → 走进了"主检出 `.git` 是目录"那一支 →
      // `canonicalPath` 的 realpath 一路跟到 A/.git → B 与 A 身份碰撞、B 的 `.mcp.json`
      // 以 A 的授权交付。lstat 看的是入口**本身**:它是个 reparse point,不是真目录。
      st = lstatSync(gitPath);
    } catch {
      st = null;
    }
    if (st) {
      // 入口是链接/junction —— 一律**拒**。真实的来源只有两种:主检出的 `.git` 是**真
      // 目录**、worktree/submodule 的 `.git` 是**真文件**(由 git 自己写下,不是链接)。
      // 谁把 `.git` 做成一个指向别处的 reparse point,就是在自称一份它并不拥有的来源。
      if (st.isSymbolicLink()) return null;
      if (st.isDirectory()) return canonicalPath(gitPath);
      if (st.isFile()) {
        // 工作树 / 子模块:`.git` 是个文件,内容是 `gitdir: <per-worktree 目录>`。
        try {
          const text = readFileSync(gitPath, "utf8");
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
          // 【MC-055】普通文件但不带 `gitdir:` —— **不是**合法的 worktree 标记。
          // 从前这里 `return canonicalPath(gitPath)`,把"这个 `.git` 文件本身"当成
          // 来源键交付信任。攻击者往待授权目录里丢一个内容任意的 `.git` 文件即可捏造
          // 一个全新身份、或(更糟)与某个已信任仓库的 `.git` 文件字面撞上。合法来源
          // 只可能是**目录**(主检出)或**带 gitdir 回指的工作树文件**;其余的**拒**。
          if (!m) return null;
          const gitdir = path.isAbsolute(m[1]) ? m[1] : path.resolve(cur, m[1]);
          // 【MC-055】**回指校验** —— 这才是关键那一步。真实的 linked worktree /
          // submodule 里,per-worktree git dir **必定**有一个 `gitdir` 文件,内容指回
          // **本工作树的 `.git` 文件**(绝对路径)。没有这个回指、或指到别处,就不是
          // 本工作树的 git dir —— 环境变量 `GIT_DIR=<任意路径>` 就能制造这种状态,而
          // 攻击者控制的 `.git` 文件可以把它指向任何已信任仓库的 `.git`(目录)。
          //
          // 为什么这一步挡得住而只"检查路径存在"挡不住:回指文件必须落在**真实**的
          // 工作树里,由 `git worktree add` 写下;攻击者要伪造它,就得能在该工作树的
          // 目录里写字 —— 若能写,那道防线早已越过,谈身份也无意义。所以对"只控制
          // B 里的一个文件、目标是冒充 A"的攻击者,这一步可证明地挡住:要么 A 是主
          // 检出(其 `.git` 是目录、没有回指文件),要么 A 是 worktree(回指指向 A 的
          // 工作树,而不是 B 的路径)——**两种都判否**。
          const backlink = readBacklink(gitdir);
          if (backlink !== canonicalPath(gitPath)) return null;
          // 回指过关:这是个**被验证过**的工作树 git dir。用它的 `commondir` 指向
          // 共享目录(通常 `<main>/.git`),即同一仓库的所有 checkout 复用的那一个。
          try {
            const commonRel = readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
            const common = path.isAbsolute(commonRel) ? commonRel : path.resolve(gitdir, commonRel);
            return canonicalPath(common);
          } catch {
            return canonicalPath(gitdir);
          }
        } catch {
          return null;
        }
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** 读一个 git dir 里 `gitdir` 回指文件(剔除首尾空白),读不到返回 null。 */
function readBacklink(gitdir: string): string | null {
  try {
    return canonicalPath(readFileSync(path.join(gitdir, "gitdir"), "utf8").trim());
  } catch {
    return null;
  }
}

/** MC-039: the project's SOURCE identity — folded into every trust
 *  fingerprint. Inside a git work tree it is the repo's common git dir (so all
 *  checkouts of one source share trust); outside git it is the normalized
 *  absolute directory path. Exported for the regression suite. */
export function projectIdentity(projectPath: string): string {
  const abs = path.resolve(projectPath);
  const git = gitSourceKey(abs);
  return git ? `git:${git}` : `dir:${canonicalPath(abs)}`;
}

/** Fingerprint of one entry as written: **project source** + name + raw config.
 *
 *  ⚠️ MC-039: the project identity is part of the hash. 从前只有 `name\0raw`,
 *  于是一份命令文本相同的 `.mcp.json` 在**另一个仓库**里也命中同一指纹 ——
 *  克隆一个仓库就能继承用户对本地另一份脚本的信任。绑上来源之后,不同仓库
 *  永不共享;同一仓库的 worktree 因共享 common git dir 而照常复用。 */
export function projectServerFingerprint(projectPath: string, name: string, raw: unknown): string {
  return createHash("sha256")
    .update(`${projectIdentity(projectPath)}\0${name}\0${stable(raw)}`)
    .digest("hex");
}

function readTrust(): string[] {
  try {
    const raw = SettingRepo.get(MCP_PROJECT_TRUST_SETTING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeTrust(list: string[]): void {
  const unique = [...new Set(list)];
  SettingRepo.set(MCP_PROJECT_TRUST_SETTING_KEY, JSON.stringify(unique.slice(-MAX_TRUST)));
}

function setTrusted(fingerprint: string, trusted: boolean): void {
  const list = readTrust().filter((f) => f !== fingerprint);
  if (trusted) list.push(fingerprint);
  writeTrust(list);
}

/* ── Env expansion (`${VAR}` / `${VAR:-default}`) ── */

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : (def ?? "");
  });
}

function expandRecord(rec: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = expand(v, env);
  }
  return out;
}

/** The config with `${VAR}` references resolved against `env`. */
export function expandProjectServerConfig(config: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  if (config.type === "http" || config.type === "sse") {
    const headers = expandRecord(config.headers, env);
    return { ...config, url: expand(config.url, env), ...(headers ? { headers } : {}) };
  }
  const envVars = expandRecord(config.env, env);
  return {
    ...config,
    command: expand(config.command, env),
    ...(config.args ? { args: config.args.map((a) => (typeof a === "string" ? expand(a, env) : a)) } : {}),
    ...(envVars ? { env: envVars } : {}),
  };
}

/* ── Panel operations ── */

/** Secret-free one-line summary (URL query strings can carry tokens). */
function detailOf(config: McpServerConfig): { kind: McpProjectServer["kind"]; detail: string } {
  const d = describeMcpConfig(config);
  if (d.kind === "http" || d.kind === "sse") {
    return { kind: d.kind, detail: d.detail.replace(/[?#].*$/, "") };
  }
  return { kind: "stdio", detail: d.detail };
}

export function listProjectMcp(projectPath: string): McpProjectListResult {
  const file = projectMcpFile(projectPath);
  const dirError = checkProjectDir(projectPath);
  if (dirError) return { file, exists: false, servers: [], invalid: [], error: dirError };
  const read = readProjectFile(projectPath);
  const trust = new Set(readTrust());
  const servers: McpProjectServer[] = [];
  const invalid: string[] = [];
  for (const [name, raw] of Object.entries(serversOf(read.obj))) {
    const config = parseMcpConfig(raw);
    if (!config) {
      invalid.push(name);
      continue;
    }
    servers.push({
      name,
      ...detailOf(config),
      config,
      trusted: !isReservedProjectServerName(name) && trust.has(projectServerFingerprint(projectPath, name, raw)),
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { file, exists: read.exists, servers, invalid, ...(read.error ? { error: read.error } : {}) };
}

export function saveProjectMcp(
  projectPath: string,
  name: string,
  config: McpServerConfig,
  replace = false,
): Promise<{ ok: boolean; error?: string }> {
  if (isReservedProjectServerName(name)) return Promise.resolve({ ok: false, error: `「${name}」是 Mcode 内置服务器的保留名(mcode- 开头)` });
  const dirError = checkProjectDir(projectPath);
  if (dirError) return Promise.resolve({ ok: false, error: dirError });
  return serializeProjectWrite(projectPath, async () => {
    const read = readProjectFile(projectPath);
    // A broken file is the user's content — never overwrite it with our guess.
    if (read.error) return { ok: false, error: `${read.error}(先手动修好再保存)` };
    const servers = { ...serversOf(read.obj) };
    if (!replace && name in servers) return { ok: false, error: `项目里已有名为「${name}」的服务器` };
    servers[name] = config;
    await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
    // MC-040: 置信任与文件写在**同一临界区** —— 否则并发写会让信任指向一个别的
    // 写者刚覆盖掉的配置(或反过来)。
    setTrusted(projectServerFingerprint(projectPath, name, config), true);
    return { ok: true };
  });
}

export function removeProjectMcp(projectPath: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const dirError = checkProjectDir(projectPath);
  if (dirError) return Promise.resolve({ ok: false, error: dirError });
  return serializeProjectWrite(projectPath, async () => {
    const read = readProjectFile(projectPath);
    if (read.error) return { ok: false, error: read.error };
    const servers = { ...serversOf(read.obj) };
    if (!(name in servers)) return { ok: false, error: `项目里没有名为「${name}」的服务器` };
    const fingerprint = projectServerFingerprint(projectPath, name, servers[name]);
    delete servers[name];
    await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
    setTrusted(fingerprint, false);
    return { ok: true };
  });
}

export function trustProjectMcp(projectPath: string, name: string, trusted: boolean): Promise<{ ok: boolean; error?: string }> {
  const dirError = checkProjectDir(projectPath);
  if (dirError) return Promise.resolve({ ok: false, error: dirError });
  // MC-040: 信任变更也要串行 —— 它读-改-写的是同一份 `mcp.projectTrust` 设置,并与
  // 项目文件的写共享"配置 → 指纹"的一致性。
  return serializeProjectWrite(projectPath, async () => {
    const read = readProjectFile(projectPath);
    if (read.error) return { ok: false, error: read.error };
    const raw = serversOf(read.obj)[name];
    if (raw === undefined) return { ok: false, error: `项目里没有名为「${name}」的服务器` };
    if (trusted && isReservedProjectServerName(name)) return { ok: false, error: `「${name}」是 Mcode 内置服务器的保留名,不能信任` };
    if (trusted && !parseMcpConfig(raw)) return { ok: false, error: `「${name}」的配置无效,不能信任` };
    setTrusted(projectServerFingerprint(projectPath, name, raw), trusted);
    return { ok: true };
  });
}

/** Copy user-scope configs (总库) into the project file; existing names are
 *  skipped. `userConfigs` = the truth layer (enabled + stashed). */
export function copyUserServersToProject(
  projectPath: string,
  names: readonly string[],
  userConfigs: Record<string, McpServerConfig>,
): Promise<McpProjectCopyResult> {
  const dirError = checkProjectDir(projectPath);
  if (dirError) {
    return Promise.resolve({ copied: [], skipped: [], failed: names.map((name) => ({ name, reason: dirError })) });
  }
  return serializeProjectWrite(projectPath, async () => {
    const result: McpProjectCopyResult = { copied: [], skipped: [], failed: [] };
    const read = readProjectFile(projectPath);
    if (read.error) {
      result.failed = names.map((name) => ({ name, reason: read.error as string }));
      return result;
    }
    const servers = { ...serversOf(read.obj) };
    for (const name of names) {
      const config = userConfigs[name];
      if (!config) result.failed.push({ name, reason: "总库里没有这个服务器" });
      else if (isReservedProjectServerName(name)) result.failed.push({ name, reason: "mcode- 开头是保留名" });
      else if (name in servers) result.skipped.push(name);
      else {
        servers[name] = config;
        result.copied.push(name);
      }
    }
    if (result.copied.length > 0) {
      await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
      writeTrust([...readTrust(), ...result.copied.map((n) => projectServerFingerprint(projectPath, n, servers[n]))]);
    }
    return result;
  });
}

/* ── Delivery ── */

/** The nearest directory at or above `cwd` holding a `.mcp.json` — a session
 *  started in a project subfolder still gets the project's servers (same
 *  lookup direction as Claude Code). Trust gates delivery, so finding a stray
 *  file higher up is harmless. */
function findProjectRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(path.join(dir, PROJECT_MCP_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Trusted, valid servers of the project a session runs in (`cwd`), with
 *  `${VAR}` expanded. Never throws: a broken file delivers nothing. */
export function getTrustedProjectMcpServers(cwd: string | undefined): Array<[string, McpServerConfig]> {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  try {
    const root = findProjectRoot(cwd);
    if (!root) return [];
    const read = readProjectFile(root);
    if (!read.exists || read.error) return [];
    const trust = new Set(readTrust());
    const out: Array<[string, McpServerConfig]> = [];
    for (const [name, raw] of Object.entries(serversOf(read.obj))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || isReservedProjectServerName(name)) continue;
      if (!trust.has(projectServerFingerprint(root, name, raw))) continue;
      const config = parseMcpConfig(raw);
      if (config) out.push([name, expandProjectServerConfig(config)]);
    }
    return out;
  } catch {
    return [];
  }
}
