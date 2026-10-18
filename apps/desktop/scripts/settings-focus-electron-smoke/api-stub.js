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
      get: function () { return Promise.resolve({ value: null }); },
      getMany: function () { return Promise.resolve({}); },
      set: function () { return Promise.resolve({ ok: true }); },
    },
    project: { list: function () { return Promise.resolve({ projects: [] }); } },
    session: {
      listPinned: function () { return Promise.resolve({ sessions: [] }); },
      list: function () { return Promise.resolve({ sessions: [] }); },
    },
    customModel: { list: function () { return Promise.resolve({ models: [] }); } },
    outputStyle: { list: function () { return Promise.resolve({ styles: [] }); } },
    workflow: {
      list: function () { return Promise.resolve({ workflows: [] }); },
      agentProfiles: function () { return Promise.resolve({ profiles: [], problems: [] }); },
    },
    automation: { statusAll: function () { return Promise.resolve({ statuses: {} }); } },
    library: { groupsGet: function () { return Promise.resolve({ groups: [] }); } },
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
