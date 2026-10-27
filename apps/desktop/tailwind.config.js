/** @type {import('tailwindcss').Config} */
export default {
  // 'class' so we can toggle dark mode by adding/removing `.dark` on <html>,
  // driven by nativeTheme.themeSource (see main/lib/theme.ts).
  darkMode: "class",
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontSize: {
        // 【T121】CDS 七档字阶（storybook `:659`）。**在此之前这个配置项完全不存在**
        // —— 于是全仓是三套并存：Tailwind 默认阶梯 471 处、硬写 px 657 处（12 个档位：
        // 7/8/9/9.5/10/10.5/11/11.5/12/12.5/13/15）、em 相对值 728 处。
        // 同一语义位置在不同文件里可能是 10px / 10.5px / 11px / text-xs(12px) 四种之一，
        // 这是「看起来不对劲但说不出哪不对」的主要来源。
        //
        // ⚠️ **这一档只建立体系，不迁移既有用法。** 657+728 处一次性迁移会让界面处于
        // 半改状态（一半对齐、一半没有），比现在更乱。迁移按区域分批做，见 T121 §1.7
        // 的「内容-字号矩阵」。
        //
        // 【UI 重建 2026-10-27】七档的值改成 **本机 Claude 3.1623.4.0 的真实值**。
        // 之前那套（11/12/12/14/15/16/20）比 Claude 大 15–35%，是「整屏文字偏大、
        // 怎么调都不像」的直接来源。
        //
        // Claude 的算法：`--cds-font-size-X: calc(Nrem × --cds-rem-scale)`，
        // 而 `--cds-rem-scale = calc(16/17) ≈ 0.9412`。所以 Nrem 的实际 px = N×16×0.9412。
        // 行高同理来自 `--cds-leading-X`，**与字号成对定义**（不是倍数）。
        //
        //   档位      字号源                实际 px   行高源                实际 px
        //   caption  .6875rem           11.29    1.0625rem           16.00
        //   footnote .75rem              11.29    —（同 caption）
        //   code     .75rem              11.29    —
        //   body     .8125rem            12.24    1.25rem             18.82
        //   prose    .875rem             13.18    1.125rem            16.94
        //   heading  .875rem             13.18    —（同 prose）
        //   title    1rem                15.06    1.25rem             18.82
        //
        // 写成 `lineHeight` 让 `text-body` 一处同时定死两者。
        //
        /* 【UI 重建 2026-10-27】**这一档必须与 `styles.css` 的 `--m-fs-*` / `--m-lh-*`
         * 逐字相同** —— 它们是同一个 Claude 值的两份表示。
         *
         * 我上一版把 caption/prose/title 三档算错了（见 styles.css 里那张对照表），
         * 而**改一处忘另一处**正是本仓反复出现的形态（第二十八条：「修不一致之前先数
         * 一共有几处」）。这里已经和第二处对齐。
         *
         * 校验：`.tmp/compare-with-claude.mjs` 直接读本机 Claude CSS 的声明，
         * 按 `Nrem × 16 × (16/17)` 算，和这里逐条比。 */
        caption: ["10.35px", { lineHeight: "16px" }], // 微型标签、Kbd、时间戳
        footnote: ["11.29px", { lineHeight: "14px" }], // 辅助说明、文件大小
        code: ["11.29px", { lineHeight: "16px" }], // 代码块、行内代码
        body: ["12.24px", { lineHeight: "18.82px" }], // 对话正文、输入框、表单
        prose: ["14.00px", { lineHeight: "16.94px" }], // 长文段落、Artifacts 正文（Claude 裸 .875rem）
        heading: ["13.18px", { lineHeight: "16.94px" }], // 卡片小节标题、弹窗标题
        title: ["18.82px", { lineHeight: "18.82px" }], // 主页面大标题
      },
      fontFamily: {
        // Bundled JetBrains Mono Variable woff2 (imported in main.tsx) heads
        // the monospace stack so every `font-mono` surface - code blocks,
        // terminals, file trees, diffs - renders a consistent modern face
        // across platforms, falling back to the OS monospace only if the
        // bundled font fails to load. The UI sans stack stays system-native
        // (defined in styles.css) for a native-feeling chrome.
        mono: [
          '"JetBrains Mono Variable"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          '"Liberation Mono"',
          '"Courier New"',
          "monospace",
        ],
      },
      colors: {
        // Semantic tokens backed by CSS variables. Each variable holds a
        // space-separated "R G B" triplet (NOT #hex) so Tailwind's
        // <alpha-value> placeholder can compose `bg-surface/50` etc.
        // Definitions live in styles.css (:root = light, .dark = dark).
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          hover: "rgb(var(--surface-hover) / <alpha-value>)",
          // 【T128】按下态。与 hover 分开是因为两者的语义不同：hover 是「指针
          // 在上面」，active 是「按住了」。共用一档时按下没有任何额外反馈（旧注释
          // 原文就写着「hover/active fills」）。取值范围与判据见 styles.css。
          active: "rgb(var(--surface-active) / <alpha-value>)",
          // 【T128】选中态底色。选中**不靠更深的灰**，而是靠「底色 + 品牌色文字
          // + font-medium」三件一起表达（上游 DraggableSessionList 的四态）。
          selected: "rgb(var(--selected-bg) / <alpha-value>)",
          // 【T121】Surface 0–3 阶梯的上两层。此前四层（主画布/卡片/浮层/弹窗）
          // 共用 --surface，层次只能靠边框和阴影撑 —— 这是「Claude 那边有纵深、
          // 我们这边平」的直接原因。值定义在 styles.css 的 :root / .dark。
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          overlay: "rgb(var(--surface-overlay) / <alpha-value>)",
        },
        content: {
          DEFAULT: "rgb(var(--content) / <alpha-value>)",
          muted: "rgb(var(--content-muted) / <alpha-value>)",
          subtle: "rgb(var(--content-subtle) / <alpha-value>)",
        },
        edge: {
          DEFAULT: "rgb(var(--edge) / <alpha-value>)",
          input: "rgb(var(--input-edge) / <alpha-value>)",
          panel: "rgb(var(--panel-edge) / <alpha-value>)",
          // T116: 选中态边框。--edge 在深色主题下等于 --surface-hover，
          // 用它画选中行边框等于没画。
          selected: "rgb(var(--selected-edge) / <alpha-value>)",
        },
        // DEFAULT = brand (buttons/icons/rings); strong = the small-TEXT
        // variant — light needs a 700 stop for the 4.5:1 AA bar, dark
        // mirrors DEFAULT (see --accent-strong in styles.css).
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          strong: "rgb(var(--accent-strong) / <alpha-value>)",
        },
        danger: "rgb(var(--danger) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        // Fixed semantic green (git additions etc.) — same value as the
        // DEFAULT accent but never overridden at runtime, so diff stats keep
        // their green when the user customizes the brand color.
        success: "rgb(var(--success) / <alpha-value>)",
        // User message bubble background — user-configurable color (default
        // = info token). Stored as an "R G B" triplet so the same
        // <alpha-value> mechanism composes bg-userBubble/10 etc. The value
        // is overridden at runtime via setProperty on <html> when the user
        // picks a custom color in Settings (see lib/appearance.ts).
        userBubble: "rgb(var(--user-bubble) / <alpha-value>)",
        // 【T128】选中态文字色（品牌色）。与 accent/accent-strong 分开是因为
        // 语义不同：那些是「品牌」，这个是「这一行被选中了」。
        selectedContent: "rgb(var(--selected-content) / <alpha-value>)",

        // Legacy pane tokens — kept as aliases to the new semantic variables
        // so partially-migrated files still follow the theme. New code should
        // use surface/edge directly.
        pane: {
          left: "rgb(var(--surface) / <alpha-value>)",
          center: "rgb(var(--surface-muted) / <alpha-value>)",
          right: "rgb(var(--surface) / <alpha-value>)",
          border: "rgb(var(--edge) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
