/**
 * `kind: "ref"` 的参数**候选从哪来** —— 这是渲染端唯一需要按来源分叉的地方。
 *
 * ## 为什么把 `useModelOptions` 收进来
 *
 * 原来只有一个 `kind: "model"`,候选是本机的模型列表,所以那个 hook 就叫这个名字。
 * 现在多了一种来源(技能),而**来源本身是契约里可扩展的那一维**
 * (`NODE_PARAM_REF_SOURCES`):再加"记忆"、"知识库"那类东西时,该改的是**这一个
 * switch**,而不是在检查器里再开一个 `spec.kind === "xxx"` 的分支。所以文件名和函数名
 * 都跟着那一维走,不跟着某一种来源走。
 *
 * ## 模型那一份为什么不做分组
 *
 * 和应用里的模型下拉同源,但**不做分组**:那边区分"哪个网关的哪个模型"靠的是
 * `customModelId + model` 这一对,而节点上的 `model` 只有一个字符串 —— 摆成一层
 * 候选、各自带自己的 label,是这个数据模型下唯一说得通的样子。
 *
 * ## 空数组是正常情况
 *
 * 一个模型都没配、一个技能都没装都会得到空数组。调用方据此把"没得选"说出来,而不是
 * 画一个空下拉 —— 空下拉比输入框更糟(它看着像有选项)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { MCP_ALWAYS_ON_SERVERS, type McpScope } from "@contracts/ipc";
import type { NodeParamRefSource } from "@contracts/nodeType";

export interface RefOption {
  id: string;
  label: string;
  /** 次要说明(技能的描述)。认不出就不显示。 */
  hint?: string;
}

/** 应用的模型列表 —— 与 `chat/ModelDropdown` 读的是同一组 store 字段。 */
function useModelOptions(): RefOption[] {
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const customModels = useSessionStore((s) => s.customModels);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);
  const codexAvailableModels = useSessionStore((s) => s.codexAvailableModels);

  return useMemo(() => {
    const out: RefOption[] = [];
    const seen = new Set<string>();
    const push = (id: string, label: string) => {
      const key = id.trim();
      if (key.length === 0 || seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, label: label.trim() || key });
    };

    // 内置别名(provider 声明的那几个)。
    const provider = providers.find((p) => p.id === providerId);
    for (const m of provider?.capabilities.builtinModels ?? []) push(m.id, m.label);
    // pi / codex 的动态列表:两边都是"供应商 + 模型"的扁平投影,与上面同形。
    for (const m of piAvailableModels) push(m.id, m.label);
    for (const m of codexAvailableModels) push(m.id, m.label);
    // 自定义端点里的模型。label 就用 id —— `ModelDropdown` 展开子菜单之后显示的
    // 也正是这两个字段里的 `entry.id`。
    for (const cfg of customModels) {
      for (const entry of cfg.models) push(entry.id, entry.id);
    }
    return out;
  }, [providerId, providers, customModels, piAvailableModels, codexAvailableModels]);
}

/**
 * 已安装的技能。**读的是 store 里那一份**(和输入框 `/` 菜单、发送时带上去的技能
 * 清单同源),不自己发一次 `skills.list` —— 两处各拉一次,用户刚装完技能时两边的
 * 新鲜度会不一样。
 *
 * 技能名不带斜杠(清单里存的就是名字),与 `NODE_SKILLS_PARAM_KEY` 那一头的约定一致。
 */
function useSkillOptions(): RefOption[] {
  const skills = useSessionStore((s) => s.skills);
  return useMemo(
    () =>
      skills.map((s) => ({
        id: s.name,
        label: s.name,
        ...(s.description ? { hint: s.description } : {}),
      })),
    [skills],
  );
}

/**
 * 这台机器上装了哪些**引擎**(提供方)。
 *
 * 读的是 store 里那一份(和引擎下拉同源,`provider.list` 的结果),不自己发一次 ——
 * 两处各拉一次,用户刚装完一个引擎时两边的就会不一样。
 *
 * `hint` 用显示名:节点上存的是 id(`claude-sdk`),而用户脑子里是"Claude"。
 */
function useProviderOptions(): RefOption[] {
  const providers = useSessionStore((s) => s.providers);
  return useMemo(
    () =>
      providers.map((p) => ({
        id: p.id,
        label: p.displayName || p.id,
        ...(p.id !== p.displayName ? { hint: p.id } : {}),
      })),
    [providers],
  );
}

/**
 * MCP 服务器 / 插件这两份候选 —— **store 里没有,要现拉**。
 *
 * ## 为什么不像上面那几个一样读 store
 *
 * 技能与引擎是全局的、而且别处也在用,所以 store 里本来就有一份(装完技能所有地方
 * 一起变)。MCP 的那份**跟着项目走**(同一个名字在不同项目下可以是不同的服务器),
 * 插件那份虽然全局、但只有这一个字段要它 —— 为它们各加一个 store 字段、再各写一处
 * 失效逻辑,换来的只是"点开检查器时少一次 IPC"。不值。
 *
 * ## 缓存:一次进程内只拉一次
 *
 * `useRefOptions` 会被**每个参数**各调一次(见下面对 hooks 无条件调用的说明),而一个
 * 节点检查器里有十来个参数。不缓存的话,点开一次就要发好几轮同样的请求。拉失败**不进
 * 缓存** —— 那种情况下次该重试(多半是 RPC 还没就绪),而不是一直显示"没得选"。
 */
const refOptionCache = new Map<string, RefOption[]>();
const EMPTY_REF_OPTIONS: RefOption[] = [];

/** MCP 那份的来源名 —— 面板上也是这么分的(用户配的 / 项目里的 / 插件带的)。 */
const MCP_SCOPE_LABEL: Record<McpScope, string> = {
  user: "用户配置",
  project: "本项目",
  plugin: "插件自带",
  builtin: "内置",
};

/**
 * 这次对话**已经能用**的 MCP 服务器。
 *
 * 三条过滤,各自都有理由:
 *  - **没启用的不列**:节点这个参数只能往下减,减不到用户关掉的东西 —— 否则选了也不
 *    生效,而界面上看不出区别(注入的那一头只认设置里开着的)。
 *  - **要授权的不列**:它现在没有工具可用(`needsAuth`),选了等于没选。
 *  - **骨干两个不列**(`MCP_ALWAYS_ON_SERVERS`):它们始终挂着,列出来会让人以为
 *    自己关得掉。
 */
function useMcpOptions(enabled: boolean): RefOption[] {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projectPath = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId)?.path ?? "")
    : "";
  const key = `mcp:${projectPath}`;
  const options = useCachedOptions(
    enabled,
    key,
    async () => {
      const { servers } = await api.mcp.list(projectPath ? { projectPath } : {});
      return servers
        .filter(
          (s) => s.enabled && !s.needsAuth && !(MCP_ALWAYS_ON_SERVERS as readonly string[]).includes(s.name),
        )
        .map((s) => ({ id: s.name, label: s.name, hint: `${MCP_SCOPE_LABEL[s.scope]} · ${s.detail}` }));
    },
  );
  return options;
}

/** 已启用的插件。`id` 是插件名(参数里存的就是它),`hint` 用插件自己的说明 ——
 *  名字多半是英文的,而说明是作者写的、能认出来是干什么的。 */
function usePluginOptions(enabled: boolean): RefOption[] {
  return useCachedOptions(enabled, "plugins", async () => {
    const { plugins } = await api.plugins.list();
    return (plugins ?? [])
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.name,
        label: p.name,
        ...(p.description ? { hint: p.description } : {}),
      }));
  });
}

/**
 * 拉一份候选,按 `key` 缓存。
 *
 * `enabled` 为假时**什么都不做** —— 它不是"这个字段没得选",而是"这一格压根没在用时
 * 别去打扰主进程"。调用方(下面的 switch)会把它接到的值丢掉。
 *
 * `load` 每次渲染都是新的闭包,所以它**不在依赖里**:真正决定"要不要重新拉"的是
 * `key`(项目换了才变)。
 */
function useCachedOptions(
  enabled: boolean,
  key: string,
  load: () => Promise<RefOption[]>,
): RefOption[] {
  const [options, setOptions] = useState<RefOption[]>(() => refOptionCache.get(key) ?? EMPTY_REF_OPTIONS);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) return;
    const cached = refOptionCache.get(key);
    if (cached) {
      setOptions(cached);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const next = await loadRef.current();
        if (!alive) return;
        refOptionCache.set(key, next);
        setOptions(next);
      } catch {
        // **必须吞掉**:手机端的 web shim 没有 mcp.list / plugins.list,而共用组件里
        // 抛出去的 promise 会让 React 19 把整棵树卸掉(手机端会白屏)。失败就维持
        // 空态 —— 那正是这个字段在"什么都还没装"时的样子,调用方已经处理了。
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, key]);
  return options;
}

/** 一个 `ref` 参数的候选。**加一种来源 = 在这里加一个 case。** */
export function useRefOptions(from: NodeParamRefSource): RefOption[] {
  // 五个 hook 都无条件调用 —— hooks 的规矩。多订阅几个 store 字段的代价可以忽略,
  // 而"按来源条件调用 hook"是错的(来源会随用户选中的节点变)。
  //
  // MCP 与插件那两份是**现拉的**,而且只在这一格真的用得上时才拉(`enabled`):一个
  // 节点检查器里有十来个参数,不筛的话每开一次就要发两轮用不上的 IPC。
  const models = useModelOptions();
  const skills = useSkillOptions();
  const providers = useProviderOptions();
  const mcp = useMcpOptions(from === "mcp");
  const plugins = usePluginOptions(from === "plugins");
  switch (from) {
    case "skills":
      return skills;
    case "providers":
      return providers;
    case "models":
      return models;
    case "mcp":
      return mcp;
    case "plugins":
      return plugins;
  }
}
