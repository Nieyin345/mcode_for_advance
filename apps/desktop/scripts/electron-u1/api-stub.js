// T16 —— journey-1 的页面级 API 桩（与 arc005-visual-baseline 的 api-stub.js 同形状，
// 但独立一份：本套件独占自己的目录，不改那份已验收的文件）。
//
// 必须在 App bundle **之前**加载：`renderer/lib/api.ts` 在模块求值那一刻读
// `window.api ?? createWebApi()`。这里是 `window.labApi`（bundle 里 api.ts 被换成
// `export const api=window.labApi`）。
//
// 夹具是**虚构数据**：两个项目、各一个会话、各一条消息。真 App + 真 store 渲染；
// 会话选择、标签切换、ChatPane 渲染全走生产代码，只有 IPC 数据源是桩。
(function () {
  var noopSub = function () { return function () {}; };
  var now = 1700000000000;
  var projects = [
    { id: "p1", name: "U1 项目 A", path: "C:\\\\u1-fixture-a", archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now },
    { id: "p2", name: "U1 项目 B", path: "C:\\\\u1-fixture-b", archived: false, pinnedAt: null, sortOrder: 1, createdAt: now, updatedAt: now },
  ];
  function session(id, projectId, title) {
    return {
      id: id, projectId: projectId, providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
      status: "idle", title: title, model: "default", effort: "default", permissionMode: "default",
      workflowId: "default", customModelId: null, archived: false, pinnedAt: null,
      createdAt: now, updatedAt: now,
    };
  }
  var sessionsByProject = {
    p1: [session("s-a", "p1", "U1-A 会话")],
    p2: [session("s-b", "p2", "U1-B 会话")],
  };
  var messagesBySession = {
    "s-a": [{ id: "m-a", sessionId: "s-a", role: "assistant", content: [{ kind: "text", text: "这是项目 A 的消息正文" }], createdAt: now }],
    "s-b": [{ id: "m-b", sessionId: "s-b", role: "assistant", content: [{ kind: "text", text: "这是项目 B 的消息正文" }], createdAt: now }],
  };
  function makeNs() {
    return new Proxy(function () {}, {
      get: function (_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "on") return noopSub;
        if (typeof prop !== "string") return undefined;
        return function () { return Promise.resolve({}); };
      },
    });
  }
  var fixed = {
    setting: {
      get: function () { return Promise.resolve({ value: null }); },
      getMany: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve({ ok: true }); },
    },
    project: {
      list: function () { return Promise.resolve({ projects: projects }); },
      sessions: function (input) {
        var list = sessionsByProject[input && input.projectId] || [];
        if (input && input.archived) return Promise.resolve({ sessions: [], hasMore: false, total: 0 });
        if (input && input.worktree === "only") return Promise.resolve({ sessions: [], hasMore: false, total: 0 });
        return Promise.resolve({ sessions: list, hasMore: false, total: list.length });
      },
    },
    session: {
      listPinned: function () { return Promise.resolve({ sessions: [] }); },
      list: function () { return Promise.resolve({ sessions: [] }); },
      listAll: function () { return Promise.resolve({ sessions: [], total: 0, hasMore: false }); },
      messages: function (input) {
        var list = messagesBySession[input && input.sessionId] || [];
        return Promise.resolve({ messages: list, hasMore: false });
      },
    },
    provider: { list: function () { return Promise.resolve({ providers: [] }); }, health: function () { return Promise.resolve({ status: "unavailable" }); } },
    piModels: { listAvailable: function () { return Promise.resolve({ models: [] }); } },
    codexModels: { list: function () { return Promise.resolve({ providers: [] }); } },
    runtimes: { list: function () { return Promise.resolve({ runtimes: [] }); } },
    lsp: {
      list: function () { return Promise.resolve({ languages: [] }); },
      prewarm: function () { return Promise.resolve({ ok: true }); },
    },
    skills: { list: function () { return Promise.resolve({ skills: [] }); } },
    // ChatPane 的 MemoryAssistantButton 直接把 jobs/injections 当数组用。
    memory: {
      assistant: function () { return Promise.resolve({ jobs: [], injections: [] }); },
    },
    claude: { listSideChats: function () { return Promise.resolve({ sessions: [] }); } },
    customModel: { list: function () { return Promise.resolve({ models: [] }); } },
    outputStyle: { list: function () { return Promise.resolve({ styles: [] }); } },
    workflow: { list: function () { return Promise.resolve({ workflows: [] }); }, agentProfiles: function () { return Promise.resolve({ profiles: [], problems: [] }); } },
    automation: { statusAll: function () { return Promise.resolve({ statuses: {} }); } },
    library: { groupsGet: function () { return Promise.resolve({ groups: [] }); } },
    modules: { catalog: function () { return Promise.resolve({ modules: [] }); } },
    theme: {
      get: function () { return Promise.resolve({ theme: "light", effective: "light" }); },
      set: function () { return Promise.resolve({ theme: "light", effective: "light" }); },
    },
    file: new Proxy({ listDir: function () { return Promise.resolve({ entries: [] }); } }, {
      get: function (target, key) { return target[key] || function () { return Promise.resolve({}); }; },
    }),
    git: new Proxy({ worktreeList: function () { return Promise.resolve({ worktrees: [] }); } }, {
      get: function (target, key) { return target[key] || function () { return Promise.resolve({}); }; },
    }),
  };
  window.labApi = new Proxy({}, {
    get: function (_t, ns) {
      if (ns === "then") return undefined;
      if (typeof ns !== "string") return undefined;
      if (ns === "on") return new Proxy({}, { get: function () { return noopSub; } });
      if (Object.prototype.hasOwnProperty.call(fixed, ns)) return fixed[ns];
      return makeNs();
    },
  });
  // Preload 标记：renderer/lib/platform.ts 用它选桌面壳（而不是手机壳）。
  window.mcodeElectron = true;
})();
