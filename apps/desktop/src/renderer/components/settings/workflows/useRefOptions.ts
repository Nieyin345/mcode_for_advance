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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore, type SessionState } from "@renderer/stores/sessionStore.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { api } from "@renderer/lib/api.js";
import { filterSkillsForEngine } from "@renderer/lib/engineFilter.js";
import { MCP_ALWAYS_ON_SERVERS, type McpScope } from "@contracts/ipc";
import type { NodeParamRefSource } from "@contracts/nodeType";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

export interface RefOption {
  id: string;
  label: string;
  /** 次要说明(技能的描述)。认不出就不显示。 */
  hint?: string;
}

export interface RefOptionsResult {
  options: RefOption[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

const NO_RETRY = (): void => {};
const readyOptions = (options: RefOption[]): RefOptionsResult => ({
  options, loading: false, failed: false, retry: NO_RETRY,
});

/**
 * 应用的模型列表 —— **按当前引擎那一份**。
 *
 * 从前这里把四个来源拍平成一个下拉,于是「引擎」和「模型」看着互为副本(用户原话:
 * 「子代理的模型和引擎重合了」)。现在分引擎取,见 {@link modelsForProvider}。
 */
function useModelOptions(providerId: string | undefined): RefOption[] {
  const providers = useSessionStore((s) => s.providers);
  const customModels = useSessionStore((s) => s.customModels);
  const customModelId = useSessionStore((s) => s.customModelId);
  const currentProviderId = useSessionStore((s) => s.providerId);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);
  const codexAvailableModels = useSessionStore((s) => s.codexAvailableModels);

  return useMemo(
    () =>
      modelsForProvider(
        { providerId: currentProviderId, providers, customModels, customModelId, piAvailableModels, codexAvailableModels },
        providerId,
      ),
    [providerId, currentProviderId, providers, customModels, customModelId, piAvailableModels, codexAvailableModels],
  );
}

/**
 * 某个**引擎**下可挑的模型 —— 「模型」那一格的候选。
 *
 * ## 为什么必须按引擎分
 *
 * 这四份列表在 store 里本来就是分家的:`builtinModels` 挂在当前引擎身上、
 * `piAvailableModels` 是 pi 的、`codexAvailableModels` 是 codex 的、自建端点各一份
 * (`customModels[].models`)。从前这里把它们**拍平成一个列表**,于是「引擎」选了
 * Codex、下面「模型」里却还列着 Claude 的别名 —— 两个下拉看着互为副本,选下去的那个
 * id 也不是这个引擎认得的,只有跑的时候才失败。
 *
 * 分工照着 `ModelDropdown` 与 `resolveSendModel` 已有的那套判据(`sessionStore.ts`):
 * pi 只认 `piAvailableModels`、codex 只认 `codexAvailableModels`、其余引擎用自己声明的
 * `builtinModels` 加自建端点。
 *
 * ## `undefined` = 跟着主对话走
 *
 * 引擎那一格留空时,这一步用的就是主对话当前的引擎 —— 所以列的是**当前引擎**的那一份。
 * `""`(空串)是同一个意思:参数是自由数据,清空之后可能落成空串。
 */
export function modelsForProvider(
  s: Pick<SessionState, "providerId" | "providers" | "customModels" | "customModelId" | "piAvailableModels" | "codexAvailableModels">,
  providerId: string | undefined,
): RefOption[] {
  const wanted = providerId !== undefined && providerId.trim().length > 0 ? providerId : s.providerId;
  const provider = s.providers.find((p) => p.id === wanted);

  const out: RefOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string) => {
    const key = id.trim();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, label: label.trim() || key });
  };

  if (provider?.id === "pi-sdk") {
    for (const m of s.piAvailableModels) push(m.id, m.label);
    return out;
  }
  if (provider?.id === "codex-sdk") {
    for (const m of s.codexAvailableModels) push(m.id, m.label);
    return out;
  }
  // A workflow node stores only `model`, not the `(customModelId, model)` pair
  // used by normal chats. It can therefore safely offer custom-endpoint models
  // only when it inherits the current conversation's active endpoint. Listing
  // every endpoint here made a selection look valid while the node retained a
  // different (or null) customModelId at runtime.
  if (wanted === s.providerId && s.customModelId) {
    const active = s.customModels.find((cfg) => cfg.id === s.customModelId);
    for (const entry of active?.models ?? []) push(entry.id, entry.id);
    return out;
  }
  // No inherited custom endpoint: only models native to this provider are
  // representable by the node's single string field.
  for (const m of provider?.capabilities.builtinModels ?? []) push(m.id, m.label);
  return out;
}

/**
 * 已安装的技能。**读的是 store 里那一份**(和输入框 `/` 菜单、发送时带上去的技能
 * 清单同源),不自己发一次 `skills.list` —— 两处各拉一次,用户刚装完技能时两边的
 * 新鲜度会不一样。
 *
 * 技能名不带斜杠(清单里存的就是名字),与 `NODE_SKILLS_PARAM_KEY` 那一头的约定一致。
 *
 * **按节点选中的引擎过滤**:留空才跟当前会话走。否则在 Claude 对话里编辑一个
 * Codex/Pi 节点时会列出错误技能,配置能保存、真正运行却加载不到。
 */
function useSkillOptions(providerId: string | undefined): RefOption[] {
  const skills = useSessionStore((s) => s.skills);
  const currentProviderId = useSessionStore((s) => s.providerId);
  const wanted = providerId !== undefined && providerId.trim().length > 0
    ? providerId : currentProviderId;
  return useMemo(
    () =>
      filterSkillsForEngine(skills, wanted).map((s) => ({
        id: s.name,
        label: s.name,
        ...(s.description ? { hint: s.description } : {}),
      })),
    [skills, wanted],
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
 * 左栏那张**项目**表。触发器节点的「在哪个项目里跑」用它(见 `@contracts/nodeType` 的
 * `projects` 那一段)。
 *
 * 读 store 里那一份(和左栏同源),不自己发一次 `project.list` —— 理由同技能 / 引擎:
 * 两处各拉一次,用户刚建完一个项目时两边的就会不一样。
 *
 * `hint` 给路径。节点上存的是**项目 id**,而用户挑的时候看的是项目名 —— 让路径一起
 * 显示出来,"这个名字对应哪个目录"就不用去左栏核对了。
 */
function useProjectOptions(): RefOption[] {
  const projects = useSessionStore((s) => s.projects);
  return useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        label: p.name.trim() || p.id,
        hint: p.path,
      })),
    [projects],
  );
}

/**
 * **当前文档系统的分类表** —— `library_collections`(见 `@contracts/nodeType` 的
 * `collections` 那一段)。
 *
 * 第一个消费者是**固定条件**(`NODE_CRITERIA_PARAM_KEY` 的 `source`):检索工作流要一个
 * "这次下到哪个分类"的下拉,而候选只能是用户自己建的那些分类 —— 写清单的人不可能知道。
 *
 * 读 store 里那一份(和左栏同源),理由同项目那一档:两处各拉一次,用户刚建完一个分类时
 * 两边就会不一样。⚠️ 所以**store 还没加载过时这里就是空的** —— 调用方要能接受"暂时没得选"
 * (那是真实状态,不是错误)。分类树是平的渲染(不带缩进):下拉里只摆 id→名字,
 * 层级靠 `hint` 里的上级路径说明。
 */
function useCollectionOptions(): RefOption[] {
  const collections = useLibraryStore((s) => s.collections);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  // 拉过就够 —— `loaded` 是那个 store 自己的标记,避免每次开检查器都发一轮 IPC。
  const loaded = useLibraryStore((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void loadCollections();
  }, [loaded, loadCollections]);
  return useMemo(() => {
    return collections.map((c) => {
      // 上级路径:从它往上走到根,`/` 连起来。上层不在表里(数据不一致)就到此为止。
      const trail: string[] = [];
      let cur = c.parentId ?? null;
      for (let depth = 0; cur !== null && depth < 20; depth += 1) {
        const parent = collections.find((x) => x.id === cur);
        if (!parent) break;
        trail.unshift(parent.name.trim() || parent.id);
        cur = parent.parentId ?? null;
      }
      return {
        id: c.id,
        label: c.name.trim() || c.id,
        ...(trail.length > 0 ? { hint: trail.join(" / ") } : {}),
      };
    });
  }, [collections]);
}

/**
 * MCP 服务器 / 插件这两份候选 —— **store 里没有,要现拉**。
 *
 * ## 为什么不像上面那几个一样读 store
 *
 * 技能与引擎是全局的、而且别处也在用,所以 store 里本来就有一份(装完技能所有地方
 * 一起变)。MCP 的清单只有工作流检查器这一个消费点,插件那份虽然全局、但只有这一个
 * 字段要它 —— 为它们各加一个 store 字段、再各写一处失效逻辑,换来的只是"点开检查器
 * 时少一次 IPC"。不值。
 *
 * ## 每次控件挂载重新读取
 *
 * `enabled` 保证只有真正的 MCP/插件字段会请求，所以一次检查器各最多一轮。这里不能
 * 做进程级永久缓存：用户在设置页启停插件或 MCP 后再回来，旧候选必须立即消失。
 */
const EMPTY_REF_OPTIONS: RefOption[] = [];

/** MCP 那份的来源名 —— 面板上也是这么分的(用户配的 / 内置 / 插件带的)。
 *
 *  值在**装载时**就 `t()` 成字,所以请求 key 必须带上语言(见
 *  `useMcpOptions`)—— 用户切换语言时据此重新装载。 */
const MCP_SCOPE_LABEL: Record<McpScope, MessageId> = {
  user: "settings.workflows.paramRefScopeUser",
  builtin: "settings.workflows.paramRefScopeBuiltin",
  plugin: "settings.workflows.paramRefScopePlugin",
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
function useMcpOptions(enabled: boolean, providerId: string | undefined): RefOptionsResult {
  const { t, locale } = useI18n();
  const providers = useSessionStore((s) => s.providers);
  const currentProviderId = useSessionStore((s) => s.providerId);
  const wanted = providerId !== undefined && providerId.trim().length > 0
    ? providerId : currentProviderId;
  const supportsMcp = providers.find((p) => p.id === wanted)?.capabilities.supportsMcp !== false;
  const engine = wanted === "claude-sdk" ? "claude" : wanted === "codex-sdk" ? "codex" : undefined;
  // key 带上语言:这一份的 hint 里含翻译过的来源名,切换语言必须重新装载。
  const options = useLoadedOptions(
    enabled && supportsMcp,
    `mcp:${wanted}:${locale}`,
    async () => {
      const { servers } = await api.mcp.list({});
      return servers
        .filter(
          (s) =>
            s.enabled && !s.needsAuth &&
            !(MCP_ALWAYS_ON_SERVERS as readonly string[]).includes(s.name) &&
            (engine === undefined || s.perEngine?.[engine] !== false),
        )
        .map((s) => ({
          id: s.name,
          label: s.name,
          hint: `${t(MCP_SCOPE_LABEL[s.scope])} · ${s.detail}`,
        }));
    },
  );
  return supportsMcp ? options : readyOptions(EMPTY_REF_OPTIONS);
}

/** 已启用的插件。`id` 是插件名(参数里存的就是它),`hint` 用插件自己的说明 ——
 *  名字多半是英文的,而说明是作者写的、能认出来是干什么的。 */
function usePluginOptions(enabled: boolean, providerId: string | undefined): RefOptionsResult {
  const currentProviderId = useSessionStore((s) => s.providerId);
  const wanted = providerId !== undefined && providerId.trim().length > 0
    ? providerId : currentProviderId;
  return useLoadedOptions(enabled, `plugins:${wanted}`, async () => {
    const { plugins } = await api.plugins.list();
    return (plugins ?? [])
      .filter((p) => {
        if (!p.enabled) return false;
        // deliveredProviderIds = what the plugin can feed ∩ the engines the user
        // left on in the plugin panel; older hosts only send compatibleProviderIds.
        if (p.deliveredProviderIds) return p.deliveredProviderIds.includes(wanted);
        return p.compatibleProviderIds === undefined || p.compatibleProviderIds.includes(wanted);
      })
      .map((p) => ({
        id: p.name,
        label: p.name,
        ...(p.description ? { hint: p.description } : {}),
      }));
  });
}

/**
 * 拉一份候选。`key` 改变（例如节点切换 Provider）时重新拉。
 *
 * `enabled` 为假时**什么都不做** —— 它不是"这个字段没得选",而是"这一格压根没在用时
 * 别去打扰主进程"。调用方(下面的 switch)会把它接到的值丢掉。
 *
 * `load` 每次渲染都是新的闭包,所以它**不在依赖里**；`loadRef` 始终持有最新闭包。
 */
function useLoadedOptions(
  enabled: boolean,
  key: string,
  load: () => Promise<RefOption[]>,
): RefOptionsResult {
  const [options, setOptions] = useState<RefOption[]>(EMPTY_REF_OPTIONS);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    setOptions(EMPTY_REF_OPTIONS);
    setLoadedKey(key);
    setLoading(true);
    setFailed(false);
    let alive = true;
    void (async () => {
      try {
        const next = await loadRef.current();
        if (!alive) return;
        setOptions(next);
      } catch {
        // Mobile shims may not implement inventory RPCs. Keep the tree alive,
        // but expose a retryable error instead of pretending the list is empty.
        if (alive) setFailed(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, key, attempt]);
  if (!enabled) return readyOptions(EMPTY_REF_OPTIONS);
  const stale = loadedKey !== key;
  return {
    options: stale ? EMPTY_REF_OPTIONS : options,
    loading: stale || loading,
    failed: !stale && failed,
    retry,
  };
}

/** 一个 `ref` 参数的候选。**加一种来源 = 在这里加一个 case。**
 *
 *  `providerId` 是**级联用**的:模型、技能和 MCP 都可写 `fromParam: "provider"`,控件
 *  把用户在那个参数上选的值传进来,于是候选只列这个引擎能用的项目。没写
 *  `fromParam` 的来源不看它。 */
export function useRefOptions(from: NodeParamRefSource, providerId?: string): RefOptionsResult {
  // 五个 hook 都无条件调用 —— hooks 的规矩。多订阅几个 store 字段的代价可以忽略,
  // 而"按来源条件调用 hook"是错的(来源会随用户选中的节点变)。
  //
  // MCP 与插件那两份是**现拉的**,而且只在这一格真的用得上时才拉(`enabled`):一个
  // 节点检查器里有十来个参数,不筛的话每开一次就要发两轮用不上的 IPC。
  const models = useModelOptions(providerId);
  const skills = useSkillOptions(providerId);
  const providers = useProviderOptions();
  const projects = useProjectOptions();
  const collections = useCollectionOptions();
  const mcp = useMcpOptions(from === "mcp", providerId);
  const plugins = usePluginOptions(from === "plugins", providerId);
  switch (from) {
    case "skills":
      return readyOptions(skills);
    case "providers":
      return readyOptions(providers);
    case "projects":
      return readyOptions(projects);
    case "collections":
      return readyOptions(collections);
    case "models":
      return readyOptions(models);
    case "mcp":
      return mcp;
    case "plugins":
      return plugins;
  }
}
