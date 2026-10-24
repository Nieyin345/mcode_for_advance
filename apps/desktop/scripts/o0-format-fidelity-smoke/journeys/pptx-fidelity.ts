/**
 * O0 旅程 5 —— PPTX 保真：改第二页一个文本框的字，多页 / 母版占位符 / 动画 /
 * 备注 / 图片必须逐项保留。
 *
 * ## 编辑入口：页面自己的 `slidesApi`（与 t7 slides 旅程同一条）
 *
 * t7 slides 旅程记录了**如实边界**：探针在离屏 WebContentsView 里用真鼠标驱动
 * Konva 画布不可靠（点击/拖动到达页面但命中路径不进入编辑）。所以 t7 与这里
 * 都用页面自己暴露的 `slidesApi.editText` —— 它与 `App.tsx` 的 `commitEdit`
 * 是同一条桥、同一个 vendor `slides:edit-text` 实现。保存点 Quick Access
 * 保存按钮（不可点时退回 `slidesApi.save()`，同一条 vendor `slides:save`）。
 *
 * ## 判据
 *
 * 基线指纹的元素清单里含「名字/占位符/几何」，编辑的是第二页那个文本框的
 * **正文**；正文不在指纹里（卡只要求证明「改 A 不坏 B」），但它的**几何与
 * 所在页**仍在 —— 若保存把元素挪走或删掉，清单会红。
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { O0 } from "../fixtures/build.js";
import { closeProduction, js, o0Setup, waitFor, waitForSaveToDisk, type O0Runtime } from "../setup.js";
import { compareAgainstBaseline, recordBaseline } from "../fidelity/compare.js";

const EDITED = `${O0.pptx.body}-EDITED`;

/**
 * 编辑的是第二页那个文本框（vendor 的 `spAutoFit` 会让它在改字后按内容收缩 ——
 * 见 `FingerprintOptions.pptxAutofitBox` 的注释）。只有它的 box 放宽；第二页
 * 的元素清单、其余页、动画、备注、媒体都照常逐项比对。
 */
const AUTOFIT: import("../fidelity/fingerprint.js").FingerprintOptions = {
  // 只放宽**第二页**那个被编辑的文本框的几何（autofit 语义）；其余页同名文本框照常比对。
  pptxAutofitBox: [{ slidePath: "ppt/slides/slide2.xml", name: "TextBox 2" }],
};

export const pptxFidelityJourney = defineU1Journey({
  name: "pptx-fidelity",
  launch: {
    window: false,
    size: { width: 1400, height: 950 },
    defaultTimeoutMs: 40_000,
    setup: o0Setup("pptx") as never,
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor(".app", "pp-app-mounted", { timeoutMs: 40_000 }),
    step.waitFor("[class*='thumb']", "pp-thumbnails-visible", { timeoutMs: 40_000 }),

    // ── 基线指纹 ──
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return recordBaseline(evidenceDir, "pptx", rt.fixtures.pptx, repoRoot, AUTOFIT);
    }, "pptx-baseline-fingerprint", { assert: true }),

    // ── 编辑：经页面自己的 slidesApi，把第二页文本框改成 EDITED ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      const edited = await js<{ ok: boolean; reason?: string; target?: unknown; error?: string }>(wc, `(async () => {
        try {
          const api = window.slidesApi;
          if (!api || typeof api.editText !== 'function' || typeof api.consumePendingOpen !== 'function') {
            return { ok: false, reason: 'slidesApi 缺 editText/consumePendingOpen' };
          }
          const tree = await api.consumePendingOpen(1280);
          if (!tree || !Array.isArray(tree.slides)) return { ok: false, reason: 'consumePendingOpen 没返回渲染树' };
          let target = null;
          tree.slides.forEach((slide, slideIndex) => {
            if (target) return;
            // 渲染节点的正文在 **text 布局树**里（RenderTextLayout：lines[].runs[].text），
            // 不是节点上的一个字符串字段。把布局树里所有 run 文本拼起来再匹配
            //（否则永远找不到 —— 实测形状见证据里 dump 的 text 字段）。
            const runText = (n) => {
              const out = [];
              const layout = n.text;
              for (const line of (layout && layout.lines) || []) {
                for (const run of line.runs || []) if (typeof run.text === 'string') out.push(run.text);
              }
              return out.join('');
            };
            const walk = (node) => {
              if (target || !node || typeof node !== 'object') return;
              if (typeof node.sourceId === 'string' && runText(node).includes(${JSON.stringify(O0.pptx.body)})) {
                target = { slideIndex, sourceId: node.sourceId };
                return;
              }
              (node.children ?? []).forEach(walk);
            };
            (slide.nodes ?? []).forEach(walk);
          });
          if (!target) {
            // 诊断：把每页的节点形状（type/sourceId/text 前 80 字符）带回证据。
            const dump = tree.slides.map((slide, si) => ({
              si,
              nodes: (slide.nodes ?? []).map((n) => ({ t: n.type, sid: n.sourceId, text: JSON.stringify(n.text ?? '').slice(0, 80) })),
            }));
            return { ok: false, reason: '渲染树里找不到第二页的正文文本框', dump };
          }
          const updated = await api.editText({
            slideIndex: target.slideIndex,
            sourceId: target.sourceId,
            paragraphs: [{ runs: [{ text: ${JSON.stringify(EDITED)} }] }],
          });
          if (!updated) return { ok: false, reason: 'editText 返回 null' };
          return { ok: true, target };
        } catch (e) { return { ok: false, error: String((e && e.stack) || e).slice(0, 400) }; }
      })()`);
      return edited.ok ? edited : { ok: false, observed: edited, detail: edited.reason ?? edited.error ?? JSON.stringify(edited) };
    }, "pp-edit-second-slide-text", { assert: true }),

    // 如实边界（与 t7 slides 旅程同一条）：`slidesApi.editText` 写进的是 vendor
    // 主进程会话，页面本地状态只在 `App.tsx` 的 commitEdit 里才跟着刷新 —— 我们
    // 直接调 API，页面侧大纲仍是旧文字。所以**不用页面大纲当判据**；编辑是否
    // 真的进了要保存的那份会话，由保存后的**磁盘独立读取**证明（下一步）。

    // ── 保存：Quick Access 保存按钮（不可点则退回页面自己的 slidesApi.save）──
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "slides 视图没有 webContents" };
      const attempt = await js<{ ok: boolean; path: string; disabled?: boolean }>(wc, `(async () => {
        const all = [...document.querySelectorAll('button.qa-btn')];
        const save = all.find((x) => /保存|Save/.test(x.getAttribute('aria-label') || ''));
        if (save && !save.hasAttribute('disabled')) {
          save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, path: 'button' };
        }
        const r = await window.slidesApi.save();
        return { ok: !!(r && r.ok), path: 'slidesApi.save', disabled: save ? save.hasAttribute('disabled') : null };
      })()`);
      return attempt.ok ? { ok: true, observed: attempt } : { ok: false, observed: attempt, detail: "保存入口调用失败" };
    }, "pp-save-invoked", { assert: true }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      return waitForSaveToDisk(evidenceDir, "pptx", rt.fixtures.pptx, 60_000);
    }, "pp-saved-to-disk", { assert: true }),

    // 独立核对（不经页面）：保存后的文件里，第二页是编辑后的正文、第一页标题仍在、
    // 动画/备注/图片各自的部件还在。这条证明「这次编辑真的落盘了」—— 否则后面
    // 的保真比对只证明「两份没编辑过的文件互相一致」。
    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const { spawnSync } = await import("node:child_process");
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      const cli = `${repoRoot}/genoffice/packages/cli/dist/genoffice.cjs`;
      const r = spawnSync(process.execPath, [cli, "slides", "read", rt.fixtures.pptx, "--full", "--json"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
      });
      if (r.status !== 0) return { ok: false, observed: r.stdout.slice(0, 400), detail: "独立 CLI 读取失败" };
      const detail = (JSON.parse(r.stdout) as { detail?: { pages?: Array<{ elements?: Array<{ text?: string }>; notes?: string }> } }).detail;
      const pages = detail?.pages ?? [];
      const texts = pages.map((p) => (p.elements ?? []).map((e) => e.text ?? "").join("\n"));
      // EDITED = body + "-EDITED"，所以「含 EDITED」已同时证明「旧正文被替换成
      // 新正文」；不要再拿 `!includes(body)` 判 —— 它当前缀恒真。
      const editedLanded = texts[1]?.includes(EDITED) === true;
      const notesKept = pages[0]?.notes === O0.pptx.notes;
      return editedLanded && notesKept
        ? { ok: true, observed: { slide2: texts[1]?.slice(0, 120), notesKept } }
        : { ok: false, observed: { slide2: texts[1] || null, notes: pages[0]?.notes ?? null }, detail: "保存后的文件没有包含这次编辑（或备注丢了）" };
    }, "pp-disk-has-edit-and-notes", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O0Runtime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (wc === null) return { ok: false, detail: "关闭前视图已消失" };
      return closeProduction(wc, rt.harness, rt.docId);
    }, "close-production-path", { assert: true }),

    step.relaunch("relaunch-after-close", "重开进程后重新打开同一 pptx，逐项比对复杂部件"),

    step.waitFor("[class*='thumb']", "pp-reopen-thumbnails", { timeoutMs: 40_000 }),
    step.run(async ({ runtime, evidenceDir }) => {
      const rt = runtime as O0Runtime;
      const repoRoot = process.env.MCODE_U1_REPO ?? "";
      return compareAgainstBaseline(evidenceDir, "pptx", rt.fixtures.pptx, repoRoot, AUTOFIT);
    }, "pptx-fidelity-compare", { assert: true }),
  ],
});
