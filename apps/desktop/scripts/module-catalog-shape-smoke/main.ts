/**
 * 【T41】`contributionsOf` 目录形状异常时的**用户可见行为**回归。
 *
 * ## 钉的是什么
 *
 * `catalog?.modules.flatMap(...)` 只有一层可选链。主进程若因版本漂移、降级安装或
 * IPC 裁剪回了一个没有 `modules`（或 `modules` 不是数组）的目录，原实现对
 * `undefined` 调 `.flatMap` → **渲染期同步抛错**。而 `RightPanel` 是常驻面板、
 * 渲染期直接调用、此前整棵树没有任何错误边界 → **整个主界面白屏**。
 *
 * 修法有两半，断言也有两半 —— 少验一半就等于没验：
 *
 *   A. **不崩**：`contributionsOf` 返回空数组，不抛。
 *   B. **不静默**：用户**看得见**一条说明目录坏了的中文/英文提示。
 *
 * 只验 A 会漏掉「静默空」——那正是从「白屏」退化成「扩展视图无声消失」的形态。
 * 只验 B 会漏掉「其实还在抛、只是有边界兜着」。
 *
 * ## 为什么用 `renderToStaticMarkup`
 *
 * 判据必须立在**用户看到的那行字**上，不能立在「源码里有 `?.`」。这一套真渲染
 * `ModuleCatalogNotice`，断言产出 HTML 里有提示文案与 `role="alert"`。
 * 仓库没有 jsdom（也不许联网装），`react-dom/server` 已够。
 *
 * Run: scripts/module-catalog-shape-smoke/run.sh
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  contributionsOf,
  moduleCatalogShapeError,
  ModuleCatalogNotice,
} from "../../src/renderer/components/modules/moduleCatalogShape.js";
import type { ModuleCatalog } from "@contracts/modules";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 一份形状正确的目录（空模块表 = 全新安装）。 */
const HEALTHY: ModuleCatalog = {
  modules: [],
  capabilities: [],
  workflowTargets: [],
  modulePermissions: {},
  moduleStaleConsents: {},
} as unknown as ModuleCatalog;

/** 主进程少返回了 `modules` 的那种坏回包。 */
const MISSING_MODULES = { capabilities: [], workflowTargets: [] } as unknown as ModuleCatalog;
/** `modules` 存在但类型不对。 */
const BAD_TYPE = { modules: null, capabilities: [], workflowTargets: [] } as unknown as ModuleCatalog;

console.log("\nA. 形状校验:三种输入各是什么结论");
check("目录还没读到(undefined)不算形状错误 —— 那是加载态,不是坏数据",
  moduleCatalogShapeError(undefined) === null);
check("健康目录没有形状错误", moduleCatalogShapeError(HEALTHY) === null,
  moduleCatalogShapeError(HEALTHY));
check("缺 modules 被识别为形状错误并点名字段",
  moduleCatalogShapeError(MISSING_MODULES)?.includes("modules") === true,
  moduleCatalogShapeError(MISSING_MODULES));
check("modules 类型不对被识别为形状错误并点出实际类型",
  moduleCatalogShapeError(BAD_TYPE)?.includes("object") === true,
  moduleCatalogShapeError(BAD_TYPE));

console.log("\nB. 不崩:坏目录上 contributionsOf 必须返回空数组,不能抛");
for (const [label, catalog] of [
  ["缺 modules", MISSING_MODULES],
  ["modules 类型不对", BAD_TYPE],
] as const) {
  let threw: unknown = null;
  let value: unknown = null;
  try {
    value = contributionsOf(catalog, "view");
  } catch (error) {
    threw = error;
  }
  check(`${label}: 不抛错(抛错会让常驻右栏整棵子树卸载 → 主界面白屏)`, threw === null,
    threw instanceof Error ? threw.message : threw);
  check(`${label}: 返回空数组`, Array.isArray(value) && (value as unknown[]).length === 0, value);
}

console.log("\nC. 不静默:坏目录必须渲染出用户看得见的提示");
const zh = (catalog: ModuleCatalog | undefined) =>
  renderToStaticMarkup(
    React.createElement(ModuleCatalogNotice, {
      catalog: {
        data: catalog,
        loading: false,
        error: null,
        refetch: async () => {},
      } as never,
    }),
  );
const en = zh; // 同一份组件,文案由 i18n 决定;这里主要验结构

const missingHtml = zh(MISSING_MODULES);
check("缺 modules 时**渲染出内容**(不是 null / 空串)", missingHtml.length > 0, missingHtml.slice(0, 80));
check("提示带 role=alert(读屏会念出来,不是视觉隐形)",
  /role="alert"/.test(missingHtml), missingHtml.slice(0, 120));
check("提示里点名了「模块目录格式异常」这类用户能懂的话",
  missingHtml.includes("模块目录格式异常") || missingHtml.includes("catalog"),
  missingHtml.slice(0, 200));
check("提示里**填进了**具体原因(占位符没留成字面量)",
  !missingHtml.includes("{detail}") && /modules/.test(missingHtml),
  missingHtml.match(/modules[^<"]{0,40}/g));
check("提供重试入口(不是死路)",
  missingHtml.includes("重试") || missingHtml.includes("retry"), missingHtml.includes("重试"));

console.log("\nD. 健康与加载态:不能误报");
const healthyHtml = zh(HEALTHY);
check("健康目录不渲染任何提示(返回空串)", healthyHtml === "", healthyHtml.slice(0, 80));
const loadingHtml = zh(undefined);
check("还没读到(undefined)也不渲染提示 —— 加载中不是错误", loadingHtml === "", loadingHtml.slice(0, 80));

console.log("\nE. 正常目录的产出不受影响");
const withOne = {
  ...HEALTHY,
  modules: [{
    id: "user.demo", version: "1.0.0", title: { zh: "演示", en: "Demo" },
    description: { zh: "", en: "" }, permissions: [], contributions: [
      { id: "c1", slot: "view", title: { zh: "视图", en: "View" }, capability: "core.file.info", location: "right" },
    ],
  }],
} as unknown as ModuleCatalog;
const entries = contributionsOf(withOne, "view");
check("健康目录里的 view 贡献仍被正确收集(修坏目录没有顺手改坏正常路径)",
  entries.length === 1 && entries[0]!.contribution.id === "c1", entries.length);
check("槽位过滤仍然有效(换成别的 slot 拿不到它)",
  contributionsOf(withOne, "command").length === 0);

console.log(`\nmodule-catalog-shape-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
