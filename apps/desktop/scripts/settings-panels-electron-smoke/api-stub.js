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
  /* ── 【MC-047 复核】按 key 的读侧夹具 ───────────────────────────────────
   * 真 App 里的 `useSettingValue` 只有三态(loading/ready/error),要把它钉在
   * 真 Electron 里,必须能**定向**让某一格读失败、并给其余格真实值:
   *   - `window.__seedSetting(key, value)`:该 key 的读回值;
   *   - `window.__failNextGet(key, message)`:下一次该 key 的读拒一次,之后成功。
   * 由探针在**点击导航之前**注入,于是面板挂载那一刻读到的是坏结果。 */
  var settingValues = {};
  var getFailures = {};
  window.__seedSetting = function (key, value) { settingValues[key] = value; };
  window.__failNextGet = function (key, message) { getFailures[key] = message; };
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
      // `trigger` 决定它归「自动化」那一栏(见 workflowView.ts 的 purposeOf)——
      // 从前是列表映射里无差别补上的;加上 MC-045 的图型夹具后不能再那样补,
      // 否则工作流那一栏会把自动化也列进来。
      trigger: { kind: "manual" },
      nodes: [{ id: "t1", type: "mcode.trigger", title: "触发器", params: { triggerKind: "manual", task: "跑" }, position: { x: 0, y: 0 } }],
    },
    // 【MC-045 复核】深链带上 workflowId 时要打开的那一份(无 trigger = 工作流栏)。
    "wf-mc045": {
      id: "wf-mc045", name: "MC045 深链取证图", description: "", edges: [], builtin: false, updatedAt: 2,
      nodes: [],
    },
  };
  /** 最近一次 `workflow.get` 的目标 id —— 断言"深链真的打开的是它",而不是只看页面有字。 */
  window.__lastWorkflowGet = null;

  // 主题走**真 IPC**(bridge.cjs → 探针注册的 theme:get/set),其余命名空间用内存桩。
  // `on` 返回的取消函数必须可调用 —— useTheme 在卸载时会调用它。
  var themeBridge = window.__electronTheme || null;
  // 【ARC-005】节点安装审批：有真桥(?panel=engine-runtime)时用它——审批请求由探针
  // 从主进程 `wc.send` 推送、应答走真 `invoke`（探针据此计数并把参数记进 checks）。
  var nodeApprovalBridge = window.__electronNodeApproval || null;
  var noopSub = function () { return function () {}; };
  /**
   * 【MC-045 复核】未列出的命名空间回一个**惰性 Proxy**:真 App 的工作区外围会读
   * `relay.status()` / `lsp.list()` / `runtimes.list()` 这类与设置无关的 RPC,而它们
   * 在 `on` 上还要求"取消函数可调用"。回 `Promise.resolve({})` + noop 订阅,
   * 让这些外围组件安静地拿空数据 —— 深链判据不受它们影响。
   * 注意 `then` 必须回 undefined,否则 Promise 链会把它当 thenable。
   */
  function makeNamespace(ns) {
    function rpc(input) {
      calls[ns + ".<rpc>"] = (calls[ns + ".<rpc>"] || 0) + 1;
      return Promise.resolve({});
    }
    return new Proxy(rpc, {
      get: function (_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "on") return noopSub;
        if (typeof prop !== "string") return undefined;
        return function () { return Promise.resolve({}); };
      },
    });
  }

  window.api = {
    platform: "win32",
    on: new Proxy({}, {
      get: function (_t, prop) {
        if (prop === "themeChanged") {
          return function (cb) { return themeBridge ? themeBridge.onChanged(cb) : noopSub(); };
        }
        if (prop === "nodeInstallApproval") {
          return function (cb) { return nodeApprovalBridge ? nodeApprovalBridge.onApproval(cb) : noopSub(); };
        }
        return noopSub;
      },
    }),
    theme: {
      get: function () { return themeBridge ? themeBridge.get() : Promise.resolve({ theme: "light", effective: "light" }); },
      set: function (input) { return themeBridge ? themeBridge.set(input) : Promise.resolve({ theme: input.theme, effective: input.theme }); },
    },
    setting: {
      get: function (input) {
        var key = input && input.key;
        calls["setting.get:" + key] = (calls["setting.get:" + key] || 0) + 1;
        if (key && getFailures[key]) {
          var msg = getFailures[key];
          delete getFailures[key];
          return Promise.reject(new Error(msg));
        }
        var value = key && Object.prototype.hasOwnProperty.call(settingValues, key) ? settingValues[key] : null;
        return invoke("setting.get", { value: value });
      },
      set: function (input) {
        var key = input && input.key;
        // 【MC-047 复核】按 key **无条件**计数(从前只在失败分支 +1,导致
        // 「读失败期间没有写」这类断言两边都是 0、空过)。
        if (key) calls["setting.set:" + key] = (calls["setting.set:" + key] || 0) + 1;
        if (key) window.__lastSettingSet = { key: key, value: input && input.value };
        if (key && failOnceKey[key]) {
          var msg = failOnceKey[key];
          delete failOnceKey[key];
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
    piModels: {
      list: function () { return invoke("piModels.list", { providers: {} }); },
      /** 真 App 的 store `initDeferred` 读它(面板自身不读)。 */
      listAvailable: function () { return invoke("piModels.listAvailable", { models: [] }); },
    },
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
        // 【MC-045 复核】逐条保留自己的 `trigger`:从前这里无差别补
        // `trigger:{kind:"manual"}`,会把工作流也标成自动化(库的分栏读的就是它)。
        return invoke("workflow.list", {
          workflows: Object.keys(docs).map(function (id) {
            return Object.assign({}, docs[id], { kind: "graph" });
          }),
        });
      },
      get: function (input) {
        var id = (input && input.id) || null;
        window.__lastWorkflowGet = id;
        calls["workflow.get:" + id] = (calls["workflow.get:" + id] || 0) + 1;
        return invoke("workflow.get", { workflow: docs[id] || null, review: null });
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
    project: { list: function () { return invoke("project.list", { projects: [{ id: "p1", name: "项目", path: "C:/p1" }] }); },
      /** `fetchProjectSessionBuckets` 对每个项目读两段(本地 + 工作树)再读归档。 */
      sessions: function (input) {
        var archived = !!(input && input.archived);
        return invoke("project.sessions", archived
          ? { sessions: [] }
          : { sessions: [], hasMore: false, total: 0 });
      },
    },
    /** 【MC-045 复核】真 App 的 store 首屏会读这三处;给全形状,免得真实工作区
     *  在空数据上炸树(炸了会把深链判据一起带走,分不清是导航缺陷还是夹具缺陷)。 */
    session: {
      listPinned: function () { return invoke("session.listPinned", { sessions: [] }); },
      list: function () { return invoke("session.list", { sessions: [] }); },
    },
    provider: { list: function () { return invoke("provider.list", { providers: [] }); } },
    skills: { list: function () { return invoke("skills.list", { skills: [] }); } },
    voice: {
      modelList: function () {
        return invoke("voice.modelList", { models: [], downloaded: [], selected: null, modelDir: "C:/mc045/models", isCustom: false });
      },
    },
    /** `?panel=app` 里「文档管理」深链的落地页会读它(数据位置那块)。 */
    app: {
      getDataRoot: function () {
        return invoke("app.getDataRoot", { root: "C:/mc045/data", dbPath: "C:/mc045/data/mcode.db", libraryPath: "C:/mc045/data/library" });
      },
    },
    library: {
      groupsGet: function () { return invoke("library.groupsGet", { groups: [] }); },
      listCollections: function () { return invoke("library.listCollections", { collections: [] }); },
      suppressGet: function () { return invoke("library.suppressGet", { rule: { nodes: [], extensions: [] } }); },
    },
    /** 【MC-047 复核】浏览器设置页的保管库状态读(PersistLoginRow 在设置读成功后
     *  才发)。健康回执按真实形状给全字段。 */
    browser: {
      vaultStatus: function () {
        return invoke("browser.vaultStatus", {
          encryptionAvailable: true,
          persistLogin: true,
          savedCount: 0,
          plaintextErased: false,
          lastError: null,
          restoreError: null,
        });
      },
    },
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
    // 【ARC-005】引擎面板（?panel=engine-runtime）读的节点包清单 + 安装应答。
    // 必须给**一个**引擎：`EngineRuntimePanel` 在引擎表为空时只画「没有可用的第三方
    // 引擎」，节点包区块（审批卡订阅者）根本不会挂载 —— 推送请求会被静默丢掉，
    // 那会让审批卡断言变成等待超时而不是真的红。`nodeInstall` 不派发（探针只验
    // 审批卡，不真装）。
    workflowEngine: {
      list: function () {
        return invoke("workflowEngine.list", {
          engines: [{ engineId: "node-red", state: "stopped", port: null, reason: null, editorUrl: null }],
        });
      },
      nodesList: function () { return invoke("workflowEngine.nodesList", { corrupt: null, nodes: [] }); },
      nodeInstall: function () { return invoke("workflowEngine.nodeInstall", { ok: false, code: "approval_denied", reason: "stub" }); },
      respondNodeInstallApproval: function (input) {
        return nodeApprovalBridge
          ? nodeApprovalBridge.respond(input)
          : invoke("workflowEngine.respondNodeInstallApproval", { ok: true });
      },
    },
  };
  // 【MC-045 复核】显式列出的命名空间优先;其余一律惰性 Proxy(见 makeNamespace)。
  var stubApi = window.api;
  window.api = new Proxy(stubApi, {
    get: function (target, ns) {
      if (typeof ns !== "string" || ns === "then") return undefined;
      if (Object.prototype.hasOwnProperty.call(target, ns)) return target[ns];
      return makeNamespace(ns);
    },
  });
})();
