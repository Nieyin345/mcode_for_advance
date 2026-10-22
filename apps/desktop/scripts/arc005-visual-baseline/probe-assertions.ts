export type ProbeContentState = "real-content" | "fixture-only" | "missing" | "wrong-container";

export interface ProbeLookalike {
  selector: string;
  scope?: "container" | "document";
}

export interface ProbeTargetSpec {
  containerSelector: string;
  selector: string;
  measurementSelector: string;
  fixtureSelector: string;
  lookalikes: readonly ProbeLookalike[];
}

export interface ProbeInspectionResult {
  state: ProbeContentState;
  ok: boolean;
  reason?: string;
}

export const ARC005_PROBE_TARGETS = {
  titlebar: {
    containerSelector: "body",
    selector: "[data-cds-titlebar]",
    measurementSelector: "[data-cds-titlebar]",
    fixtureSelector: "[data-testid='arc005-fixture-panel']",
    lookalikes: [{ selector: "header", scope: "document" }],
  },
  "tool-row": {
    containerSelector: "[data-testid='workspace-main']",
    selector: "button[class*='flex w-full items-center gap-2'][class*='py-1.5 text-left hover:bg-surface-muted/50']",
    measurementSelector: "[data-testid='workspace-main'] button[class*='flex w-full items-center gap-2'][class*='py-1.5 text-left hover:bg-surface-muted/50']",
    fixtureSelector: "[data-testid='arc005-fixture-panel']",
    lookalikes: [{ selector: "[data-testid*='tool']", scope: "container" }],
  },
  composer: {
    containerSelector: "[data-testid='workspace-main']",
    selector: ".composer-host .composer-prose[contenteditable='true'][aria-label]",
    measurementSelector: "[data-testid='workspace-main'] .composer-host .composer-prose[contenteditable='true'][aria-label]",
    fixtureSelector: "[data-testid='arc005-fixture-panel']",
    lookalikes: [{ selector: "textarea", scope: "document" }],
  },
} satisfies Record<string, ProbeTargetSpec>;

export type ProbeTargetName = keyof typeof ARC005_PROBE_TARGETS;

export const ARC005_MEASURE_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["titlebar", ARC005_PROBE_TARGETS.titlebar.measurementSelector],
  ["sidebar", "[data-testid='workspace-sidebar']"],
  ["sidebar-row", "[data-testid='workspace-sidebar'] button"],
  ["main", "[data-testid='workspace-main']"],
  ["message", "[data-testid='workspace-main'] .prose, [data-testid='workspace-main'] [data-message-id]"],
  ["tool-row", ARC005_PROBE_TARGETS["tool-row"].measurementSelector],
  ["composer", ARC005_PROBE_TARGETS.composer.measurementSelector],
  ["approval", "[role='alertdialog']"],
  ["card", "[data-testid='workspace-main'] [class*='rounded']"],
  ["button", "button"],
  ["panel", "[data-testid='workspace-sidebar'], [data-testid='right-panel']"],
  ["settings", ".settings-root"],
  ["terminal", ".xterm, [data-testid='bottom-terminal-bar']"],
  ["editor", ".monaco-editor"],
  ["preview", "[data-testid='arc005-real-markdown'], [data-testid*='preview'], [class*='pdf-preview']"],
  ["fixture", "[data-testid='arc005-fixture-panel']"],
];

export function inspectVisualProbeTarget(
  doc: Document,
  spec: ProbeTargetSpec,
): ProbeInspectionResult {
  const visible = (element: Element | null | undefined): boolean =>
    !!element && (typeof element.getClientRects !== "function" || element.getClientRects().length > 0);
  const find = (root: ParentNode | null | undefined, selector: string): Element | null => {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    try {
      return Array.from(root.querySelectorAll(selector)).find(visible) ?? null;
    } catch {
      return null;
    }
  };
  const hasAncestor = (element: Element | null, selector: string): boolean => {
    let current = element;
    while (current) {
      try {
        if (typeof current.matches === "function" && current.matches(selector)) return true;
      } catch {
        // Invalid selectors must never turn a probe into a pass.
        return false;
      }
      current = current.parentElement;
    }
    return false;
  };
  const within = (element: Element, ancestor: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentElement;
    }
    return false;
  };

  const container = doc?.querySelector?.(spec.containerSelector) ?? null;
  if (!container || !visible(container)) {
    return { state: "missing", ok: false, reason: "expected container is missing: " + spec.containerSelector };
  }

  const target = find(container, spec.selector);
  if (target) {
    if (hasAncestor(target, spec.fixtureSelector)) {
      return { state: "fixture-only", ok: false, reason: "target exists only inside a visual fixture" };
    }
    return { state: "real-content", ok: true };
  }

  const targetOutsideContainer = find(doc, spec.selector);
  if (targetOutsideContainer && !within(targetOutsideContainer, container)) {
    if (hasAncestor(targetOutsideContainer, spec.fixtureSelector)) {
      return { state: "fixture-only", ok: false, reason: "target exists only inside a visual fixture outside the expected container" };
    }
    return { state: "wrong-container", ok: false, reason: "target exists outside its expected container" };
  }

  for (const lookalike of spec.lookalikes) {
    const scope = lookalike.scope === "document" ? doc : container;
    const candidate = find(scope, lookalike.selector);
    if (!candidate) continue;
    if (hasAncestor(candidate, spec.fixtureSelector)) {
      return { state: "fixture-only", ok: false, reason: "only a fixture/lookalike is present: " + lookalike.selector };
    }
    return { state: "wrong-container", ok: false, reason: "only a non-semantic lookalike is present: " + lookalike.selector };
  }

  return { state: "missing", ok: false, reason: "expected semantic content is missing: " + spec.selector };
}

export function inspectSceneContent(
  doc: Document,
  scene: string,
  targets: typeof ARC005_PROBE_TARGETS,
  inspectTarget: typeof inspectVisualProbeTarget,
  viewportWidth: number,
): { ok: boolean; reason?: string; value?: Record<string, unknown> } {
  const fixtureSelector = "[data-testid='arc005-fixture-panel']";
  const visible = (element: Element | null | undefined): boolean =>
    !!element && (typeof element.getClientRects !== "function" || element.getClientRects().length > 0);
  const queryVisible = (root: ParentNode | null | undefined, selector: string): Element | null => {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    try {
      return Array.from(root.querySelectorAll(selector)).find(visible) ?? null;
    } catch {
      return null;
    }
  };
  const isInsideFixture = (element: Element | null): boolean => {
    let current = element;
    while (current) {
      try {
        if (typeof current.matches === "function" && current.matches(fixtureSelector)) return true;
      } catch {
        return false;
      }
      current = current.parentElement;
    }
    return false;
  };
  const productPass = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    value: { sourceType: "real-content", fixture: "real-app", dataSource: "isolated-synthetic-data", ...extra },
  });
  const fixturePass = (fixture: string) => ({
    ok: true,
    value: { sourceType: "fixture-only", fixture },
  });
  const fail = (
    sourceType: ProbeContentState,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => ({ ok: false, reason, value: { sourceType, ...extra } });
  const main = doc?.querySelector?.("[data-testid='workspace-main']") ?? null;

  if (scene === "empty") {
    return visible(main)
      ? productPass()
      : fail("missing", "real workspace shell is missing");
  }

  if (scene === "messages") {
    const expectedText = "视觉基线记录真实界面";
    const mainText = String(main?.textContent ?? "");
    if (mainText.includes(expectedText)) {
      const fixture = queryVisible(main, fixtureSelector);
      return fixture && String(fixture.textContent ?? "").includes(expectedText)
        ? fail("fixture-only", "message text is fixture-only")
        : productPass();
    }
    if (String(doc?.body?.textContent ?? "").includes(expectedText)) {
      return fail("wrong-container", "expected message text exists outside workspace-main");
    }
    return fail("missing", "expected message content is missing from workspace-main");
  }

  if (scene === "tools") {
    const inspected = inspectTarget(doc, targets["tool-row"]);
    return inspected.state === "real-content"
      ? productPass({ targetState: inspected.state })
      : fail(inspected.state, inspected.reason ?? "real tool row was not found", { targetState: inspected.state });
  }

  if (scene === "approval") {
    const dialog = queryVisible(doc, "[role='alertdialog']");
    if (!dialog) return fail("missing", "approval alertdialog is missing");
    return isInsideFixture(dialog)
      ? fail("fixture-only", "approval dialog is fixture-only")
      : productPass();
  }

  if (scene === "diff" || scene === "terminal" || scene === "editor" || scene === "preview" || scene === "sidechat") {
    const panel = queryVisible(doc, fixtureSelector);
    if (!panel) return fail("missing", "expected visual fixture panel is missing");
    const kind = panel.getAttribute?.("data-arc-fixture") ?? "";
    const expectedKinds: Record<string, string> = {
      diff: "real-lineDiff-DiffView",
      terminal: "static-terminal",
      editor: "stub-editor",
      preview: "real-markdown-renderer",
      sidechat: "sidechat-partial",
    };
    if (kind !== expectedKinds[scene]) {
      return fail("wrong-container", "fixture kind does not match the requested scene", { fixture: kind });
    }

    if (scene === "sidechat") {
      const wrapper = queryVisible(panel, "[data-testid='arc005-sidechat-partial']");
      if (!wrapper) return fail("missing", "sidechat wrapper is missing", { fixture: kind });
      if (queryVisible(wrapper, "[data-sidechat-partial='error']")) {
        return fail("fixture-only", "sidechat child rendered its error boundary; wrapper presence is not health", {
          fixture: kind,
          partial: true,
        });
      }
      if (!queryVisible(wrapper, "[data-node-card]")) {
        return fail("fixture-only", "sidechat wrapper is present but no workflow-node content was rendered", {
          fixture: kind,
          partial: true,
        });
      }
      return fail("fixture-only", "sidechat is still an isolated fixture without live workflow IPC/data", {
        fixture: kind,
        partial: true,
      });
    }

    const expectedContent: Record<string, string[]> = {
      diff: [".diff-add", ".diff-del"],
      terminal: ["[data-testid='arc005-static-terminal']"],
      editor: ["[data-testid='arc005-stub-editor'] code"],
      preview: ["[data-testid='arc005-real-markdown'] strong"],
    };
    const contentSelectors = expectedContent[scene] ?? [];
    const contentExists = contentSelectors.length > 0 && contentSelectors.every((selector) => !!queryVisible(panel, selector));
    if (!contentExists) return fail("missing", "fixture wrapper exists but expected fixture content is missing", { fixture: kind });
    return fixturePass(kind);
  }

  if (scene === "parallel") {
    return String(doc?.body?.textContent ?? "").includes("并行会话 B") &&
      String(doc?.body?.textContent ?? "").includes("切换目标项目")
      ? productPass({ fixture: "real-StreamSidebar" })
      : fail("missing", "real StreamSidebar content is missing");
  }

  if (scene === "projects") {
    return String(doc?.body?.textContent ?? "").includes("视觉探针项目 A") &&
      String(doc?.body?.textContent ?? "").includes("视觉探针项目 B")
      ? productPass({ fixture: "real-LeftBar" })
      : fail("missing", "real project-tree content is missing");
  }

  if (scene === "settings") {
    const settings = queryVisible(doc, ".settings-root");
    if (!settings) return fail("missing", "settings root is missing");
    return isInsideFixture(settings)
      ? fail("fixture-only", "settings root exists only inside a visual fixture")
      : productPass();
  }

  if (scene === "narrow-window") {
    const panel = queryVisible(doc, fixtureSelector);
    const editor = queryVisible(panel, "[data-testid='arc005-stub-editor']");
    if (viewportWidth > 1024) {
      return fail("fixture-only", "requested narrow viewport was not reached", {
        fixture: "stub-editor+real-layout",
        viewportWidth,
      });
    }
    if (!editor) {
      return fail("missing", "narrow-window editor fixture is missing", {
        fixture: "stub-editor+real-layout",
        viewportWidth,
      });
    }
    return fixturePass("stub-editor+real-layout");
  }

  return fail("missing", "unknown or unsupported scene: " + scene);
}

export function buildTargetInspectionScript(name: ProbeTargetName): string {
  return "(" + inspectVisualProbeTarget.toString() + ")(document, " +
    JSON.stringify(ARC005_PROBE_TARGETS[name]) + ")";
}

export function buildSceneAssertionScript(scene: string): string {
  return "(" + inspectSceneContent.toString() + ")(document, " +
    JSON.stringify(scene) + ", " +
    JSON.stringify(ARC005_PROBE_TARGETS) + ", " +
    "(" + inspectVisualProbeTarget.toString() + "), window.innerWidth)";
}
