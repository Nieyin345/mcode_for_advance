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
    selector: "button[data-ui-tool-row],button[data-ui-tool-summary]",
    measurementSelector: "[data-testid='workspace-main'] button[data-ui-tool-row], [data-testid='workspace-main'] button[data-ui-tool-summary]",
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
  /* 【UI 重建 2026-10-28】同上：`button` 命中的是**第一个按钮**（顶部图标
   * 行里的 `☰`，28×28），不是会话行。会话行有显式属性 `data-session-row`。 */
  ["sidebar-row", "[data-testid='workspace-sidebar'] [data-session-row]"],
  ["main", "[data-testid='workspace-main']"],
  ["message", "[data-testid='workspace-main'] .prose, [data-testid='workspace-main'] [data-message-id]"],
  // 【T149】`message` 命中的是**外层容器**（`.prose` 容器，16px/24px 继承值），
  // 不是正文本身。正文是 `.chat-md`（`Markdown.tsx:912`），它的字号/行高来自
  // `--chat-font-size` / `--chat-md-leading`。
  //
  // 没有这一项时，**任何正文排版改动在基线 JSON 里完全不可见** —— T147 把行高
  // 从 21.75px 改到 24.375px，PNG 变了，JSON 一个字段没变。全 51 格共享这个盲区。
  //
  // 场景里没有正文（空态/设置/纯面板）时这一项是 `present: false`，**显式缺席**，
  // 不是静默跳过 —— 见 compare.mjs 的 measured 比对。
  /* 【UI 重建 2026-10-27】**这条选择器原本量错了元素。**
   *
   * 原来写 `[data-testid='workspace-main'] .chat-md` —— 取**第一个** `.chat-md`。
   * 而用户气泡自己也有 `.chat-md`（MessageRow 的 `data-cds="UserBubble"` 里），
   * 并且它把 `--chat-font-size` 覆盖成 `calc(base - 0.5px)`（气泡文字略小）。
   * 场景里 user/assistant 交替，第一个常常是用户气泡 —— 于是量到 11.74px，
   * 而期望是助手的 12.24px，报「未登记差异」。
   *
   * **这是第三十三条规定的那种失效**：判据在跑、返回了合理的数字，
   * 但量的不是它声称的那个元素。所以显式排除用户气泡，量真正的助手正文。 */
  ["chat-body", "[data-testid='workspace-main'] [data-message-id]:not([data-cds='UserBubble']) .chat-md"],
  ["tool-row", ARC005_PROBE_TARGETS["tool-row"].measurementSelector],
  ["composer", ARC005_PROBE_TARGETS.composer.measurementSelector],
  ["approval", "[role='alertdialog']"],
  /* 【UI 重建 2026-10-28】**这条选择器量错了元素。**
   *
   * 原来写 `[data-testid='workspace-main'] [class*='rounded']` —— 任何带
   * `rounded` 的元素都命中，第一个是**按钮**。实测 `card` 报 `28×28`，
   * 而卡片应该是几百 px 宽。
   *
   * 这是第三十三条规定的那种失效（判据在跑、返回了合理的数字，但量的
   * 不是它声称的那个元素）。改用**显式语义属性** `data-cds="Card"` ——
   * `ClaudeProjectOverview` 里每张概览卡片都有它。
   *
   * 场景里没有卡片（对话态）时 `present: false`，显式缺席而不是静默跳过。 */
  ["card", "[data-cds='Card']"],
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

  if (scene === "tab-overflow") {
    const list = queryVisible(doc, "[data-ui-center-pane] [role='tablist']");
    const tabs = Array.from(list?.querySelectorAll("[role='tab']") ?? []).filter(visible);
    if (tabs.length < 32) return fail("missing", "overflow tablist contains too few actual session tabs");
    const selected = tabs.filter(tab => tab.getAttribute("aria-selected") === "true");
    if (selected.length !== 1) return fail("missing", "overflow tablist has no unique selected tab");
    return productPass({fixture:"real-UnifiedTabsBar",totalTabs:tabs.length});
  }

  if (scene === "long-chat") {
    const root = queryVisible(doc, "[data-chat-root]");
    const rendered = root?.querySelectorAll("[data-message-id]").length ?? 0;
    if (!root || rendered < 1) return fail("missing", "real long-chat has no visible rows");
    if (rendered > 160) return fail("missing", "long-chat rendered too many rows: virtual list may be disabled");
    return productPass({ fixture:"real-ChatPane-LegendList", rendered });
  }

  if (scene === "approval") {
    const dialog = queryVisible(doc, "[role='alertdialog']");
    if (!dialog) return fail("missing", "approval alertdialog is missing");
    return isInsideFixture(dialog)
      ? fail("fixture-only", "approval dialog is fixture-only")
      : productPass();
  }

  if (scene === "sidechat") {
    const aside = queryVisible(doc, "[data-cds-aside][aria-hidden='false']");
    if (!aside) return fail("missing", "right panel is not visible for sidechat");
    const list = queryVisible(aside, "[data-ui-sidechat-list]");
    if (!list || isInsideFixture(list)) {
      return fail(list ? "fixture-only" : "missing", "real SideChatPanel list is not rendered in right panel");
    }
    const rows = Array.from(list.querySelectorAll("[data-ui-sidechat-row]")).filter(visible);
    const titles = rows.map(el => String(el.textContent ?? ""));
    if (rows.length < 2 ||
      !titles.some(t => t.includes("侧聊界面探针 A")) ||
      !titles.some(t => t.includes("侧聊界面探针 B"))) {
      return fail("missing", "real SideChatPanel lacks both isolated test sessions");
    }
    return productPass({ fixture: "real-SideChatPanel", verifiedRows: rows.length });
  }

  if (scene === "diff" || scene === "terminal" || scene === "editor" || scene === "preview") {
    const panel = queryVisible(doc, fixtureSelector);
    if (!panel) return fail("missing", "expected visual fixture panel is missing");
    const kind = panel.getAttribute?.("data-arc-fixture") ?? "";
    const expectedKinds: Record<string, string> = {
      diff: "real-lineDiff-DiffView",
      terminal: "static-terminal",
      editor: "stub-editor",
      preview: "real-markdown-renderer",
    };
    if (kind !== expectedKinds[scene]) {
      return fail("wrong-container", "fixture kind does not match the requested scene", { fixture: kind });
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

  /* 【T136】四个「我们独有」的场景。它们全是右栏的页签，判据是同一件事：
     **右栏真的渲染出那个面板的内容了**，而不是只开了一个空壳。

     ⚠️ 这里只用 dom 级证据（文字/元素存在），**不写 visual 断言** —— 第一次
     拍下来的就是基线本身，没有「应该长什么样」可言。 */
  if (scene === "files-pane" || scene === "git-pane" || scene === "taskcenter" || scene === "workflow-board" || scene === "overview-pane" || scene === "terminal-pane" || scene === "sidechat-pane") {
    const right = queryVisible(doc, "[data-cds-aside]");
    if (!right) return fail("missing", "右栏没有打开（[data-cds-aside] 不在 DOM 里）");
    if (isInsideFixture(right)) return fail("fixture-only", "右栏是夹具，不是真实面板");
    const rightText = String(right.textContent ?? "");

    if (scene === "terminal-pane") {
      /* 【UI 重建 2026-10-27】右栏终端。
       *
       * 判据分两半，**权重不同**：
       *
       *   1. **tile 映射**（硬判据）：`data-pane-title` 必须是 `terminal`。
       *      这一半能证明「页签 → tile → 面板」这条链走对了，而不是
       *      fallback 到文件树后碰巧也有别的东西。
       *   2. **xterm 挂载**（软判据）：右栏里有 `.xterm` / `[data-terminal-id]`。
       *
       * ⚠️ 第 2 条**不能单独当失败判据**。实测（2026-10-27）：
       * 同一场景三格，light 那格 `hasXterm=false`、dark 与 narrow 都是 true。
       * 原因是 **xterm 懒加载 + 首格冷启动** —— light 是这一轮第一次拍，
       * 模块还没 eval 完；后两格复用了已加载的模块。
       *
       * 第一版把第 2 条写成硬失败，于是**首格必红**而其余绿 —— 那是
       * 「判据测的是加载时序，不是产品」的典型形态。现在改成：
       * 第 2 条只**记录**不判死，失败条件只剩第 1 条 + 「右栏里有东西」。
       *
       * 桩环境里没有真 PTY，终端本来就该是一个空壳；断言「有输出」
       * 或「有 xterm」都会把正确的空判成失败。 */
      const hasXterm = !!right.querySelector(".xterm, .xterm-viewport, [data-terminal-id], [data-testid*='terminal' i]");
      const tabs = [...doc.querySelectorAll("[data-pane-title]")].map((e) => String(e.getAttribute("data-pane-title") ?? ""));
      const mapped = tabs.includes("terminal");
      // 「右栏里有内容」—— 排除「tile 标题对了但面板整体没渲染」。
      const hasBody = right.textContent !== null && right.children.length > 0;
      return mapped && hasBody
        ? productPass({ panel: "terminal", mapped, xterm: hasXterm })
        : fail("missing", "右栏终端没有挂上（tile 映射或面板渲染）", { mapped, hasXterm, hasBody, tabs });
    }

    if (scene === "sidechat-pane") {
      /* 【UI 重建 2026-10-27】右栏侧聊。
       *
       * 桩给了 `sideChatsByParent.s1` 一个侧聊列表，所以面板里应该有
       * 桩里那些会话的标题。断言「至少有一行侧聊」而不是精确文案 ——
       * 文案会随 i18n 变，行数才是结构判据。 */
      const tabs = [...doc.querySelectorAll("[data-pane-title]")].map((e) => String(e.getAttribute("data-pane-title") ?? ""));
      const mapped = tabs.includes("sidechat");
      // 面板里的可点会话行（桩数据）—— 侧聊列表项带 data-side-chat-row 最好，
      // 没有就退回「右栏里有非空文本」。
      const rows = right.querySelectorAll("[data-side-chat-row]").length;
      const hasText = rightText.trim().length > 0;
      return mapped && (rows > 0 || hasText)
        ? productPass({ panel: "sidechat", mapped, rows })
        : fail("missing", "右栏侧聊没有挂上，或没有渲染出内容", { mapped, rows, hasText });
    }

    if (scene === "overview-pane") {
      /* 【UI 重建 2026-10-27】项目概览面板。
       *
       * 要求五张卡片的标题都在。这几句话是**面板自己的静态文案**
       * （不是桩数据），所以它们的缺失只可能是「面板没渲染」——
       * 正是这一格要抓的东西。
       *
       * ⚠️ 不要在这里断言「Context 显示 xx%」或「Connectors 有几个」：
       * 那两个依赖会话/桩数据，空会话下**本来就该是空态**。断言它们
       * 会把「正确的空」判成失败。 */
      const cards = ["Environment", "Context", "Connectors", "Outputs", "Changes"];
      const present = cards.filter((c) => rightText.includes(c));
      return present.length === cards.length
        ? productPass({ panel: "overview", cards: present.length })
        : fail("missing", "概览面板的五张卡片没有全部渲染", {
            got: present,
            want: cards,
          });
    }

    if (scene === "files-pane") {
      // 桩给了两层目录：顶层 src/docs/README.md/package.json。
      const hasFile = rightText.includes("README.md") || rightText.includes("package.json");
      const hasDir = rightText.includes("src") || rightText.includes("docs");
      return hasFile && hasDir
        ? productPass({ panel: "files" })
        : fail("missing", "文件树没有渲染出桩里的目录/文件", { hasFile, hasDir });
    }

    if (scene === "git-pane") {
      // 桩给了一个仓库 + 三个改动文件。
      const hasRepo = rightText.includes("arc005-fixture-repo");
      const changed = ["index.ts", "app.ts", "guide.md"].filter((n) => rightText.includes(n)).length;
      return hasRepo && changed >= 2
        ? productPass({ panel: "git", changed })
        : fail("missing", "Git 面板没有渲染出桩里的仓库/改动文件", { hasRepo, changed });
    }

    if (scene === "taskcenter") {
      // 桩给了三个任务，其中一个是 failed。
      const goals = ["季度数据", "导出模块", "表格超宽"].filter((g) => rightText.includes(g)).length;
      return goals >= 2
        ? productPass({ panel: "taskcenter", goals })
        : fail("missing", "任务中心没有渲染出桩里的任务", { goals });
    }

    // workflow-board：运行中的工作流节点看板。桩不提供运行中的节点，
    // 所以这一格**只要求右栏与流页签挂载**，不要求有节点 —— 没有节点是
    // 正确状态（没在跑就没有正在跑的节点），不是缺陷。
    const flowMounted = !!queryVisible(doc, "[data-pane-flow], [data-cds-aside]");
    return flowMounted
      ? productPass({ panel: "flow", note: "no running nodes is the correct empty state" })
      : fail("missing", "流页签没有挂载");
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
