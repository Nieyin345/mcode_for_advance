/**
 * **工具选择 → 各 SDK 形态的共享适配**(MC-100 / MC-101 执行层)。
 *
 * 台账两轮复核点名的缺口是同一句:发现层(EffectiveToolInventory)与选择层(ToolProfile)
 * 都通过了,**但三引擎运行时的 `src` 里没有一处 `selectToolsForProfile` 调用** —— 模型可见的
 * 工具集从未随任务真正裁剪。这份模块就是那道**唯一的接线**:它把「清单 + 画像 → 工具名子集」
 * 这一步收在一处(硬规矩 2:共享实现只有一份),再给每个引擎一个**纯的、可测的**薄适配,
 * 把名字子集翻成该 SDK 要的形状(Pi `tools` 白名单 / Codex `dynamicTools` 过滤 /
 * Claude `Options.tools` 与 `options.mcpServers` 收窄)。
 *
 * ## 边界(别越)
 *
 * - `resolveEngineToolSelection` 只做**计算**(复用各生产者现成的工具表 + 契约里那份纯选择),
 *   不注册工具、不起 SDK、不碰磁盘。
 * - 那几个 `*ForProfile` 是**纯函数**:给定「全部」与「选中的名字」,回该 SDK 形态的**收窄后**
 *   产物。它们是薄适配,不是第二套选择逻辑 —— 选择那条事实只有 `selectToolsForProfile` 一份。
 * - 三个 provider 各自**只**调这里:不在 provider 里另写按画像筛选的循环。
 *
 * ## 默认 = 显式的全量画像,不是「省略参数」
 *
 * 生产默认画像名是 {@link DEFAULT_TOOL_PROFILE_NAME}(`full`)。取 `full` 时各适配器回**全量**
 * 产物(Pi `tools=undefined` 即 SDK 的「启用全部」、Codex 原样 dynamicTools、Claude 不设
 * `Options.tools` 且保留全部 server)—— 与改动前行为一致。**但这条路现在是被画像选择显式走到的**
 * (见 `selectToolsForProfile` 的 `full` 分支),而不是某个 provider 忘了传参的副作用。
 */
import type { EngineToolEngineId } from "@contracts/ipc/engineTools";
import {
  ESSENTIAL_TOOL_NAMES,
  FULL_PROFILE_NAME,
  selectToolsForProfile,
  type ToolBudget,
  type ToolProfile,
  type ToolProfileName,
} from "@contracts/toolProfile";
import type { EffectiveToolInventory } from "@contracts/effectiveToolInventory";

import { buildEngineToolInventory } from "./effectiveToolInventory.js";

/** 无显式画像时的默认画像名。`full` = 现有全量行为,经**显式**画像分支走到,不是省略。 */
export const DEFAULT_TOOL_PROFILE_NAME: ToolProfileName = FULL_PROFILE_NAME;

/** 解析一次选择的结果:清单 + 解析后的画像名 + 选中(应暴露)的工具名(升序去重)。 */
export interface EngineToolSelection {
  engine: EngineToolEngineId;
  profileName: ToolProfileName;
  inventory: EffectiveToolInventory;
  /** 该画像应暴露的**原始形态**工具名(与清单里的名字同形 —— Claude 带 `mcp__<server>__` 前缀)。 */
  selected: string[];
}

/**
 * **工具预算**(MC-100 点名的「工具预算」那一格)。见 `@contracts/toolProfile` 的 {@link ToolBudget}。
 * 类型别名保留在此,便于本模块内部窄读。
 */
export type EngineToolBudget = ToolBudget;

/**
 * 把画像选中的集合再按预算收一刀。**floor 恒留**,其余按名字升序补入直到触顶。
 * 纯函数(收名字集合 + 清单,回名字集合)。
 */
export function applyToolBudget(
  selection: EngineToolSelection,
  budget: ToolBudget | undefined,
): string[] {
  if (!budget || (budget.maxTools === undefined && budget.maxTokens === undefined)) {
    return selection.selected;
  }
  const tokenByName = new Map(selection.inventory.tools.map((t) => [t.name, t.estimatedTokens]));
  const floor = new Set(ESSENTIAL_TOOL_NAMES);
  // floor 恒留(用原始形态名匹配:Claude 侧是 mcp__<server>__app_api_call)。
  const bare = (n: string): string => n.replace(/^mcp__[a-z0-9-]+__/i, "");
  const kept: string[] = [];
  let tokens = 0;
  const fits = (name: string): boolean => {
    if (budget.maxTools !== undefined && kept.length >= budget.maxTools) return false;
    const next = tokens + (tokenByName.get(name) ?? 0);
    if (budget.maxTokens !== undefined && next > budget.maxTokens) return false;
    return true;
  };
  // 1) floor 先无条件放行(可略微超预算 —— 发现通道优先于预算)。
  const floorNames = selection.selected.filter((n) => floor.has(bare(n)));
  for (const name of floorNames) {
    kept.push(name);
    tokens += tokenByName.get(name) ?? 0;
  }
  // 2) 其余按升序补入,触顶即停。
  for (const name of selection.selected) {
    if (floor.has(bare(name))) continue;
    if (!fits(name)) break;
    kept.push(name);
    tokens += tokenByName.get(name) ?? 0;
  }
  return [...kept].sort();
}


/**
 * **唯一的「清单 + 画像 → 选中集合」入口**。三引擎 provider 与诊断都走这里。
 *
 * `profile` 缺席 → {@link DEFAULT_TOOL_PROFILE_NAME}(`full`,全量)。
 */
export function resolveEngineToolSelection(
  engine: EngineToolEngineId,
  opts: {
    profile?: ToolProfile;
    /** 画像选择之后的**工具预算**(数量 / 粗估 token);floor 恒不裁。 */
    budget?: ToolBudget;
    browserEnabled: boolean;
    excluded?: readonly string[];
    /** Claude:宿主枚举不到的 MCP server 名(工具表在 SDK 侧)。仅用于诊断 notes。 */
    unenumerableServerNames?: readonly string[];
    /** Codex:恢复遗留的旧工具(诊断可见)。 */
    resumedLegacyTools?: Parameters<typeof buildEngineToolInventory>[1]["resumedLegacyTools"];
  },
): EngineToolSelection {
  const profileName: ToolProfileName = opts.profile?.name ?? DEFAULT_TOOL_PROFILE_NAME;
  const inventory = buildEngineToolInventory(engine, {
    browserEnabled: opts.browserEnabled,
    excluded: opts.excluded,
    unenumerableServerNames: opts.unenumerableServerNames,
    resumedLegacyTools: opts.resumedLegacyTools,
  });
  const unbudgeted = selectToolsForProfile(inventory, {
    name: profileName,
    userOverride: opts.profile?.userOverride,
  });
  const selection: EngineToolSelection = { engine, profileName, inventory, selected: unbudgeted };
  // 预算在画像之后、装配之前收一刀(floor 恒留)。
  selection.selected = applyToolBudget(selection, opts.budget);
  return selection;
}

/**
 * **Pi 适配**:把选中集合翻成 `createAgentSession` 的 `tools` 白名单。
 *
 * - `full` → `undefined`:这是 Pi SDK **自己的**「启用全部内置 + 扩展」语义(见
 *   `CreateAgentSessionOptions.tools` 的文档)。刻意回 `undefined` 而非一张手抄的长名单 ——
 *   手抄一张「全部」名单一旦与 SDK 新增工具漂移,就静默少给工具。**是显式画像决定走这条路**。
 * - 其余画像 → 选中名字原样作白名单(Pi 的 `tools` 同时管内置与扩展注册的工具,
 *   名字与清单里的裸名同形)。
 */
export function piToolsAllowlist(selection: EngineToolSelection): string[] | undefined {
  return selection.profileName === FULL_PROFILE_NAME ? undefined : selection.selected;
}

/**
 * **Codex 适配**:按选中集合过滤 `dynamicTools`。
 *
 * - `full` → 原样返回(全量,与改动前一致)。
 * - 其余画像 → 只留名字在选中集合里的项。`dynamicTools` 的每项都带 `name` 字段
 *   (见 `buildDynamicTools`),按它过滤。
 */
export function codexDynamicToolsForProfile<T extends { name?: unknown }>(
  tools: readonly T[],
  selection: EngineToolSelection,
): T[] {
  if (selection.profileName === FULL_PROFILE_NAME) return [...tools];
  const keep = new Set(selection.selected);
  return tools.filter((t) => typeof t.name === "string" && keep.has(t.name));
}

/**
 * **Claude 适配**:把选中集合翻成 `options` 上那两处**真实赋值**的片段。
 *
 * - `full` → `{ tools: undefined, mcpServers: allServers }`:不设 `Options.tools`(保留 SDK 的
 *   `claude_code` 预设,含静态清单之外的 Skill / 计划模式等内置),MCP server 原样全留。
 *   这是**显式**画像决定 —— 不是「忘了设」。
 * - 其余画像 → `tools` 收窄到「选中里落在 `allBuiltin` 内的名字」**并集** {@link CLAUDE_HARNESS_BUILTINS};
 *   `mcpServers` 收窄到「至少有一个工具被选中的 server」(进程内 MCP server 不能只挂一半工具)。
 *   `mcode-app` 的 `app_api_*` 是 floor,任何画像都选中,故 app server 恒留 —— 发现通道不丢。
 *
 * 返回的 `tools` / `mcpServers` **就是** provider 赋进 `options` 的值(provider 只做
 * `options.tools = r.tools` 与按 `r.mcpServers` 过滤),所以冒烟断言的就是真正发往 SDK 的集合。
 */
export function claudeToolSelectionOptions(
  selection: EngineToolSelection,
  opts: { allBuiltin: readonly string[]; allServers: readonly string[] },
): { tools: string[] | undefined; mcpServers: string[] } {
  if (selection.profileName === FULL_PROFILE_NAME) {
    return { tools: undefined, mcpServers: [...opts.allServers] };
  }
  const builtin = new Set(opts.allBuiltin);
  const kept = new Set<string>();
  for (const name of selection.selected) if (builtin.has(name)) kept.add(name);
  // 计划模式 / 提问 / 技能这几件是**harness 平面**,不在静态内置清单里,但画像切换**绝不能**
  // 把它们藏掉 —— 否则审批流程要用发现通道、计划模式要进出计划模式的工具就都断了(见
  // `@contracts/toolProfile` 文件头那条安全约束)。显式并集,不用「省略」兜底。
  for (const name of CLAUDE_HARNESS_BUILTINS) kept.add(name);
  const tools = [...kept].sort();
  const prefix = /^mcp__([a-z0-9-]+)__/i;
  const keep = new Set<string>();
  for (const name of selection.selected) {
    const m = prefix.exec(name);
    if (m) keep.add(m[1]);
  }
  const mcpServers = opts.allServers.filter((s) => keep.has(s));
  return { tools, mcpServers };
}

/**
 * **Claude harness 平面内置工具**:计划模式生命周期、提问、以及技能加载所需的工具。它们不在
 * {@link cn.KNOWN_BUILTIN_TOOLS} 的静态常见清单里(那是「用户看得见、能禁用的文件/终端类」),
 * 但任何**收窄**画像都要保留 —— 否则切到 `research` 后模型连进出计划模式、向用户提问的工具都没有。
 * 这是**安全并集**,只增不减,与 floor 同性质。
 */
export const CLAUDE_HARNESS_BUILTINS: readonly string[] = [
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "Skill",
  "TodoWrite",
];
