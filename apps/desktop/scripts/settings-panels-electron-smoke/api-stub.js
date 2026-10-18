/**
 * 面板级设置页的 API 桩 —— 在 `bundle.js` **之前**由 index.html 加载。
 *
 * 为什么不能写在 renderer 入口里:`@renderer/lib/api.js` 在**模块求值那一刻**决定
 * `window.api ?? createWebApi()`,而 ES 的 import 先于模块体执行(与 settings-layout-smoke
 * 同一坑,那边有更长的说明)。所以桩必须在任何面板模块求值之前就位。
 *
 * 失败注入按 `?case=` 场景一次性生效(第一次调用拒,重试自然成功)—— 这样"点重试真的
 * 重发"的断言判据是 `__calls[rpc]` 计数 +1 且错误消失,而不是"永远在报"。
 */
(function () {
  var scenario = new URLSearchParams(location.search).get("case") || "healthy";
  var calls = {};
  window.__calls = calls;
  window.__ready = false;

  var failOnce = {};
  if (scenario === "custom-model-load-fail") failOnce["customModel.list"] = "AUDIT_E2E_CUSTOM_MODEL_LOAD";
  if (scenario === "engine-tools-load-fail") failOnce["engineTools.get"] = "AUDIT_E2E_ENGINE_TOOLS_LOAD";
  if (scenario === "automation-load-fail") failOnce["workflow.list"] = "AUDIT_E2E_WORKFLOW_LIST_LOAD";
  if (scenario === "custom-model-save-fail") failOnce["customModel.save"] = "AUDIT_E2E_CUSTOM_MODEL_SAVE";
  if (scenario === "engine-tools-save-fail") failOnce["engineTools.set"] = "AUDIT_E2E_ENGINE_TOOLS_SAVE";
  if (scenario === "automation-save-fail") failOnce["workflow.save"] = "AUDIT_E2E_WORKFLOW_SAVE";

  function invoke(name, result) {
    calls[name] = (calls[name] || 0) + 1;
    if (failOnce[name]) {
      var msg = failOnce[name];
      delete failOnce[name];
      return Promise.reject(new Error(msg));
    }
    return Promise.resolve(typeof result === "function" ? result() : result);
  }

  var docs = {
    "auto-1": { id: "auto-1", name: "每日整理", description: "", nodes: [], edges: [], builtin: false, updatedAt: 1 },
  };

  window.api = {
    platform: "win32",
    on: new Proxy({}, { get: function () { return function () { return function () {}; }; } }),
    setting: {
      get: function () { return invoke("setting.get", { value: null }); },
      set: function () { return invoke("setting.set", { ok: true }); },
      getMany: function () { return invoke("setting.getMany", {}); },
    },
    customModel: {
      list: function () { return invoke("customModel.list", { models: [], storeInvalid: false }); },
      save: function () { return invoke("customModel.save", { models: [] }); },
      delete: function () { return invoke("customModel.delete", { ok: true }); },
      test: function () { return invoke("customModel.test", { ok: true }); },
      getToken: function () { return invoke("customModel.getToken", { token: "" }); },
    },
    piModels: { list: function () { return invoke("piModels.list", { providers: {} }); } },
    codexModels: { list: function () { return invoke("codexModels.list", { providers: [] }); } },
    engineTools: {
      get: function () {
        return invoke("engineTools.get", {
          engines: {
            claude: { exclude: [], supported: true, known: ["Bash", "Read"], guidance: "" },
            pi: { exclude: [], supported: true, known: ["read", "bash"], guidance: "" },
            codex: { exclude: [], supported: false, known: [], guidance: "" },
          },
          status: "MISSING",
        });
      },
      set: function () {
        return invoke("engineTools.set", {
          ok: true,
          snapshot: {
            engines: {
              claude: { exclude: [], supported: true, known: ["Bash", "Read"], guidance: "" },
              pi: { exclude: [], supported: true, known: ["read", "bash"], guidance: "" },
              codex: { exclude: [], supported: false, known: [], guidance: "" },
            },
            status: "MISSING",
          },
        });
      },
    },
    workflow: {
      list: function () {
        return invoke("workflow.list", {
          workflows: Object.keys(docs).map(function (id) {
            return Object.assign({}, docs[id], { kind: "graph", trigger: { kind: "manual" } });
          }),
        });
      },
      get: function (input) {
        return invoke("workflow.get", { workflow: docs[input && input.id] || null, review: null });
      },
      save: function (input) {
        return invoke("workflow.save", function () {
          if (input && input.workflow) docs[input.workflow.id] = input.workflow;
          return { ok: true };
        });
      },
      nodeTypes: function () { return invoke("workflow.nodeTypes", { entries: [], problems: [] }); },
      agentProfiles: function () { return invoke("workflow.agentProfiles", { profiles: [], problems: [] }); },
    },
    project: { list: function () { return invoke("project.list", { projects: [{ id: "p1", name: "项目", path: "C:/p1" }] }); } },
    automation: {
      runs: function () { return invoke("automation.runs", { runs: [] }); },
      statusAll: function () { return invoke("automation.statusAll", []); },
    },
    webBridge: { status: function () { return invoke("webBridge.status", { paired: false }); } },
    /** 【MC-026】自定义模型表单的「高级」区里挂着公网 MCP 卡 —— 真组件会读它。
     *  回执按真实状态形状给全字段,免得消费方在 `status.status` 这类读法上炸树。 */
    publicMcp: {
      status: function () {
        return invoke("publicMcp.status", {
          enabled: false,
          running: false,
          secret: "",
          url: null,
          error: null,
          tunnel: { mode: "off", hostname: null, tokenSet: false },
          projectLinks: [],
          sessionId: null,
          projectId: null,
          mobileHostname: null,
          fixedPort: 0,
          availableProjects: [],
          sandboxProjectId: null,
          sandboxProjectMissing: false,
          sandboxProjectMissingId: null,
        });
      },
    },
  };
})();
