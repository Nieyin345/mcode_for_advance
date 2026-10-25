// 【MC-046 U1】页面级 API 桩 —— 必须在 bundle.js **之前**加载。
//
// 与 settings-layout-smoke 的 `apiStub` 同一形状（`lib/api.ts` 在模块求值那一刻
// 读 `window.api ?? createWebApi()`）。本套件只关心设置层焦点，不驱动任何业务；
// `setting.get` 返回空值让真实设置页用默认值渲染即可。
(function () {
  var noopSub = function () { return function () {}; };
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
      get: function (input) {
        // MC-046 嵌套弹窗夹具：给设置页一份带一条自定义项的配置，
        // 让 CustomUiPanel 真的渲染出「删除」按钮（触发 ConfirmDialog）。
        if (input && input.key === "customUi.config.v1") {
          return Promise.resolve({ value: JSON.stringify({
            version: 1,
            items: [{ id: "sfe-probe", slot: "library.item", label: { zh: "焦点探针项" }, action: { type: "copy", template: "x" } }],
            layout: {},
          }) });
        }
        return Promise.resolve({ value: null });
      },
      getMany: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve({ ok: true }); },
    },
    project: { list: function () { return Promise.resolve({ projects: [] }); }, sessions: function () { return Promise.resolve({ sessions: [], total: 0, hasMore: false }); }, worktreeSessions: function () { return Promise.resolve({ sessions: [] }); } },
    provider: { list: function () { return Promise.resolve({ providers: [] }); }, health: function () { return Promise.resolve({ status: "unavailable" }); } },
    piModels: { listAvailable: function () { return Promise.resolve({ models: [] }); } },
    codexModels: { list: function () { return Promise.resolve({ providers: [] }); } },
    runtimes: { list: function () { return Promise.resolve({ runtimes: [] }); } },
    lsp: { list: function () { return Promise.resolve({ languages: [] }); } },
    claude: { listSideChats: function () { var a = window.__arcFixture; return Promise.resolve({ sessions: window.__arcSideChatScene && a ? a.sideChats : [] }); } },
    session: {
      listPinned: function () { return Promise.resolve({ sessions: [] }); },
      list: function () { return Promise.resolve({ sessions: [] }); },
      // SideChatPanel uses the real selection → history hydration path.
      // Keep this deliberately empty, isolated and read-only in the probe.
      messages: function () { return Promise.resolve({ messages: [], hasMore: false }); },
      listAll: function () { var a = window.__arcFixture; return Promise.resolve({ sessions: a ? a.sessions : [], total: a ? a.sessions.length : 0, hasMore: false }); },
    },
    file: new Proxy({
      // 【T136】右栏文件树需要真数据才画得出来。虚构目录结构：两层，
      // 顶层两个目录 + 两个文件，其中一个目录展开后有内容（见 probe.ts 的
      // files-pane 场景，它把第二层展开成可见行）。
      listDir: function (input) {
        var dirPath = (input && input.dirPath) || "";
        var tree = {
          "": [
            { name: "src", path: "src", kind: "dir", hasChildren: true },
            { name: "docs", path: "docs", kind: "dir", hasChildren: true },
            { name: "README.md", path: "README.md", kind: "file", size: 1200 },
            { name: "package.json", path: "package.json", kind: "file", size: 840 },
          ],
          src: [
            { name: "index.ts", path: "src/index.ts", kind: "file", size: 2100 },
            { name: "app.ts", path: "src/app.ts", kind: "file", size: 3400 },
            { name: "utils.ts", path: "src/utils.ts", kind: "file", size: 620 },
          ],
          docs: [
            { name: "guide.md", path: "docs/guide.md", kind: "file", size: 5100 },
          ],
        };
        return Promise.resolve({ entries: tree[dirPath] || [] });
      },
    }, {
      get: function (target, key) { return target[key] || function () { return Promise.resolve({}); }; }
    }),
    git: new Proxy({
      worktreeList: function () { return Promise.resolve({ worktrees: [] }); },
      // 【T136】Git 面板：`discoverRepos` 只返回**仓库列表**（GitRepo 只有
      // path/name/isRepo —— 改动文件不在这里），三个改动文件来自 `status`。
      // 形状取自 `packages/contracts/src/ipc/git.ts` 的 GitRepo / GitStatusResult。
      discoverRepos: function () {
        return Promise.resolve({ repos: [{
          path: "C:\\arc005-visual-p1",
          name: "arc005-fixture-repo",
          isRepo: true,
        }] });
      },
      status: function () {
        return Promise.resolve({ status: {
          branch: "main", ahead: 1, behind: 0,
          files: [
            { path: "src/index.ts", index: "unmodified", workingTree: "modified" },
            { path: "src/app.ts", index: "unmodified", workingTree: "modified" },
            { path: "docs/guide.md", index: "added", workingTree: "unmodified" },
          ],
        } });
      },
    }, {
      get: function (target, key) { return target[key] || function () { return Promise.resolve({}); }; }
    }),
    customModel: { list: function () { return Promise.resolve({ models: [] }); } },
    outputStyle: { list: function () { return Promise.resolve({ styles: [] }); } },
    workflow: {
      list: function () { return Promise.resolve({ workflows: [] }); },
      agentProfiles: function () { return Promise.resolve({ profiles: [], problems: [] }); },
    },
    automation: { statusAll: function () { return Promise.resolve({ statuses: {} }); } },
    library: { groupsGet: function () { return Promise.resolve({ groups: [] }); } },
    // 【T136】任务中心要有任务才画得出来。三个虚构任务，其中一个是 failed
    // （场景描述要求「3 个任务、1 个 failed」）。字段形状取自
    // `packages/contracts/src/ipc/task.ts` 的 TaskSchema（.strict()，多一个字段
    // 都会被 zod 拒，所以这里只给 schema 里有的）。
    task: {
      list: function () {
        var t = function (id, goal, status, extra) {
          return Object.assign({
            id: id, goal: goal, status: status, dependsOn: [],
            origin: { kind: "session", ref: "s1" },
            links: { sessionIds: ["s1"], workflowIds: [] },
            artifacts: [], acceptance: null,
            failureReason: null, rejectionReason: null,
            createdAt: 1700000000000, updatedAt: 1700000001000,
          }, extra || {});
        };
        return Promise.resolve({ tasks: [
          t("task_arc005_1", "把季度数据整理成报告", "done"),
          t("task_arc005_2", "重构导出模块的重复逻辑", "running"),
          t("task_arc005_3", "修正表格超宽问题", "failed", { failureReason: "字体回退失败" }),
        ] });
      },
    },
    modules: { catalog: function () { return Promise.resolve({ modules: [] }); } },
    theme: {
      get: function () { return Promise.resolve({ theme: "light", effective: "light" }); },
      set: function () { return Promise.resolve({ theme: "light", effective: "light" }); },
    },
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
})();
