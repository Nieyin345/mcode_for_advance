/**
 * **ARC-010:项目初始化 = SceneSpec 的一种可编译资源。**
 *
 * `ProjectInitDraft`(`@contracts/ipc/projectInit`)与 `SceneSpec`(`@contracts/sceneSpec`)
 * 此前是两条互不相干的声明:一边是设置页里那个「独立向导」里的模板(`directories` /
 * `files` / `memories` / `agentFile`),另一边是 ARC-002 建立起来的场景声明链
 * (`SceneSpec` → `compileScenePlan` → `ScenePlan` → 部署)。ARC-010 要的正是把前者**变成**
 * 后者的一种资源 —— 一份项目脚手架应当能作为一个场景被编译、被预检、被同一套审计。
 *
 * ## 本文件做什么(以及**不**做什么)
 *
 * 这里只有**两处纯投影**:
 *
 *  1. {@link projectInitToSceneSpec} —— 模板 → `SceneSpec`。每条目录 / 文件 / 记忆 / 说明文件
 *     翻成一条 `kind: "scaffold"` 资源,`spec.entry` 细分是哪种。产出经得起
 *     `validateSceneSpec`(一次报全)与 `compileScenePlan`(父目录排在文件之前)。
 *  2. {@link sceneSpecToProjectInitDraft} —— `SceneSpec` → 模板,**只在**这份声明是**纯脚手架**
 *     时才成功;任何不能还原成模板的东西(别的资源种类、能力声明、projectId / 引擎偏好 /
 *     版本锁、脚手架里多出来的字段)都**逐条报出来**,绝不静默丢(硬规矩 3)。
 *
 * **不建文件、不碰磁盘、不另造执行引擎** —— 投影只重排数据。真正落盘仍是既有
 * `main/projectInit/service.ts` 的职责。这里**纯**到可被渲染端直接打包(无 electron / DB / fs)。
 *
 * ## 判据窄且诚实
 *
 * - **确定性**:同一模板 + 同一 opts → 逐字节相同的 `SceneSpec`(重复部署幂等靠它)。
 * - **边界显式**:`sceneId` 从名字推不出来(全非 ASCII)、模板本身不合法、声明的资源不是脚手架,
 *   都返回 `{ ok:false, problems }` 而不是一个缺斤少两的 spec。
 * - **`name` 的已知缺口**:`SceneSpec` 没有 name 字段,名字经 `sceneId` 往返 —— 见
 *   {@link sceneSpecToProjectInitDraft} 的说明,仅对 ASCII 名保真。
 *
 * ## 有意不做的两件事(写在这里,免得被当成疏漏)
 *
 * - **不展开「隐含父目录」**。`main/projectInit/service.ts` 在 apply 时会为由路径隐含的父目录
 *   (如 `data/raw` 隐含 `data`)补建目录;本投影**只**翻译模板显式声明的 `directories`。
 *   抄一份那套展开逻辑就违反硬规矩 2(共享实现只有一份),而这里也用不到它 —— 缺的父目录
 *   由部署器按需创建。于是文件的 `dependsOn` 只连到**显式声明过的**祖先目录。
 * - **不表示禁用的 `agentFile`**。`agentFile.enabled === false` 没有任何产出(不建文件、
 *   不发提示词),因此不翻成资源 —— 丢的是一个无效果的空配置,不是语义。
 */
import { SCENE_SPEC_SCHEMA_VERSION, SCENE_ID_RE, type SceneSpec, type SceneSpecProblem } from "./sceneSpec.js";
import {
  ProjectInitDraftSchema,
  AGENT_FILE_NAMES,
  type AgentFileName,
  type ProjectInitDraft,
} from "./ipc/projectInit.js";
import { MEMORY_CATEGORIES, type MemoryCategory } from "./memory.js";

/** 一条脚手架资源的 `spec.entry` —— 模板里四类条目。 */
export const SCAFFOLD_ENTRIES = ["directory", "file", "memory", "agentFile"] as const;
export type ScaffoldEntry = (typeof SCAFFOLD_ENTRIES)[number];

/** 模板 → SceneSpec 的可选覆盖(不覆盖时从模板本身推导)。 */
export interface ProjectInitToSceneSpecOptions {
  /** 场景 id。不给时从模板名 slug 出;推不出合法 id(全非 ASCII)则报问题。 */
  sceneId?: string;
  /** 场景目标。不给时取模板 description(空则用一句默认)。 */
  goal?: string;
  /** 目标项目 id(原样放进声明)。 */
  projectId?: string;
  /** 首选引擎(原样放进声明;`sceneSpecToProjectInitDraft` 会因它无法还原而拒绝)。 */
  preferredProviderId?: string;
}

/** 模板 → SceneSpec 的结果:成功给 spec,失败**一次报全**问题(不是报第一个)。 */
export type ProjectInitToSceneSpecResult =
  | { ok: true; spec: SceneSpec }
  | { ok: false; problems: SceneSpecProblem[] };

/** SceneSpec → 模板的结果:成功给 draft,失败逐条报「为什么这份声明不是纯脚手架」。 */
export type SceneSpecToProjectInitResult =
  | { ok: true; draft: ProjectInitDraft }
  | { ok: false; problems: SceneSpecProblem[] };

/* ── 小工具(确定性,不依赖 locale) ── */

/** 名字 → 场景 id:小写、非 `[a-z0-9]` 折叠成 `-`、去首尾 `-`、截到 64。 */
export function sceneIdFromName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 目录 / 文件路径里,位于本条目之上的各层目录(浅 → 深)。用于 dependsOn。 */
function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const out: string[] = [];
  while (parts.length) {
    out.unshift(parts.join("/"));
    parts.pop();
  }
  return out;
}

const ENTRY_ALLOWED_KEYS: Record<ScaffoldEntry, readonly string[]> = {
  directory: ["entry", "path"],
  file: ["entry", "path", "content"],
  memory: ["entry", "category", "filename", "title", "content", "pinned"],
  agentFile: ["entry", "filename", "focus"],
};

/**
 * **模板 → SceneSpec** —— 确定性纯投影。
 *
 * 每条显式目录 / 文件 / 记忆 / 启用的说明文件翻成一条 `kind: "scaffold"` 资源,id 形如
 * `dir:<path>` / `file:<path>` / `memory:<category>/<filename>` / `agentFile`(与路径无关,唯一)。
 * 资源顺序 = 模板书写顺序(目录 → 文件 → 记忆 → 说明文件);文件对**显式声明过的**祖先目录
 * 记 `dependsOn`,于是「父目录排在文件之前」交给 `compileScenePlan` 的拓扑排序,**不**在这里
 * 重排(既保往返保真,也不抄第二份排序逻辑)。
 * 产出经得起 `validateSceneSpec` 与 `compileScenePlan`。
 *
 * @param template 已/未校验的模板草稿(内部会再走一遍 `ProjectInitDraftSchema`;不合法 → 报问题)。
 * @param opts     可选覆盖(sceneId / goal / projectId / preferredProviderId)。
 */
export function projectInitToSceneSpec(
  template: ProjectInitDraft,
  opts: ProjectInitToSceneSpecOptions = {},
): ProjectInitToSceneSpecResult {
  const problems: SceneSpecProblem[] = [];

  // ① 模板本身先自洽(防御性:调用方可能递进来一个只有类型没有校验过的对象)。
  const parsed = ProjectInitDraftSchema.safeParse(template);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push({ path: issue.path.join("."), message: issue.message });
    }
    return { ok: false, problems };
  }
  const draft = parsed.data;

  // ② sceneId:显式给定必须合法;否则从名字推,推不出就报问题(不硬造一个)。
  const sceneId = opts.sceneId ?? sceneIdFromName(draft.name);
  if (!SCENE_ID_RE.test(sceneId)) {
    problems.push({
      path: "sceneId",
      message: opts.sceneId
        ? `sceneId「${opts.sceneId}」不合法(须为小写 id:字母数字/_/-,≤64;以字母或数字开头)`
        : `模板名「${draft.name}」推不出合法 sceneId(不含 ASCII 字母数字);请在 opts.sceneId 指定`,
    });
    return { ok: false, problems };
  }

  // ③ 资源:目录(父先子后)→ 文件 → 记忆 → 说明文件。
  const directoryPaths = new Set(draft.directories);
  const resources: SceneSpec["resources"] = [];
  const dirId = (p: string) => `dir:${p}`;
  const fileId = (p: string) => `file:${p}`;
  const memoryId = (c: MemoryCategory, f: string) => `memory:${c}/${f}`;

  const sortedDirs = draft.directories;
  for (const path of sortedDirs) {
    const dependsOn = ancestorDirs(path)
      .filter((p) => directoryPaths.has(p))
      .map(dirId);
    resources.push({
      kind: "scaffold",
      id: dirId(path),
      spec: { entry: "directory", path },
      ...(dependsOn.length ? { dependsOn } : {}),
    });
  }
  for (const file of draft.files) {
    const dependsOn = ancestorDirs(file.path)
      .filter((p) => directoryPaths.has(p))
      .map(dirId);
    resources.push({
      kind: "scaffold",
      id: fileId(file.path),
      spec: { entry: "file", path: file.path, content: file.content },
      ...(dependsOn.length ? { dependsOn } : {}),
    });
  }
  for (const memory of draft.memories) {
    resources.push({
      kind: "scaffold",
      id: memoryId(memory.category, memory.filename),
      spec: {
        entry: "memory",
        category: memory.category,
        filename: memory.filename,
        title: memory.title,
        content: memory.content,
        pinned: memory.pinned,
      },
    });
  }
  // 只有启用的说明文件才有产出(enabled=false 无任何效果 → 不翻成资源,见文件头)。
  const agentFile = draft.agentFile;
  if (agentFile?.enabled) {
    resources.push({
      kind: "scaffold",
      id: "agentFile",
      spec: { entry: "agentFile", filename: agentFile.filename, focus: agentFile.focus },
    });
  }

  // ④ 验收:把每条资源都列进回读期望(部署后逐个确认可见)。
  const goal = (opts.goal ?? "").trim() || draft.description.trim() || `初始化项目「${draft.name}」`;
  const counts = `目录 ${draft.directories.length} / 文件 ${draft.files.length} / 记忆 ${draft.memories.length}`;
  const spec: SceneSpec = {
    schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
    sceneId,
    goal,
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    ...(opts.preferredProviderId !== undefined ? { preferredProviderId: opts.preferredProviderId } : {}),
    // 项目脚手架不引用任何本机能力(插件/技能/MCP/模块)—— 建目录、写文件不需要它们。
    capabilities: [],
    resources,
    acceptance: {
      description: `初始化项目「${draft.name}」(${counts}${agentFile?.enabled ? " / 说明文件" : ""})`,
      expectResourceIds: resources.map((r) => r.id),
    },
  };
  return { ok: true, spec };
}

/**
 * **SceneSpec → 模板** —— 只在这是**纯脚手架**声明时成功。
 *
 * 成功要求(缺一即报问题,不静默降级):
 *  1. `resources` 全部是 `kind: "scaffold"`,且每条 `spec.entry` 是四种之一、字段不多不少、类型正确;
 *  2. `capabilities` 为空(纯脚手架不引用本机能力);
 *  3. 没有 `projectId` / `preferredProviderId` / `lock`(模板无处安放它们 —— 报出来而不是丢掉);
 *  4. 还原出的草稿能过 `ProjectInitDraftSchema`(路径守卫 `safeInitPath`、重名、条数上限等)。
 *
 * **名字**:`SceneSpec` 没有 name 字段,模板名取 `spec.sceneId`。故 `name` 只对**由 ASCII 名
 * 推出来的** sceneId 保真;中文名投影时需显式 `opts.sceneId`,往返后 name 是那个 id(已在
 * `projectInitToSceneSpec` 说明)。`description` 取 `spec.goal`。
 *
 * @param spec 已通过 `validateSceneSpec` 的场景声明(本函数仍会逐字段核对)。
 */
export function sceneSpecToProjectInitDraft(spec: SceneSpec): SceneSpecToProjectInitResult {
  const problems: SceneSpecProblem[] = [];

  if (spec.capabilities.length > 0) {
    problems.push({ path: "capabilities", message: `纯脚手架场景不应引用本机能力(有 ${spec.capabilities.length} 条)` });
  }
  if (spec.projectId !== undefined) {
    problems.push({ path: "projectId", message: "模板无处安放 projectId;这不是纯脚手架声明" });
  }
  if (spec.preferredProviderId !== undefined) {
    problems.push({ path: "preferredProviderId", message: "模板无处安放引擎偏好;这不是纯脚手架声明" });
  }
  if (spec.lock !== undefined) {
    problems.push({ path: "lock", message: "模板无处安放版本锁;这不是纯脚手架声明" });
  }

  const directories: string[] = [];
  const files: Array<{ path: string; content: string }> = [];
  const memories: Array<{
    category: MemoryCategory; filename: string; title: string; content: string; pinned: boolean;
  }> = [];
  let agentFile: { enabled: boolean; filename: AgentFileName; focus: string } | undefined;
  let agentFileCount = 0;

  for (const [i, r] of spec.resources.entries()) {
    const at = `resources[${i}]`;
    if (r.kind !== "scaffold") {
      problems.push({ path: `${at}.kind`, message: `只有 scaffold 资源能还原成项目初始化草稿(得到 ${r.kind})` });
      continue;
    }
    const entry = r.spec.entry;
    if (typeof entry !== "string" || !(SCAFFOLD_ENTRIES as readonly string[]).includes(entry)) {
      problems.push({ path: `${at}.spec.entry`, message: `未知的脚手架条目类型 ${JSON.stringify(entry)}(须为 ${SCAFFOLD_ENTRIES.join("/")})` });
      continue;
    }
    const kind = entry as ScaffoldEntry;
    // 多出来的字段一律报(无法还原 → 不静默丢)。
    const extra = Object.keys(r.spec).filter((k) => !ENTRY_ALLOWED_KEYS[kind].includes(k));
    if (extra.length) {
      problems.push({ path: `${at}.spec`, message: `${kind} 脚手架含无法还原的额外字段:${extra.join("、")}` });
    }
    if (kind === "directory") {
      if (typeof r.spec.path !== "string") { problems.push({ path: `${at}.spec.path`, message: "directory 需要字符串 path" }); continue; }
      directories.push(r.spec.path);
    } else if (kind === "file") {
      if (typeof r.spec.path !== "string") { problems.push({ path: `${at}.spec.path`, message: "file 需要字符串 path" }); continue; }
      if (typeof r.spec.content !== "string") { problems.push({ path: `${at}.spec.content`, message: "file 需要字符串 content" }); continue; }
      files.push({ path: r.spec.path, content: r.spec.content });
    } else if (kind === "memory") {
      const { category, filename, title, content } = r.spec;
      if (typeof category !== "string" || !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        problems.push({ path: `${at}.spec.category`, message: `记忆类目不合法:${JSON.stringify(category)}` });
        continue;
      }
      if (typeof filename !== "string") { problems.push({ path: `${at}.spec.filename`, message: "memory 需要字符串 filename" }); continue; }
      if (typeof title !== "string") { problems.push({ path: `${at}.spec.title`, message: "memory 需要字符串 title" }); continue; }
      if (typeof content !== "string") { problems.push({ path: `${at}.spec.content`, message: "memory 需要字符串 content" }); continue; }
      if (r.spec.pinned !== undefined && typeof r.spec.pinned !== "boolean") {
        problems.push({ path: `${at}.spec.pinned`, message: "memory 的 pinned 若给必须是布尔" });
        continue;
      }
      memories.push({
        category: category as MemoryCategory,
        filename,
        title,
        content,
        pinned: r.spec.pinned === undefined ? true : (r.spec.pinned as boolean),
      });
    } else {
      // agentFile
      agentFileCount += 1;
      if (agentFileCount > 1) {
        problems.push({ path: at, message: "脚手架最多一份说明文件资源" });
        continue;
      }
      const { filename, focus } = r.spec;
      if (typeof filename !== "string" || !(AGENT_FILE_NAMES as readonly string[]).includes(filename)) {
        problems.push({ path: `${at}.spec.filename`, message: `说明文件名必须是 ${AGENT_FILE_NAMES.join("/")}(得到 ${JSON.stringify(filename)})` });
        continue;
      }
      if (typeof focus !== "string") { problems.push({ path: `${at}.spec.focus`, message: "agentFile 需要字符串 focus" }); continue; }
      agentFile = { enabled: true, filename: filename as AgentFileName, focus };
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const candidate = {
    name: spec.sceneId,
    description: spec.goal,
    directories,
    files,
    memories,
    ...(agentFile ? { agentFile } : {}),
  };
  const parsed = ProjectInitDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  return { ok: true, draft: parsed.data };
}
