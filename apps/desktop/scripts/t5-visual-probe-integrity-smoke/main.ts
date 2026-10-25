import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  ARC005_MEASURE_SELECTORS,
  ARC005_PROBE_TARGETS,
  buildSceneAssertionScript,
  buildTargetInspectionScript,
} from "../arc005-visual-baseline/probe-assertions.js";
import {
  SyntheticDocument,
  el,
  fixturePanel,
  toolRow,
  workspaceMain,
} from "./fixtures.js";

let assertions = 0;
let failures = 0;
function check(name: string, fn: () => void): void {
  assertions++;
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures++;
    console.error("FAIL " + name + " — " + String(error));
  }
}

function inspectTarget(name: keyof typeof ARC005_PROBE_TARGETS, doc: SyntheticDocument): any {
  return runInNewContext(buildTargetInspectionScript(name), { document: doc });
}

function inspectScene(scene: string, doc: SyntheticDocument, width = 1280): any {
  return runInNewContext(buildSceneAssertionScript(scene), {
    document: doc,
    window: { innerWidth: width },
  });
}

const realTitlebar = new SyntheticDocument([
  el("div", { "data-cds-titlebar": "" }, "workspace title"),
  el("section", { class: "settings-root" }, "", [
    el("header", {}, "settings panel title"),
  ]),
]);

check("titlebar selects the product marker, not the settings header", () => {
  const result = inspectTarget("titlebar", realTitlebar);
  assert.equal(result.state, "real-content");
  assert.equal(result.ok, true);
});

check("settings header alone is a wrong-container lookalike", () => {
  const doc = new SyntheticDocument([
    el("section", { class: "settings-root" }, "", [el("header", {}, "settings panel title")]),
  ]);
  const result = inspectTarget("titlebar", doc);
  assert.equal(result.state, "wrong-container");
  assert.equal(result.ok, false);
});

check("absent titlebar is missing, not a pass", () => {
  const result = inspectTarget("titlebar", new SyntheticDocument([]));
  assert.equal(result.state, "missing");
  assert.equal(result.ok, false);
});

check("Tiptap composer contenteditable is real content", () => {
  const doc = new SyntheticDocument([
    workspaceMain([
      el("div", { class: "composer-host" }, "", [
        el("div", {
          class: "composer-prose ProseMirror",
          contenteditable: "true",
          "aria-label": "Send a message",
        }),
      ]),
    ]),
  ]);
  const result = inspectTarget("composer", doc);
  assert.equal(result.state, "real-content");
  assert.equal(result.ok, true);
});

check("fixture textarea is fixture-only, not a composer", () => {
  const doc = new SyntheticDocument([
    workspaceMain([
      fixturePanel("fake-composer", [el("textarea", { "aria-label": "fake composer" })]),
    ]),
  ]);
  const result = inspectTarget("composer", doc);
  assert.equal(result.state, "fixture-only");
  assert.equal(result.ok, false);
});

check("composer outside workspace-main is wrong-container", () => {
  const doc = new SyntheticDocument([
    workspaceMain([]),
    el("aside", {}, "", [
      el("div", { class: "composer-host" }, "", [
        el("div", { class: "composer-prose", contenteditable: "true", "aria-label": "wrong pane" }),
      ]),
    ]),
  ]);
  const result = inspectTarget("composer", doc);
  assert.equal(result.state, "wrong-container");
  assert.equal(result.ok, false);
});

check("absent composer is missing", () => {
  const result = inspectTarget("composer", new SyntheticDocument([workspaceMain([])]));
  assert.equal(result.state, "missing");
  assert.equal(result.ok, false);
});

check("real tool row is selected by its specific row shape", () => {
  const doc = new SyntheticDocument([workspaceMain([el("div", { "data-message-id": "m-tool" }, "", [toolRow()])])]);
  const result = inspectTarget("tool-row", doc);
  assert.equal(result.state, "real-content");
  assert.equal(result.ok, true);
});

check("tool rail lookalike is rejected as wrong-container", () => {
  const doc = new SyntheticDocument([
    workspaceMain([el("aside", { "data-testid": "tool-rail" }, "Tool palette")]),
  ]);
  const result = inspectTarget("tool-row", doc);
  assert.equal(result.state, "wrong-container");
  assert.equal(result.ok, false);
});

check("tool-shaped content inside a fixture stays fixture-only", () => {
  const doc = new SyntheticDocument([workspaceMain([fixturePanel("fake-tool", [toolRow()])])]);
  const result = inspectTarget("tool-row", doc);
  assert.equal(result.state, "fixture-only");
  assert.equal(result.ok, false);
});

check("absent tool row is missing", () => {
  const result = inspectTarget("tool-row", new SyntheticDocument([workspaceMain([])]));
  assert.equal(result.state, "missing");
  assert.equal(result.ok, false);
});

check("measurements use exact titlebar, tool-row, and composer selectors", () => {
  const selectors = Object.fromEntries(ARC005_MEASURE_SELECTORS);
  assert.equal(selectors.titlebar, "[data-cds-titlebar]");
  assert.equal(selectors.composer, ARC005_PROBE_TARGETS.composer.measurementSelector);
  assert.equal(selectors["tool-row"], ARC005_PROBE_TARGETS["tool-row"].measurementSelector);
  assert.doesNotMatch(selectors.titlebar, /header/);
  assert.doesNotMatch(selectors.composer, /textarea/);
  assert.doesNotMatch(selectors["tool-row"], /data-testid\*='tool'/);
});

check("empty scene requires a mounted workspace shell", () => {
  const result = inspectScene("empty", new SyntheticDocument([workspaceMain([])]));
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceType, "real-content");
});

check("missing workspace shell cannot pass the empty scene", () => {
  const result = inspectScene("empty", new SyntheticDocument([]));
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "missing");
});

check("messages scene requires actual message text inside workspace-main", () => {
  const doc = new SyntheticDocument([
    workspaceMain([el("article", { "data-message-id": "m1" }, "视觉基线记录真实界面字体、颜色和几何")]),
  ]);
  const result = inspectScene("messages", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceType, "real-content");
  assert.equal(result.value.dataSource, "isolated-synthetic-data");
});

check("missing message text cannot pass the messages scene", () => {
  const result = inspectScene("messages", new SyntheticDocument([workspaceMain([])]));
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "missing");
});

check("message text outside workspace-main is wrong-container", () => {
  const doc = new SyntheticDocument([
    workspaceMain([]),
    el("aside", {}, "", [el("article", { "data-message-id": "wrong-pane" }, "视觉基线记录真实界面")]),
  ]);
  const result = inspectScene("messages", doc);
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "wrong-container");
});

check("project scene preserves real LeftBar content outside workspace-main", () => {
  const doc = new SyntheticDocument([
    workspaceMain([]),
    el("aside", { "data-testid": "workspace-sidebar" }, "视觉探针项目 A 视觉探针项目 B"),
  ]);
  const result = inspectScene("projects", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.fixture, "real-LeftBar");
});

check("parallel scene preserves real StreamSidebar content outside workspace-main", () => {
  const doc = new SyntheticDocument([
    workspaceMain([]),
    el("aside", { "data-testid": "workspace-sidebar" }, "并行会话 B 切换目标项目"),
  ]);
  const result = inspectScene("parallel", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.fixture, "real-StreamSidebar");
});

check("tool scene fails closed when only the rail lookalike exists", () => {
  const doc = new SyntheticDocument([
    workspaceMain([el("aside", { "data-testid": "tool-rail" }, "Tool palette")]),
  ]);
  const result = inspectScene("tools", doc);
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "wrong-container");
});

check("tool scene passes only with a real tool row", () => {
  const doc = new SyntheticDocument([workspaceMain([toolRow()])]);
  const result = inspectScene("tools", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceType, "real-content");
});

check("diff fixture passes as fixture-only, never as real product content", () => {
  const doc = new SyntheticDocument([
    fixturePanel("real-lineDiff-DiffView", [
      el("span", { class: "diff-add" }, "+added"),
      el("span", { class: "diff-del" }, "-removed"),
    ]),
  ]);
  const result = inspectScene("diff", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceType, "fixture-only");
  assert.equal(result.value.fixture, "real-lineDiff-DiffView");
});

check("diff fixture wrapper without expected rows is missing content", () => {
  const doc = new SyntheticDocument([fixturePanel("real-lineDiff-DiffView", [])]);
  const result = inspectScene("diff", doc);
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "missing");
});

check("old isolated workflow sidechat fixture does not count as actual sidechat UI", () => {
  const doc = new SyntheticDocument([fixturePanel("sidechat-partial", [
    el("div", { "data-testid": "arc005-sidechat-partial" }, "legacy fixture"),
  ])]);
  const result = inspectScene("sidechat", doc);
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "missing");
});

check("sidechat right panel without actual list cannot pass", () => {
  const doc = new SyntheticDocument([
    el("aside", { "data-cds-aside": "", "aria-hidden": "false" }, "", []),
  ]);
  const result = inspectScene("sidechat", doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SideChatPanel list/);
});

check("sidechat one fake row is insufficient", () => {
  const doc = new SyntheticDocument([
    el("aside", { "data-cds-aside": "", "aria-hidden": "false" }, "", [
      el("div", { "data-ui-sidechat-list": "" }, "", [
        el("li", { "data-ui-sidechat-row": "" }, "侧聊界面探针 A"),
      ]),
    ]),
  ]);
  const result = inspectScene("sidechat", doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /both isolated test sessions/);
});

check("two real side chat rows in right panel with sample data satisfy UI-only evidence", () => {
  const doc = new SyntheticDocument([
    el("aside", { "data-cds-aside": "", "aria-hidden": "false" }, "", [
      el("div", { "data-ui-sidechat-list": "" }, "", [
        el("li", { "data-ui-sidechat-row": "" }, "侧聊界面探针 A"),
        el("li", { "data-ui-sidechat-row": "" }, "侧聊界面探针 B"),
      ]),
    ]),
  ]);
  const result = inspectScene("sidechat", doc);
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceType, "real-content");
  assert.equal(result.value.fixture, "real-SideChatPanel");
});

check("narrow-window fixture cannot pass at the wrong viewport", () => {
  const doc = new SyntheticDocument([
    fixturePanel("stub-editor", [el("div", { "data-testid": "arc005-stub-editor" })]),
  ]);
  const result = inspectScene("narrow-window", doc, 1280);
  assert.equal(result.ok, false);
  assert.equal(result.value.sourceType, "fixture-only");
});

console.log("t5-visual-probe-integrity-smoke: " + (assertions - failures) + "/" + assertions + " PASS");
if (failures > 0) process.exitCode = 1;
