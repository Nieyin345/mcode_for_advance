/**
 * 工作流小流程图（右栏看板的上半块）的真浏览器预览台。
 *
 * 目的：用户提的「画布实时进度效果很差」当初只改了根因、**从没起 dev 实看过**。
 * 这里把 `WorkflowFlowMini` 在一个受控的文档 + 运行现场下渲染出来，用 `ui-probe`
 * 量它的几何、颜色、墨量、裁切 —— 而不是靠人眼看截图。
 *
 * 页面提供三个场景（用 URL hash 选），每个都写死一份 `WorkflowDoc` + 一份 `LiveRun`：
 *   #mixed   —— 一张多层的图，各档状态齐全（排队 / 执行中 / 成功 / 失败 / 等你 / 没走）
 *   #running —— 只有一格在执行中（看走动亮边与每秒耗时）
 *   #back    —— 带回边（环）的图（看回边绕行画得对不对）
 */
import { createRoot } from "react-dom/client";
import { createElement, useEffect, useMemo, useState } from "react";
import type { WorkflowDoc } from "@contracts/workflow";
import { WorkflowFlowMini } from "@renderer/components/chat/WorkflowFlowMini.js";
import type { LiveRun, LiveNode } from "@renderer/lib/workflowLive.js";

const doc: WorkflowDoc = {
  id: "wf_preview",
  name: "文献精读",
  builtin: false,
  updatedAt: 0,
  nodes: [
    { id: "n1", type: "mcode.main", title: "拆解任务", params: {}, position: { x: 0, y: 0 } },
    { id: "n2", type: "mcode.agent", title: "检索文献", params: {}, position: { x: 0, y: 0 } },
    { id: "n3", type: "mcode.agent", title: "提取方法", params: {}, position: { x: 0, y: 0 } },
    { id: "n4", type: "mcode.branch", title: "够不够", params: {}, position: { x: 0, y: 0 } },
    { id: "n5", type: "mcode.agent", title: "撰写综述并逐条核对所有引用来源这个超长的标题", params: {}, position: { x: 0, y: 0 } },
    { id: "n6", type: "mcode.agent", title: "同行评议", params: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n1", to: "n3" },
    { id: "e3", from: "n2", to: "n4" },
    { id: "e4", from: "n3", to: "n4", label: "够了" },
    { id: "e5", from: "n4", to: "n5" },
    { id: "e6", from: "n5", to: "n6" },
  ],
};

function node(id: string, type: string, partial: Partial<LiveNode>): LiveNode {
  return { nodeId: id, runId: "run_1", nodeType: type, title: "", phase: "queued", ...partial };
}

const runMixed: LiveRun = {
  runId: "run_1",
  sessionId: "s1",
  workflowId: "wf_preview",
  startedAt: 1000,
  touchedAt: 2000,
  order: ["n1", "n2", "n3", "n4", "n5", "n6"],
  nodes: {
    n1: node("n1", "mcode.main", { title: "拆解任务", phase: "settled", status: "success", startedAt: 1_000, endedAt: 12_000 }),
    n2: node("n2", "mcode.agent", { title: "检索文献", phase: "settled", status: "success", startedAt: 12_000, endedAt: 74_000 }),
    n3: node("n3", "mcode.agent", { title: "提取方法", phase: "running", startedAt: Date.now() - 134_000 }),
    n4: node("n4", "mcode.branch", { title: "够不够", phase: "running", awaiting: true, attempt: 1 }),
    n5: node("n5", "mcode.agent", { title: "撰写综述并逐条核对所有引用来源这个超长的标题", phase: "queued" }),
    n6: node("n6", "mcode.agent", { title: "同行评议", phase: "settled", status: "failed", error: "炸了", startedAt: 1_000, endedAt: 5_000 }),
  },
};

const runRunning: LiveRun = {
  ...runMixed,
  order: ["n1", "n2"],
  nodes: {
    n1: node("n1", "mcode.main", { title: "拆解任务", phase: "settled", status: "success", startedAt: 1_000, endedAt: 12_000 }),
    n2: node("n2", "mcode.agent", { title: "检索文献", phase: "running", startedAt: Date.now() - 5_000 }),
  },
};

const docBack: WorkflowDoc = {
  id: "wf_back",
  name: "带环的图",
  builtin: false,
  updatedAt: 0,
  nodes: [
    { id: "a", type: "mcode.main", title: "开始", params: {}, position: { x: 0, y: 0 } },
    { id: "b", type: "mcode.agent", title: "初稿", params: {}, position: { x: 0, y: 0 } },
    { id: "c", type: "mcode.branch", title: "稿子怎么样", params: {}, position: { x: 0, y: 0 } },
    { id: "d", type: "mcode.agent", title: "定稿", params: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", from: "a", to: "b" },
    { id: "e2", from: "b", to: "c" },
    { id: "e3", from: "c", to: "b", label: "再改一轮" },
    { id: "e4", from: "c", to: "d", label: "可以了" },
  ],
};

const runBack: LiveRun = {
  runId: "run_2",
  sessionId: "s1",
  workflowId: "wf_back",
  startedAt: 1000,
  touchedAt: 2000,
  order: ["a", "b", "c", "d"],
  nodes: {
    a: node("a", "mcode.main", { title: "开始", phase: "settled", status: "success", startedAt: 1_000, endedAt: 2_000 }),
    b: node("b", "mcode.agent", { title: "初稿", phase: "settled", status: "success", startedAt: 2_000, endedAt: 9_000 }),
    c: node("c", "mcode.branch", { title: "稿子怎么样", phase: "running", awaiting: true, attempt: 2 }),
    d: node("d", "mcode.agent", { title: "定稿", phase: "queued" }),
  },
};

function useScene(): string {
  const [hash, setHash] = useState(window.location.hash.replace("#", "") || "mixed");
  useEffect(() => {
    const on = (): void => setHash(window.location.hash.replace("#", "") || "mixed");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const scene = useScene();
  const [d, r] = useMemo<[WorkflowDoc, LiveRun | null]>(() => {
    if (scene === "running") return [doc, runRunning];
    if (scene === "back") return [docBack, runBack];
    return [doc, runMixed];
  }, [scene]);
  return createElement(
    "div",
    { style: { width: 320, background: "rgb(var(--surface))", padding: 8 } },
    createElement(WorkflowFlowMini, {
      doc: d,
      run: r,
      selectedNodeId: null,
      onSelectNode: () => {},
      maxHeight: 520,
    }),
  );
}

createRoot(document.getElementById("root")!).render(createElement(App));
