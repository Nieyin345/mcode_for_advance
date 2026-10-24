/**
 * `@renderer/lib/api.js` 的替身 —— 内存里一份工作流库,够 `WorkflowLibraryView` 走完
 * 「读列表 → 打开一份 → 点节点」。
 *
 * ## 为什么不是「什么都回成功」的空 Proxy
 *
 * 这套要验的是**点击之后右侧换了内容**。而右侧画什么取决于 `working`（= `workflow.get`
 * 回来的文档）与 `catalog`（由套件直接传）。如果 `workflow.get` 回一个不对形状的东西，
 * 组件会落到「打不开」那条错误分支 —— 那样即便点击没接上，断言也可能因为整页是错误
 * 文案而「看起来没渲染成节点参数」。所以这里回**真的** `WorkflowDoc` 形状，并让
 * `workflow.list` / `workflow.get` 的返回值与生产契约一致。
 *
 * ## 其余命名空间为什么可以空 Proxy
 *
 * 未列出的 `api.<ns>.<method>()` 一律回 `Promise.resolve({ok:true})`。本页在拿到
 * catalog（套件传入的 prop）之后只会再读 `project.list`（仅新建自动化时）与
 * `workflow.agentProfiles`；两个都不影响「点节点」这条路径。
 */
type Doc = Record<string, unknown>;

const DOC: Doc = {
  id: "wf_demo",
  name: "我的流程",
  engine: "node-red",
  prompt: "",
  builtin: false,
  updatedAt: 1234,
  nodes: [
    // **刻意用两个参数形状完全不同的类型**：切节点时表单应当整块换掉，
    // 「不是叠加」这条判据才有东西可看（见 main.tsx 的 B/C 节点）。
    {
      id: "A",
      type: "mcode.main",
      title: "主代理",
      params: { instruction: "先做 A，再做 B。" },
      position: { x: 0, y: 0 },
    },
    {
      id: "B",
      type: "mcode.agent",
      title: "检索文献",
      params: { instruction: "去检索 B 主题的文献。" },
      position: { x: 0, y: 120 },
    },
    {
      id: "C",
      type: "mcode.command",
      title: "跑脚本",
      params: { command: "echo C" },
      position: { x: 0, y: 240 },
    },
  ],
  edges: [
    { id: "e_A_B", from: "A", to: "B" },
    { id: "e_B_C", from: "B", to: "C" },
  ],
};

function listEntry(d: Doc): Doc {
  return {
    id: d.id,
    name: d.name,
    builtin: d.builtin,
    edited: false,
    kind: "graph",
    updatedAt: d.updatedAt,
    ...(d.trigger ? { trigger: d.trigger } : {}),
  };
}

export const calls: Array<{ method: string; input: unknown }> = [];
export function callsOf(method: string): unknown[] {
  return calls.filter((c) => c.method === method).map((c) => c.input);
}

function respond(method: string, args: unknown[]): Promise<unknown> {
  calls.push({ method, input: args[0] });
  switch (method) {
    case "workflow.list":
      return Promise.resolve({ workflows: [listEntry(DOC)] });
    case "workflow.get":
      // `review: null` 是正常态（没有待启用的外来版本），不是省略 —— 组件读
      // `res.review.pending` 前会先判空（见 WorkflowLibraryView 的 openWorkflow）。
      return Promise.resolve({ workflow: DOC, review: null });
    case "workflow.save":
      return Promise.resolve({ ok: true, warnings: [] });
    case "workflow.agentProfiles":
      return Promise.resolve({ profiles: [], problems: [] });
    case "project.list":
      return Promise.resolve({ projects: [] });
    default:
      return Promise.resolve({ ok: true });
  }
}

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => respond(`${ns}.${prop}`, args);
      },
    },
  );
}

const namespaces = new Map<string, unknown>();
export const api = new Proxy(
  {},
  {
    get(_t, prop: string) {
      if (typeof prop !== "string") return undefined;
      // `on` 是推送订阅面（`window.api?.on?.workflowsChanged?.(...)`）。回一个
      // 能调用的函数并返回取消函数，绝不能让组件在模块求值时炸掉。
      if (prop === "on") {
        return new Proxy(
          {},
          {
            get() {
              return () => () => {};
            },
          },
        );
      }
      if (!namespaces.has(prop)) namespaces.set(prop, makeNs(prop));
      return namespaces.get(prop);
    },
  },
);
