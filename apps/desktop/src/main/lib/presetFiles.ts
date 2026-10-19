/**
 * **出厂预置文件的通用读取器** —— `resources/presets/*.json` 的路径解析与健康态判定。
 *
 * ## 它补的是哪一段(MC-007 / MC-006)
 *
 * 2026-10-10 把五个对话模式 + 两条自动化从 `builtins.ts` 摘出去,落成仓库里的
 * `resources/presets/workflows.json`,注释写着「用户按需导入」。但那份文件**没有任何
 * 运行时代码读它**,`electron-builder.yml` 也没把它打进安装包 —— 内容外置了、可达路径
 * 没给:release 用户和 Agent 都拿不到。MC-006 的出厂项目初始化模板是同一个形态。
 *
 * 这一份是**所有** `resources/presets/<file>.json` 共用的那一层:路径解析、读文件、
 * 三态健康、逐条问题的措辞。各域(工作流 / 项目初始化 / 将来的)只负责把自己那份
 * JSON 的条目过一遍**自己的契约 schema**,不各写一套路径与错误处理 —— 两套路径迟早
 * 会漂,而漂了的表现是"某个安装里某类出厂内容凭空消失"。
 *
 * ## 路径解析:为什么是三个候选,而不是一个
 *
 * | 场景 | 候选 |
 * |---|---|
 * | 打包后(安装包) | `process.resourcesPath/presets/<file>`(`extraResources` 铺过去) |
 * | 开发(`pnpm dev`)/ 无头 smoke | `<cwd>/resources/presets/<file>` |
 * | 从仓库根跑脚本 | `<cwd>/apps/desktop/resources/presets/<file>` |
 *
 * **不用 `__dirname`/`import.meta.url` 拼模块相对路径**:main chunk 是 CJS、无头
 * esbuild bundle 是 ESM,两种模块系统各有一个(且另一个在对面不存在)。进程级的
 * `cwd` 与 `resourcesPath` 两边都在,候选表也就能在两种宿主里跑同一份逻辑 ——
 * smoke 验的就是生产代码本身,不是抄本。
 *
 * 一个都命中不了 → `absent`,**显式返回状态给调用方**,不抛、不静默返回空列表
 * (硬规矩 3:坏东西显式报出来)。渲染端据此说「这个安装包没带出厂预设」。
 *
 * ## 分类与形状:坏条目**逐条**报出来,好的照常可用
 *
 * 本文件只做**文件级**判定(读得到 / 是 JSON / 有顶层容器);条目级校验由各域用自己的
 * 契约 schema 做,坏的进 `problems` **不静默丢** —— 少列一项而什么都不说,正是
 * 「内容凭空消失」的形态。整份 JSON 解析不了才是 `corrupt`(那种情况下一条都用不了)。
 *
 * ## 与 `builtins.ts` 的分工
 *
 * - `builtins.ts`:按钮后端(`default` / `watch` / 记忆工作流),**播种**进表、删不掉语义。
 * - 这份:用户**按需导入**的出厂内容,导进来就是普通行(可改可删)。
 */
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PresetCatalogHealth } from "@contracts/workflow";

/**
 * 预置选择只接受目录中的一个叶子名；仓库另有 presetRelativePath("scripts")
 *  用于预置脚本目录。不能让新调用者把 "../secrets.json" 当文件名传给读取器。
 */
function validPresetLeaf(fileName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName) && fileName !== "." && fileName !== "..";
}

/** 预置文件名 → 相对每个候选根的路径。 */
export function presetRelativePath(fileName: string): string {
  if (!validPresetLeaf(fileName)) throw new Error("非法预置文件名：只允许一个叶子文件名");
  return join("resources", "presets", fileName);
}

/**
 * 候选根目录(按优先级)。
 *
 * `MCODE_PRESET_ROOT` 是给**打包验证 / 特殊安装布局**留的显式覆盖:设了就**只**用它
 * —— 一个显式指定的位置读不到时报 `absent`,而不是悄悄落到别的候选上装作读到了。
 *
 * ## 【MC-007 复核补漏】同一个根下要试**两种布局**
 *
 * 同一份内容在两种宿主里的挂法**不同**:
 *
 *   - **开发 / 无头**:`<cwd>/resources/presets/<file>`(`cwd` = `apps/desktop`)。
 *   - **打包**:`electron-builder.yml` 的 `extraResources: from resources/presets → to presets`
 *     把内容铺到 **`<process.resourcesPath>/presets/`** —— 那里**没有**再套一层
 *     `resources/`。从前这里对 `process.resourcesPath` 也拼 `resources/presets/…`,
 *     实际解析成 `<resources>/resources/presets/…`(永远不存在);macOS 从 Finder 启动时
 *     `cwd` 是 `/`,两个 cwd 候选也救不回 —— 打包态会一致报 `absent`(Windows 只是靠
 *     快捷方式的 cwd 恰好是安装目录才碰巧命中)。`MCODE_PRESET_ROOT` 覆盖只在验证时设,
 *     挡不住真实用户。
 *
 * 所以**每个根都按「完整相对路径 → 根下 `presets/`」两种布局各试一次**
 * ({@link presetPathCandidatesIn})。这比"按根的身份猜布局"稳 —— 调用方传进来的候选
 * 可以是任意临时目录(打包验证就是这么做的),身份判断在那种场合无从谈起。
 */
export function presetRootCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env["MCODE_PRESET_ROOT"];
  if (override !== undefined && override.length > 0) return [override];
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(String(process.resourcesPath));
  roots.push(process.cwd());
  roots.push(join(process.cwd(), "apps", "desktop"));
  return roots;
}

/** 某个根下该文件的两种可能路径(开发布局在前、打包布局在后)。 */
export function presetPathCandidatesIn(root: string, fileName: string): string[] {
  if (!validPresetLeaf(fileName)) return [];
  return [join(root, presetRelativePath(fileName)), join(root, "presets", fileName)];
}

type PresetCandidate = { state: "ok"; path: string } |
  { state: "absent" } | { state: "unsafe"; path: string; reason: string };

/** Shared predicate for both public entrypoints. All components BELOW the
 * trusted root (including the final leaf) must be real dirs/files, not
 * symlinks, junctions, special files or unreadable paths. No lexical/physical
 * escape is permitted. A missing path is only "absent", not "corrupt".
 * The explicit candidate root itself may be an OS managed resource link.
 * This is not a handle-relative / TOCTOU-proof OS sandbox. */
function inspectPresetCandidate(root: string, file: string): PresetCandidate {
  const rel = relative(resolve(root), resolve(file));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    return { state: "unsafe", path: file, reason: "预置路径越出指定根目录" };
  }
  let cursor = resolve(root);
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return { state: "unsafe", path: file, reason: "预置路径包含符号链接或 junction" };
      }
      if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
        return { state: "unsafe", path: file, reason: "预置路径的目录或文件类型异常" };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      return { state: "unsafe", path: file, reason: "预置路径不可检查:" + (err as Error).message };
    }
  }
  return { state: "ok", path: file };
}

function pickPresetCandidate(fileName: string, candidates: readonly string[]): PresetCandidate {
  if (!validPresetLeaf(fileName)) {
    return { state: "unsafe", path: fileName, reason: "非法预置文件名：不能包含目录分隔符或路径穿越" };
  }
  for (const root of candidates) {
    for (const file of presetPathCandidatesIn(root, fileName)) {
      const check = inspectPresetCandidate(root, file);
      if (check.state !== "absent") return check;
    }
  }
  return { state: "absent" };
}

/** 解析到第一个安全且真实存在的预置文件；任何越界/损坏返回 null。 */
export function resolvePresetFile(
  fileName: string,
  candidates: readonly string[] = presetRootCandidates(),
): string | null {
  const picked = pickPresetCandidate(fileName, candidates);
  return picked.state === "ok" ? picked.path : null;
}

export type PresetFileRead =
  | { health: "ok"; path: string; value: unknown }
  | { health: "absent"; path: string; reason: string }
  | { health: "corrupt"; path: string; reason: string };

/**
 * 读一个预置文件并解析 JSON。只判断**文件级**三态;顶层形状由调用方验(各域顶层
 * 容器名不同:`workflows` / `templates`),这里不假设。
 */
export function readPresetJson(
  fileName: string,
  candidates: readonly string[] = presetRootCandidates(),
): PresetFileRead {
  const picked = pickPresetCandidate(fileName, candidates);
  if (picked.state === "unsafe") {
    return { health: "corrupt", reason: picked.reason, path: picked.path };
  }
  if (picked.state === "absent") {
    const rel = presetRelativePath(fileName);
    return {
      health: "absent",
      reason: `没有找到出厂预置文件(${rel});试过:${candidates.join("、")}`,
      path: candidates.flatMap((root) => presetPathCandidatesIn(root, fileName)).join("、"),
    };
  }
  const file = picked.path;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { health: "corrupt", reason: `出厂预置文件读不出来:${(err as Error).message}`, path: file };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { health: "corrupt", reason: `出厂预置文件不是合法 JSON:${(err as Error).message}`, path: file };
  }

  return { health: "ok", path: file, value };
}

/** 把一组条目逐条过 schema,坏的进 `problems`(与 `importWorkflowDoc` 同一条口径:
 *  只列前 3 处 issue,但「还有几处」要说出来,否则用户以为改完这几处就好了)。 */
export function parsePresetEntries<T>(
  entries: readonly unknown[],
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; detail: string },
  label: string,
  problems: string[],
): T[] {
  const out: T[] = [];
  entries.forEach((entry, index) => {
    const parsed = parse(entry);
    if (!parsed.ok) {
      problems.push(`第 ${index + 1} 条不是合法的${label}:${parsed.detail}`);
      return;
    }
    out.push(parsed.value);
  });
  return out;
}
