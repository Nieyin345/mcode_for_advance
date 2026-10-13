/**
 * **SceneSpec —— 场景声明**(ARC-002 / MC-058 的 P0 核心)。
 *
 * ## 它补的洞
 *
 * 今天用户要「每天检查代码、跑测试、失败通知我」,只能自己在 Workflow / Automation / 插件 /
 * 技能 / Hook / 面板之间逐个点出来 —— 每一块单独可用,但**没有一份声明**能把它们作为一个
 * 场景整体表达、校验、部署、维护。`SceneSpec` 就是那份声明。
 *
 * ## 分层(照 ARC-002 的目标模型)
 *
 * ```text
 * SceneSpec(声明:我要什么)  →  ScenePlan(编译器产出的变更列表)  →  SceneDeployment(部署事实)
 * ```
 *
 * 本文件只定义**声明**(`SceneSpec`)+ 一处**确定性校验**(`validateSceneSpec`)—— 纯数据、纯函数,
 * 不碰执行。编译(生成 `ScenePlan`)与部署(执行 + 回读)是后续切片;本切片先把「一份场景长什么样、
 * 什么样的声明不合法」钉死,让后面的编译器有一份稳定输入。
 *
 * ## 两条硬边界(写在类型里,不是承诺)
 *
 * 1. **SceneSpec 是纯数据,可分享** —— 因此**绝不**内嵌密钥 / 绝对路径 / 已签发的 grant /
 *    主机授信。要引用的能力(plugin/skill/mcp/…)只给**id + 版本约束**,真实凭据与授权
 *    由部署时在**本机**解析、单独审批(见 `@contracts/policyEngine` 与 `publicMcpScope`)。
 * 2. **模型提出 SceneSpec ≠ 获得执行权限** —— 这里的校验只保证「声明自洽、引用不矛盾」;
 *    每个真实能力、配置版本、targetPath 的准入是部署时 preflight 的事(后续切片),**不是**
 *    因为这段 JSON 通过了校验就能跑。所以本文件里没有任何「批准」「授权」字段。
 */

/** 场景声明只认这一版;将来加字段要么向后兼容,要么升这个号并给迁移。 */
export const SCENE_SPEC_SCHEMA_VERSION = 1 as const;

/** id 形状:小写字母/数字/下划线/连字符,与项目里其它 id 同取向(排除路径分隔符)。
 *  **导出**给 `@contracts/sceneProjectInit` 复用(ARC-010 从模板名推导 sceneId 要用同一判据,
 *  不另抄一份)。 */
export const SCENE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 场景要声明自己需要的一类**能力引用**。
 *
 * **只放 id + 版本约束,不放实现/命令/密钥** —— 具体哪个插件、哪条 MCP、哪台主机的凭据
 * 由部署时在本机解析。`required` 决定预检是 ALL(必需)还是「部分可用也可接受」(可选)。
 */
export interface SceneCapabilityRef {
  /** 能力种类,与 `@contracts/capability` 的 `CapabilityKind` 同取向(子集:场景只引用这些)。 */
  kind: "plugin" | "skill" | "mcp" | "module";
  /** 能力 id(插件名 / 技能名 / MCP 名 / 模块 id)。 */
  id: string;
  /** 版本约束(语义化版本的精确值或不给 = 不限);**不存解决后的版本**。 */
  version?: string;
  /** 必需(true)还是可选(false,缺了给部分可用报告而不是拒绝)。缺省 = 必需。 */
  required?: boolean;
}

/** 场景要产生的**资源**种类(均由现有服务承载,不另造 runtime 引擎)。 */
export type SceneResourceKind =
  | "workflow"
  | "automation"
  | "skill"
  | "plugin"
  | "mcp"
  | "hook"
  | "module"
  | "panel"
  /** 项目脚手架条目(ARC-010):目录 / 文件 / 记忆 / AI 生成说明文件。用 `spec.entry` 细分,
   *  具体投影见 `@contracts/sceneProjectInit`。 */
  | "scaffold";

/**
 * 一条资源引用。**声明的是「要什么」,不是「怎么建」** —— 建的动作由编译器翻成对**现有
 * 服务**的命令(workflow_save / automation 保存 / 插件安装 …),不是在本契约里写脚本。
 * `spec` 是那一条资源的**声明形态**(形状由各资源的既有契约在编译时校验,本契约不重复定义)。
 */
export interface SceneResourceRef {
  kind: SceneResourceKind;
  /** 这条资源在本场景内的稳定 id(编译器据此做幂等与 diff;改了它 = 换了一条资源)。 */
  id: string;
  /** 资源声明正文(具体形状由各 kind 的既有契约校验)。**不得含密钥/绝对路径**。 */
  spec: Record<string, unknown>;
  /** 依赖的其它场景资源 id(拓扑排序用;引用不存在的 id = 声明错误)。 */
  dependsOn?: string[];
}

/** 验收目标 —— 部署完要能**回读证明**的东西(不是一句「完成了」)。 */
export interface SceneAcceptance {
  /** 人读的验收说明(会进部署报告)。 */
  description: string;
  /** 期望在 readback 里可见的资源 id 列表(部署器逐个回读确认可见)。 */
  expectResourceIds: string[];
}

/** 一份完整的场景声明。 */
export interface SceneSpec {
  schemaVersion: typeof SCENE_SPEC_SCHEMA_VERSION;
  /** 场景稳定 id(同一场景重复部署/diff 靠它)。 */
  sceneId: string;
  /** 用户原话的目标(保留原始意图,供审计与 refactor)。 */
  goal: string;
  /** 目标项目 id(哪个项目里建;空 = 由部署时选)。**只给 id,不给绝对路径**。 */
  projectId?: string;
  /** 引擎选择策略(偏好哪个 provider;空 = 由能力预检决定)。**id,不内嵌引擎配置**。 */
  preferredProviderId?: string;
  /** 需要的能力引用(预检按 required 做 ALL/部分判定)。 */
  capabilities: SceneCapabilityRef[];
  /** 要产生的资源。 */
  resources: SceneResourceRef[];
  /** 验收目标。 */
  acceptance: SceneAcceptance;
  /** 版本约束 / 依赖锁(ARC-011 的 SceneLock 将来落这里;本切片先留可选位)。 */
  lock?: Record<string, string>;
}

/* ── 校验(确定性、纯函数) ── */

/** 一条校验问题。`path` 指向声明里的位置(`resources[2].id` 这样),便于模型/用户定位。 */
export interface SceneSpecProblem {
  path: string;
  message: string;
}

/** 校验结果:自洽返回 `{ ok: true, spec }`;不合法返回全部问题(**一次报全,不是报第一个**)。 */
export type SceneSpecValidation =
  | { ok: true; spec: SceneSpec }
  | { ok: false; problems: SceneSpecProblem[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * **校验一份候选 SceneSpec** —— 确定性纯函数,是「模型提出计划」与「计划能不能往下走」
 * 之间的那道闸。**只做声明自洽性校验**,不查真实能力是否存在(那是部署 preflight 的事,
 * 见文件头第 2 条)。一次返回**全部**问题,不是遇到第一个就停 —— 否则模型要来回试很多轮。
 */
export function validateSceneSpec(raw: unknown): SceneSpecValidation {
  const problems: SceneSpecProblem[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, problems: [{ path: "", message: "SceneSpec 必须是一个对象" }] };
  }
  if (raw.schemaVersion !== SCENE_SPEC_SCHEMA_VERSION) {
    problems.push({
      path: "schemaVersion",
      message: `schemaVersion 必须是 ${SCENE_SPEC_SCHEMA_VERSION}(得到 ${JSON.stringify(raw.schemaVersion)})`,
    });
  }
  const sceneId = raw.sceneId;
  if (typeof sceneId !== "string" || !SCENE_ID_RE.test(sceneId)) {
    problems.push({ path: "sceneId", message: "sceneId 必须形如小写 id(字母数字/_/-,≤64 字符)" });
  }
  if (typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
    problems.push({ path: "goal", message: "goal 不能为空(用户原话目标)" });
  }
  if (raw.projectId !== undefined && typeof raw.projectId !== "string") {
    problems.push({ path: "projectId", message: "projectId 若给必须是字符串(项目 id,不是路径)" });
  }
  if (raw.preferredProviderId !== undefined && typeof raw.preferredProviderId !== "string") {
    problems.push({ path: "preferredProviderId", message: "preferredProviderId 若给必须是字符串" });
  }
  // ── capabilities ──
  const capabilities: SceneCapabilityRef[] = [];
  if (raw.capabilities !== undefined && !Array.isArray(raw.capabilities)) {
    problems.push({ path: "capabilities", message: "capabilities 必须是数组" });
  } else {
    for (const [i, c] of ((raw.capabilities as unknown[] | undefined) ?? []).entries()) {
      const at = `capabilities[${i}]`;
      if (!isPlainObject(c)) { problems.push({ path: at, message: "能力引用必须是对象" }); continue; }
      const kind = c.kind;
      if (kind !== "plugin" && kind !== "skill" && kind !== "mcp" && kind !== "module") {
        problems.push({ path: `${at}.kind`, message: `能力种类必须是 plugin/skill/mcp/module(得到 ${JSON.stringify(kind)})` });
      }
      if (typeof c.id !== "string" || c.id.length === 0) {
        problems.push({ path: `${at}.id`, message: "能力 id 不能为空" });
      }
      if (c.version !== undefined && typeof c.version !== "string") {
        problems.push({ path: `${at}.version`, message: "version 若给必须是字符串" });
      }
      if (c.required !== undefined && typeof c.required !== "boolean") {
        problems.push({ path: `${at}.required`, message: "required 若给必须是布尔" });
      }
      if (typeof c.id === "string" && c.id.length > 0 && typeof kind === "string") {
        capabilities.push({
          kind: kind as SceneCapabilityRef["kind"],
          id: c.id,
          ...(typeof c.version === "string" ? { version: c.version } : {}),
          ...(typeof c.required === "boolean" ? { required: c.required } : {}),
        });
      }
    }
  }
  // ── resources ──
  const resources: SceneResourceRef[] = [];
  const resourceIds = new Set<string>();
  const RESOURCE_KINDS: readonly SceneResourceKind[] = ["workflow", "automation", "skill", "plugin", "mcp", "hook", "module", "panel", "scaffold"];
  if (!Array.isArray(raw.resources)) {
    problems.push({ path: "resources", message: "resources 必须是数组" });
  } else {
    for (const [i, r] of raw.resources.entries()) {
      const at = `resources[${i}]`;
      if (!isPlainObject(r)) { problems.push({ path: at, message: "资源引用必须是对象" }); continue; }
      if (!RESOURCE_KINDS.includes(r.kind as SceneResourceKind)) {
        problems.push({ path: `${at}.kind`, message: `资源种类必须是 ${RESOURCE_KINDS.join("/")}(得到 ${JSON.stringify(r.kind)})` });
      }
      if (typeof r.id !== "string" || r.id.length === 0) {
        problems.push({ path: `${at}.id`, message: "资源 id 不能为空(编译器据此做幂等/diff)" });
      } else if (resourceIds.has(r.id)) {
        problems.push({ path: `${at}.id`, message: `资源 id 重复:${r.id}` });
      } else {
        resourceIds.add(r.id);
      }
      if (r.spec !== undefined && !isPlainObject(r.spec)) {
        problems.push({ path: `${at}.spec`, message: "spec 必须是对象(该 kind 的资源声明正文)" });
      }
      if (r.dependsOn !== undefined) {
        if (!Array.isArray(r.dependsOn) || r.dependsOn.some((d) => typeof d !== "string")) {
          problems.push({ path: `${at}.dependsOn`, message: "dependsOn 若给必须是字符串数组" });
        }
      }
    }
    // 依赖引用存在性(第二条循环:此时 resourceIds 已集全,顺序无关)。
    for (const [i, r] of raw.resources.entries()) {
      if (!isPlainObject(r) || !Array.isArray(r.dependsOn)) continue;
      for (const d of r.dependsOn) {
        if (typeof d === "string" && !resourceIds.has(d)) {
          problems.push({ path: `resources[${i}].dependsOn`, message: `依赖了不存在的资源 id:${d}` });
        }
      }
    }
    // 依赖环检测(自环 + 简单环):拓扑排序要求无环,否则编译器定不出顺序。
    const cycle = findDependencyCycle(raw.resources, resourceIds);
    if (cycle !== null) {
      problems.push({ path: "resources", message: `资源依赖存在环:${cycle.join(" → ")}` });
    }
    for (const [i, r] of raw.resources.entries()) {
      if (!isPlainObject(r)) continue;
      resources.push({
        kind: r.kind as SceneResourceKind,
        id: String(r.id ?? ""),
        spec: isPlainObject(r.spec) ? r.spec : {},
        ...(Array.isArray(r.dependsOn) ? { dependsOn: r.dependsOn.filter((d): d is string => typeof d === "string") } : {}),
      });
    }
  }
  // ── acceptance ──
  const acceptance: SceneAcceptance = { description: "", expectResourceIds: [] };
  if (!isPlainObject(raw.acceptance)) {
    problems.push({ path: "acceptance", message: "acceptance 必须是对象(验收说明 + 要回读确认的资源 id)" });
  } else {
    if (typeof raw.acceptance.description !== "string" || raw.acceptance.description.trim().length === 0) {
      problems.push({ path: "acceptance.description", message: "验收说明不能为空" });
    } else {
      acceptance.description = raw.acceptance.description;
    }
    const expect = raw.acceptance.expectResourceIds;
    if (!Array.isArray(expect) || expect.some((e) => typeof e !== "string")) {
      problems.push({ path: "acceptance.expectResourceIds", message: "expectResourceIds 必须是字符串数组" });
    } else {
      for (const e of expect) {
        if (!resourceIds.has(e)) {
          problems.push({ path: "acceptance.expectResourceIds", message: `期望回读的资源 id 不在 resources 里:${e}` });
        }
      }
      acceptance.expectResourceIds = [...expect];
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    spec: {
      schemaVersion: SCENE_SPEC_SCHEMA_VERSION,
      sceneId: sceneId as string,
      goal: raw.goal as string,
      ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
      ...(typeof raw.preferredProviderId === "string" ? { preferredProviderId: raw.preferredProviderId } : {}),
      capabilities,
      resources,
      acceptance,
      ...(isPlainObject(raw.lock) ? { lock: raw.lock as Record<string, string> } : {}),
    },
  };
}

/**
 * 在资源依赖里找一个环(自环 / 简单环),返回环路径(如 `["a","b","a"]`);无环返回 null。
 * 深度优先 + 栈上标记 —— 只对**已存在的 id** 走边(引用不存在的 id 是另一类问题,前面报过了)。
 */
function findDependencyCycle(
  raws: readonly unknown[],
  ids: ReadonlySet<string>,
): string[] | null {
  const edges = new Map<string, string[]>();
  for (const r of raws) {
    if (!isPlainObject(r) || typeof r.id !== "string") continue;
    const deps = Array.isArray(r.dependsOn)
      ? r.dependsOn.filter((d): d is string => typeof d === "string" && ids.has(d))
      : [];
    edges.set(r.id, deps);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of edges.get(id) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // 环:从栈里 dep 第一次出现处截到栈顶 + dep。
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const id of edges.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found !== null) return found;
    }
  }
  return null;
}
