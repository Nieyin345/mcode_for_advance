/**
 * 【Q9c / WF-05 补充】**画布上的审批与能力徽标。**
 *
 * 跑在 Node-RED 编辑器页面里（由 `editorTheme.page.scripts` 注入，不是 Electron
 * 主进程）。用的是**上游公开的 annotation API** —— `RED.view.annotations.register`，
 * 与 Node-RED 官方自己画徽标走同一个挂载点，不改 vendor 源码。
 *
 * ## 它显示什么
 *
 * 只显示**已经写在节点配置里的、Host 承认的**事实：
 *
 * - 能力档（`x-mcode.capability`）：read / write / exec / net
 * - 待审批（`x-mcode.reviewPending === true`）
 *
 * **不显示运行状态**：那是 `node.status()` 的职责（见 `mcodeNodePack.ts` 的
 * `createNodeStatusReporter`），两者叠在一起会让节点下方挤成两行小字。
 *
 * ## 为什么徽标不是权限
 *
 * 徽标是**只读展示**。真正拒绝越权的是 Host 侧 `assertMcodeNodePortResult` 与
 * 审批桥；把徽标做得再显眼也不会让一个未授权的节点跑起来。反过来，**不显示**也
 * 不会让它变得更安全 —— 用户看不到"这一步要写文件"就更容易误批准。所以它值得有，
 * 但它的价值全在"让人看见"，不在"拦住"。
 */
RED.hooks.add("editor:ready", function () {
  if (!RED.view || !RED.view.annotations || typeof RED.view.annotations.register !== "function") {
    return;
  }

  var CAPABILITY_LABEL = {
    read: "只读",
    write: "可写",
    exec: "可执行",
    net: "可联网",
  };

  RED.view.annotations.register("mcode-capability", {
    type: "badge",
    element: function (node) {
      return "#";
    },
    show: function (node) {
      var meta = node && node["x-mcode"];
      if (!meta || typeof meta !== "object") return "";
      var capability = meta.capability;
      if (typeof capability !== "string" || !CAPABILITY_LABEL[capability]) return "";
      return CAPABILITY_LABEL[capability];
    },
    filter: function (node) {
      var meta = node && node["x-mcode"];
      return !!(meta && typeof meta === "object" && CAPABILITY_LABEL[meta.capability]);
    },
    tooltip: function (node) {
      var meta = node && node["x-mcode"];
      var capability = meta && meta.capability;
      if (!CAPABILITY_LABEL[capability]) return "";
      return "Mcode 能力：" + CAPABILITY_LABEL[capability]
        + "（这一步实际能做什么由 Mcode 宿主判定，徽标只作展示）";
    },
  });

  RED.view.annotations.register("mcode-review-pending", {
    type: "badge",
    element: function () {
      return "!";
    },
    show: function (node) {
      return node && node["x-mcode"] && node["x-mcode"].reviewPending === true ? "待审查" : "";
    },
    filter: function (node) {
      return !!(node && node["x-mcode"] && node["x-mcode"].reviewPending === true);
    },
    tooltip: "这份工作流来自导入或 AI 修改，尚未经你审查。审查通过前它不会在重启后自动执行。",
  });
});
