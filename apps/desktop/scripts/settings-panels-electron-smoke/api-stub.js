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
  /** 按**设置键**注入一次失败(外观/语言那几个 setter 都走 `setting.set`)。 */
  var failOnceKey = {};
  if (scenario === "theme-set-fail") {
    // theme 走真 IPC(bridge.cjs);探针据同一 scenario 让主进程那一次 theme:set 失败。
  }
  if (scenario === "chatfont-save-fail") failOnceKey["ui.chatFontSize"] = "AUDIT_E2E_CHAT_FONT_SAVE";
  if (scenario === "panel-font-save-fail") failOnceKey["ui.rightPanelFontSize"] = "AUDIT_E2E_PANEL_FONT_SAVE";
  if (scenario === "locale-save-fail") failOnceKey["ui.locale"] = "AUDIT_E2E_LOCALE_SAVE";
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
    // 带一个真触发器节点:自动化检查器里的「立刻运行一次」才出得来(见「运行前预检」场景)。
    "auto-1": {
      id: "auto-1", name: "每日整理", description: "", edges: [], builtin: false, updatedAt: 1,
      nodes: [{ id: "t1", type: "mcode.trigger", title: "触发器", params: { triggerKind: "manual", task: "跑" }, position: { x: 0, y: 0 } }],
    },
  };

  // 主题走**真 IPC**(bridge.cjs → 探针注册的 theme:get/set),其余命名空间用内存桩。
  // `on` 返回的取消函数必须可调用 —— useTheme 在卸载时会调用它。
  var themeBridge = window.__electronTheme || null;
  var noopSub = function () { return function () {}; };

  window.api = {
    platform: "win32",
    on: new Proxy({}, {
      get: function (_t, prop) {
        if (prop === "themeChanged") {
          return function (cb) { return themeBridge ? themeBridge.onChanged(cb) : noopSub(); };
        }
        return noopSub;
      },
    }),
    theme: {
      get: function () { return themeBridge ? themeBridge.get() : Promise.resolve({ theme: "light", effective: "light" }); },
      set: function (input) { return themeBridge ? themeBridge.set(input) : Promise.resolve({ theme: input.theme, effective: input.theme }); },
    },
    setting: {
      get: function () { return invoke("setting.get", { value: null }); },
      set: function (input) {
        var key = input && input.key;
        if (key && failOnceKey[key]) {
          var msg = failOnceKey[key];
          delete failOnceKey[key];
          calls["setting.set:" + key] = (calls["setting.set:" + key] || 0) + 1;
          return Promise.reject(new Error(msg));
        }
        return invoke("setting.set", { ok: true });
      },
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
      /** 「运行前预检」:按场景给不同结论;`preflight-throw` 让调用 reject。 */
      preflight: function (input) {
        if (scenario === "preflight-throw") {
          calls["automation.preflight"] = (calls["automation.preflight"] || 0) + 1;
          return Promise.reject(new Error("AUDIT_E2E_PREFLIGHT_FAILED"));
        }
        if (scenario === "preflight-missing-executor") {
          return invoke("automation.preflight", {
            ok: false, workflowId: input && input.workflowId, triggerKey: (input && input.workflowId) + ":" + (input && input.triggerNodeId),
            problem: { kind: "missing-executor", reason: "缺执行器「node-red」" },
            problems: [{ kind: "missing-executor", reason: "缺执行器「node-red」" }],
            capabilities: { required: ["executor:node-red"], available: [] },
          });
        }
        return invoke("automation.preflight", {
          ok: true, workflowId: input && input.workflowId, triggerKey: (input && input.workflowId) + ":" + (input && input.triggerNodeId),
          problems: [], capabilities: { required: [], available: [] },
        });
      },
      run: function () { return invoke("automation.run", { ok: true }); },
    },
    webBridge: { status: function () { return invoke("webBridge.status", { paired: false }); } },
    /** 常规页里的「输出风格」小节会读它(空表 = 只有内置 Default)。 */
    outputStyle: { list: function () { return invoke("outputStyle.list", { styles: [] }); } },
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
