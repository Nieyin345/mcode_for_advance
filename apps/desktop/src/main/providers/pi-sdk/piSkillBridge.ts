/**
 * Skill bridge: make Mcode's skill directories and `/name` trigger syntax work
 * with the Pi SDK.
 *
 * Pi's skill mechanism is structurally different from Claude's, and the project
 * was originally wired only for Claude, so skills silently no-op under the Pi
 * provider. Three mismatches had to be fixed together (any one alone leaves the
 * feature broken):
 *
 *   1. **Path mismatch.** Pi's `DefaultResourceLoader` scans `<agentDir>/skills`
 *      (`~/.pi/agent/skills`) and `<cwd>/.pi/skills` (`CONFIG_DIR_NAME=".pi"`),
 *      but Mcode stores user skills in `~/.mcode/skills` and project skills in
 *      `<cwd>/.claude/skills` (see `ipc/skills.ts:resolveSkillRoot`). Pi scans
 *      none of them, so `getSkills()` returns an empty set.
 *
 *   2. **Trigger syntax mismatch.** Pi only recognizes `/skill:name`
 *      (`agent-session.js:_expandSkillCommand` gates on
 *      `text.startsWith("/skill:")`). The composer serializes a skill pill as a
 *      bare `/name` (`ComposerEditor.tsx` `renderText`), so Pi falls through to
 *      `expandPromptTemplate` and ships the literal `/name` to the LLM.
 *
 *   3. **`req.skills` dropped.** Unlike Claude's `Options.skills` allowlist, Pi
 *      has no skill option on `createAgentSession`; the only hook is
 *      `resourceLoader`, and `skillsOverride` is the name-based filter.
 *
 * The bridge:
 *   - {@link buildPiSkillLoader} constructs a `DefaultResourceLoader` whose
 *     `additionalSkillPaths` pulls in the two Mcode roots (Pi's own defaults are
 *     kept so existing `~/.pi` users aren't disrupted), and whose
 *     `skillsOverride` narrows the discovered set to the user-selected names
 *     when `req.skills` is non-empty.
 *   - {@link rewriteSkillPrefix} rewrites a leading `/name` to `/skill:name` for
 *     the names the loader actually resolved, so Pi's `_expandSkillCommand`
 *     recognizes the invocation.
 *
 * This module is provider-internal: the renderer/contracts/IPC layers are
 * provider-neutral and don't change (skill pills render off the `skillNames`
 * persisted on the message text block at send time, independent of the
 * provider).
 */
import { homedir } from "node:os";
import path from "node:path";
import { bashPathHintFor, detectBashEnv } from "@main/lib/bashEnv.js";
import { msysToWindowsPath } from "@main/lib/msysPath.js";
import {
  defaultSkillsRoot,
  enabledSkillNames,
  engineEnabled,
  engineRestricted,
  projectSkillsRoot,
  readEnginesMap,
  skillNamesInRoot,
} from "@main/lib/skillEngines.js";

/** Suffix-free access to the Pi SDK module type (the provider already loads it
 *  via `loadPiSdk()` and hands us the resolved module). */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
/** The loader type `createAgentSession` accepts. We return the concrete class so
 *  the provider can also call `getSkills()` to learn the resolved names for the
 *  prompt rewrite. */
export type PiResourceLoader = import("@earendil-works/pi-coding-agent").DefaultResourceLoader;

/**
 * Mcode's skill **roots** (the directories whose children are skill dirs — Pi's
 * `additionalSkillPaths` scans each for `<root>/<name>/SKILL.md`):
 *   - the global library `~/.mcode/skills` (mirrors `ipc/skills.ts`);
 *   - the CURRENT PROJECT's skills `<cwd>/.claude/skills`.
 *
 * 【MC-094】项目根**曾**被删掉(2026-09-17 "上下文统一托管"),但用户紧接着
 * (2026-09-20/21)又把项目级技能要了回来 —— `ipc/skills.ts` 现在有 `projectSkillsRoot`,
 * 面板能列/复制项目技能。删根的那句注释已成**过时的旧决定**,与现状打架:项目技能在
 * 面板看得见、Pi 却收不到。这里把项目根接回来,与面板共用**同一份**
 * `projectSkillsRoot`(单一实现,不各算一份)。无有效项目路径时该项目根为 null,不进列表。
 */
function mcodeSkillRoots(cwd: string): string[] {
  const global = path.join(homedir(), ".mcode", "skills");
  const project = projectSkillsRoot(cwd);
  return project ? [global, project] : [global];
}

export interface BuildPiSkillLoaderOptions {
  sdk: PiSdk;
  /** Project working directory (the session's `cwd`). */
  cwd: string;
  /** Skill names the user picked in the composer (no leading `/`). When
   *  non-empty, the loader narrows the discovered skills to this set (mirrors
   *  Claude's `Options.skills` allowlist). Empty/undefined → all discovered
   *  skills (mirrors Claude's `"all"` sentinel). */
  allowNames?: string[];
  /** Additional skill roots beyond Mcode's two defaults — the skills
   *  directories of ENABLED plugins (settings → Plugins), supplied by the
   *  provider from pluginManager.getEnabledPluginSkillRoots(). Absent/empty
   *  keeps the historical pair. */
  extraSkillPaths?: string[];
  /** Host-resolved per-turn context fragments. Pi's loader appends these to
   *  its native system prompt before the agent starts. */
  systemPromptAppends?: string[];
  /** Inline extensions to inject via the loader's `extensionFactories` option.
   *  The loader runs each factory during `getExtensions()` (before
   *  `_refreshToolRegistry`), so `pi.registerTool` / `pi.on` are wired before
   *  the first turn. Mcode passes its host-bridging extension (approval,
   *  AskUserQuestion, system-prompt injection) here. */
  extensionFactories?: import("@earendil-works/pi-coding-agent").InlineExtension[];
}

/** True when `child` resolves inside `dir` (or equals it). Case-folded — Pi
 *  injects `baseDir` verbatim from its own scan, and on Windows the same
 *  directory can reach us with differing casing. Separator-aware so a
 *  sibling prefix (`/foo/bar` vs `/foo/baz`) can't false-positive. */
function isInsideDir(child: string, dir: string): boolean {
  if (!child) return false;
  const c = path.resolve(child).toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  return c === d || c.startsWith(d + path.sep);
}

/**
 * Construct and reload a `DefaultResourceLoader` configured to discover Mcode's
 * skill directories in addition to Pi's own defaults, filtered by the
 * per-engine skill matrix and the user's composer picks.
 *
 * The returned loader is ready to pass as `createAgentSession({ resourceLoader
 * })` — the SDK skips its own default construction and does NOT call `reload()`
 * again when a loader is supplied (see `sdk.js` around line 75), so we reload
 * here exactly once.
 *
 * Never throws on a missing/unreadable skills dir: `DefaultResourceLoader`
 * treats unresolvable `additionalSkillPaths` as empty. The override below is a
 * best-effort name filter; an unknown name in `allowNames` simply matches
 * nothing (the model then sees no such skill — same as Claude's allowlist).
 */
export async function buildPiSkillLoader(
  opts: BuildPiSkillLoaderOptions,
): Promise<PiResourceLoader> {
  const { sdk, cwd, allowNames, extraSkillPaths, systemPromptAppends, extensionFactories } = opts;
  // The effective name filter: explicit picks narrow the global matrix; they
  // never revive a skill disabled for Pi. Otherwise the universal library's
  // per-engine matrix decides. null = unrestricted (no override needed).
  //
  // 【MC-074】`explicitPicks` 与「矩阵推导出的限制集合」**必须分开对待**:用户
  // 在输入框里点名选中的 skill,交付范围就是**恰好这几个** —— 下面的插件名单合并
  // (为「矩阵限制 pi 时别把插件 skill 一起过滤掉」而加)只对**矩阵推导**的 allowSet
  // 成立,绝不能把插件里同被矩阵放行的 skill 塞进一份显式点选集(那会让"我只选了 A"
  // 变成"选了 A 加一堆插件 skill",正是本条要修的单轮选择范围失效)。
  const explicitPicks = !!(allowNames && allowNames.length > 0);
  const enginesMap = readEnginesMap(defaultSkillsRoot());
  const allowSet: Set<string> | null = explicitPicks
    ? new Set((allowNames as string[]).filter((name) => engineEnabled(enginesMap, name, "pi")))
    : (() => {
        const enabled = enabledSkillNames(defaultSkillsRoot(), "pi");
        return enabled === null ? null : new Set(enabled);
      })();

  // The engines matrix applies to plugin contributions too: a plugin skill the
  // user took away from pi must NOT show up. When the matrix is unrestricted on
  // pi (no entry restricts it), every plugin name passes through — that
  // matches the old behavior. Plugin roots are scanned by Pi's loader just
  // like the universal root, so the allowSet filter below gates them the same
  // way it gates the universal skills. (Builtin skills — the four shipped with
  // the app — intentionally stay out of the matrix; they load under every
  // engine regardless.)
  const universalRoot = defaultSkillsRoot();
  const matrixRestrictsPi = engineRestricted(enginesMap, "pi");
  // 【MC-094】项目技能根(会话 cwd 下的 `<cwd>/.claude/skills`,与面板同一个
  // `projectSkillsRoot`)。它的技能也进 `additionalSkillPaths`,会被下面的 skillsOverride
  // 过滤 —— 所以当矩阵限制 pi 时,必须像插件名一样把项目技能名并进 allowSet,否则
  // **只存在于项目里的**技能会被这份"全局库名册"过滤掉(又一个静默失效)。
  const projectRoot = projectSkillsRoot(cwd);
  // When the matrix is restricted on pi, also merge in plugin skill names the
  // matrix still allows — without this, a matrix state that restricts pi would
  // filter out every plugin skill (the old bug: the allowSet only carried
  // universal-library names, so every plugin skill vanished as soon as any
  // restriction landed). 【MC-074】**只在矩阵推导路径生效**:用户显式点选时
  // allowSet 就是那几个名字,不得被插件名单扩容。【MC-094】项目技能名同理由此并入
  // (同一个 allowSet,同一份矩阵判据;项目技能默认对 pi 放行,除非全局矩阵按名字禁了它)。
  if (!explicitPicks && matrixRestrictsPi) {
    const mergedRoots = [...(extraSkillPaths ?? []), ...(projectRoot ? [projectRoot] : [])];
    for (const root of mergedRoots) {
      for (const name of skillNamesInRoot(root).keys()) {
        if (engineEnabled(enginesMap, name, "pi")) {
          if (allowSet) allowSet.add(name);
        }
      }
    }
  }

  const loader = new sdk.DefaultResourceLoader({
    noContextFiles: true, // Host resolves bounded AGENTS.md/CLAUDE.md consistently.
    cwd,
    // `getAgentDir()` honors `PI_CODING_AGENT_DIR` and the package's
    // `piConfig.configDir`; hand-building `~/.pi/agent` would miss both.
    agentDir: sdk.getAgentDir(),
    // Inline extensions — the loader calls each factory during
    // `getExtensions()`, before `_refreshToolRegistry`, so `pi.registerTool`
    // / `pi.on` are live before the first agent turn. Mcode's extension
    // bridges host approval, AskUserQuestion, and system-prompt injection.
    extensionFactories: extensionFactories ?? [],
    // Pull in Mcode's global root + the CURRENT PROJECT's root (【MC-094】) —
    // plus ENABLED plugin skill roots — alongside Pi's defaults. We deliberately
    // leave `noSkills` unset so Pi's own `~/.pi/agent/skills` + `<cwd>/.pi/skills`
    // keep working — existing Pi users aren't disrupted (modulo the same-name
    // precedence in the override below).
    additionalSkillPaths: [...mcodeSkillRoots(cwd), ...(extraSkillPaths ?? [])],
    // On Windows, append a path-style hint that matches the bash the SDK will
    // actually spawn — native (Git Bash: `/mnt/...` doesn't exist) or WSL
    // (`/mnt/...` is the only absolute form that resolves; `detectBashEnv`
    // mirrors the SDK's `getShellConfig` resolution, so on machines where Git
    // isn't at the hardcoded locations and its `usr\bin` isn't on PATH, `where
    // bash.exe` lands on the WSL launcher and every Bash call runs inside
    // WSL). The `createMntNormalizingReadTool` override is the silent-recovery
    // backstop; this hint attacks the root cause and also covers
    // Bash-redirected reads.
    appendSystemPrompt: [
      ...(systemPromptAppends ?? []),
      ...(process.platform === "win32" ? [bashPathHintFor(detectBashEnv("pi"))] : []),
    ].map((text) => text.trim()).filter((text) => text.length > 0),
    // ALWAYS supply the override (not just when a selection exists): it now
    // does two jobs.
    //   1. Same-name precedence across stores, matching the panel's rank
    //      (project > global > plugin/pi-local). A skill discovered OUTSIDE a
    //      higher-rank store with the same name yields to it — so a project
    //      skill overrides a same-named global one, a global skill overrides a
    //      same-named ~/.pi/agent/skills copy, and no name is delivered twice.
    //   2. The name filter — allowSet null (no picks, matrix unrestricted)
    //      passes everything through, which reproduces the old no-override
    //      behavior exactly.
    skillsOverride: (base: {
      skills: import("@earendil-works/pi-coding-agent").Skill[];
      diagnostics: import("@earendil-works/pi-coding-agent").ResourceDiagnostic[];
    }) => {
      // Which store does this skill come from? 0 = project, 1 = global library,
      // 2 = everything else (plugins, Pi's own ~/.pi defaults). Lower = wins.
      const rankOf = (s: import("@earendil-works/pi-coding-agent").Skill): number => {
        const dir = s.baseDir ?? "";
        if (projectRoot && isInsideDir(dir, projectRoot)) return 0;
        if (isInsideDir(dir, universalRoot)) return 1;
        return 2;
      };
      // Stable sort by rank, then keep the first occurrence of each name — so
      // the higher-precedence store's copy survives and later same-named ones
      // are dropped (a name is delivered exactly once).
      const seen = new Set<string>();
      const skills: import("@earendil-works/pi-coding-agent").Skill[] = [];
      for (const s of [...base.skills].sort((a, b) => rankOf(a) - rankOf(b))) {
        if (seen.has(s.name)) continue;
        if (allowSet && !allowSet.has(s.name)) continue;
        seen.add(s.name);
        skills.push(s);
      }
      return { skills, diagnostics: base.diagnostics };
    },
  });
  await loader.reload();
  return loader;
}

/**
 * Rewrite a leading `/name` (a composer-emitted skill pill) into Pi's
 * `/skill:name` trigger form, but only for names the loader actually resolved.
 *
 * Why only the leading token: Pi's `_expandSkillCommand` itself only recognizes
 * `/skill:` at `text[0]` (`agent-session.js:951`), so rewriting mid-text would
 * have no effect on Pi and would only corrupt the user's message. A skill pill
 * embedded mid-sentence isn't expanded by Pi regardless; for those, Pi's
 * `formatSkillsForPrompt` already lists every discovered skill in the system
 * prompt and the model can load it via the `read` tool as a fallback.
 *
 * `knownNames` is the set of names the (allowlist-filtered) loader resolved —
 * the same set Pi's internal `find(s => s.name === skillName)` will search, so
 * the rewrite never produces a `/skill:` token Pi can't expand (which would
 * otherwise fall through to the LLM as a literal).
 *
 * The character class is deliberately wider than Pi's `^[a-z0-9-]+$` name
 * validation: Mcode skills may carry uppercase/underscores, and validation
 * failure only produces a *warning* (the skill still loads with its original
 * name), so we must match the raw name. The trailing negative lookahead
 * `(?![A-Za-z0-9_-])` stops the match at the token boundary so `/pdf-docs more`
 * isn't mistaken for skill `pdf` followed by `-docs`.
 */
export function rewriteSkillPrefix(text: string, knownNames: Set<string>): string {
  if (!text.startsWith("/")) return text;
  // `/skill:name` is already Pi-native — leave it (and don't double-rewrite if
  // the user happened to type it literally). Also avoid matching `//` or path-
  // like prefixes.
  if (text.startsWith("/skill:")) return text;
  const m = text.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)/);
  if (!m) return text;
  const name = m[1];
  if (!knownNames.has(name)) return text;
  // Preserve the boundary after the name (space, end, etc.) — only the leading
  // `/name` token is rewritten to `/skill:name`.
  return `/skill:${name}${text.slice(1 + name.length)}`;
}

/* ──────────────────── Windows WSL-path defense ──────────────────── */

/**
 * Translate a WSL-style `/mnt/<drive>/...` (or Git Bash style `/d/...`) path
 * to a native Windows `<DRIVE>:\...` path. Returns the original string
 * unchanged when it isn't a recognized dialect form.
 *
 * This is the read-side counterpart of `normalizeToolFilePath` in
 * `fileSnapshot.ts`, but stripped to JUST the dialect→Windows translation:
 * read is a non-mutating operation that legitimately reaches outside the
 * project (skills live under `~/.mcode/skills`, docs under `~/Documents`, …),
 * so the strict in-project guard that file-write tools enforce must NOT apply
 * here. Shared implementation lives in `@main/lib/msysPath.ts` so the read
 * tool, the file-write guards, and the bash-command normalizer all agree on
 * the same translation.
 *
 * Root cause being mitigated: the Pi SDK injects skill `filePath`/`baseDir`
 * verbatim as native Windows paths (`agent-session.js:959`), but the model —
 * trained on Linux/WSL examples — rewrites them to `/mnt/c/...` (or `/c/...`)
 * when it later issues a `read`. The SDK's read tool does zero dialect
 * normalization (the raw string reaches `fs.readFile` and fails), so we patch
 * the path before delegating.
 */
export function wslToWindowsPath(p: string): string {
  return msysToWindowsPath(p);
}

/**
 * Wrap the SDK's built-in `read` tool so any WSL-style `/mnt/<drive>/...`
 * argument is translated to a native Windows path before the wrapped execute
 * runs. Mirrors `createGuardedFileTools` in this provider: a same-name
 * `customTools` entry overrides the built-in (`definitionRegistry.set`), and
 * the override is a pure passthrough when the path isn't a `/mnt/` form.
 *
 * Built from `sdk.createReadToolDefinition(cwd)` so the wrapped tool keeps the
 * SDK lazy-loaded (no module-level import that would pull it into startup).
 *
 * The `any`-parameterized type mirrors `AnyToolDef` in
 * `PiAgentSdkProvider.createGuardedFileTools`: the SDK's concrete read schema
 * (`typeof readSchema`) doesn't structurally satisfy a fully-generic
 * `ToolDefinition` because `renderCall`/`renderResult` are contravariant in
 * their args, so we widen to `ToolDefinition<any, any, any>` for the override.
 */
export function createMntNormalizingReadTool(
  sdk: PiSdk,
  cwd: string,
): import("@earendil-works/pi-coding-agent").ToolDefinition<any, any, any> {
  type AnyToolDef = import("@earendil-works/pi-coding-agent").ToolDefinition<any, any, any>;
  const base = sdk.createReadToolDefinition(cwd) as AnyToolDef;
  return {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const raw = (params as { path?: unknown } | null | undefined)?.path;
      if (typeof raw === "string" && raw.length > 0) {
        const fixed = wslToWindowsPath(raw);
        if (fixed !== raw) {
          params = { ...(params as object), path: fixed };
        }
      }
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * System-prompt hints for the Pi agent's bash environment now live in
 * `@main/lib/bashEnv.ts` (`bashPathHintFor` + `detectBashEnv("pi")`) — the
 * detector mirrors the SDK's `getShellConfig` resolution, and the hint text
 * differs between native Windows bash and WSL bash (the two shells genuinely
 * differ in which path forms resolve). The `createMntNormalizingReadTool`
 * defense-in-depth recovers silently when the model still emits a `/mnt/`
 * path, but the hint cuts how often that happens (and also covers
 * Bash-redirected reads, which the tool override can't intercept).
 */
