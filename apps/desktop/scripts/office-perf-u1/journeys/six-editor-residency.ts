/**
 * Optional real-Electron Office residency benchmark.
 *
 * Six true editor renderers are opened sequentially in ONE Mcode OS process,
 * retaining every hidden editor to protect unsaved state. Uses the original
 * vendor preload/renderer/main and the production DocumentViewHost.
 *
 * This is a diagnostic baseline, not a performance regression gate: machine
 * load, warm OS cache and fixture size are not controlled across runs.
 */
import { app, BrowserWindow } from "electron";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, editorUrl, invokeAs, js, waitFor, type EditorKind, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";

type Stage = {
  editor: EditorKind;
  elapsedMs: number;
  nativeRendererPid: number;
  nativeRendererWorkingSetKiB: number;
  hostRssBytes: number;
  liveViews: number;
  electronProcessCount: number;
  electronWorkingSetKiB: number;
  browserWindowCount: number;
};
type PerfRuntime = EditorRuntime & {
  sessionStartMs: number;
  stages: Stage[];
  activeDocId: string;
  originalWindows: number;
};

const MARKERS: Record<EditorKind, string> = {
  docs: ".ProseMirror",
  sheets: "#univer-container canvas",
  slides: ".app",
  pdf: ".app",
  markdown: ".app",
  html: ".app",
};
const ORDER: EditorKind[] = ["slides", "pdf", "markdown", "html", "docs"];

async function snapshot(rt: PerfRuntime, editor: EditorKind, docId: string, elapsedMs: number): Promise<Stage> {
  const wc = rt.harness.webContentsOf(docId);
  if (!wc) throw new Error("Cannot sample a destroyed editor: " + docId);
  const metrics = app.getAppMetrics();
  const rendererPid = wc.getOSProcessId();
  const renderer = metrics.find(p => p.pid === rendererPid);
  return {
    editor,
    elapsedMs: Math.round(elapsedMs),
    nativeRendererPid: rendererPid,
    nativeRendererWorkingSetKiB: renderer?.memory?.workingSetSize ?? 0,
    hostRssBytes: process.memoryUsage().rss,
    liveViews: rt.harness.host.list().length,
    electronProcessCount: metrics.length,
    electronWorkingSetKiB: metrics.reduce((total, p) => total + (p.memory?.workingSetSize ?? 0), 0),
    browserWindowCount: BrowserWindow.getAllWindows().length,
  };
}

const sheetSetup = editorSetup("sheets");
export const sixEditorResidencyJourney = defineU1Journey({
  name: "six-editor-residency",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 50_000,
    setup: async (ctx) => {
      const start = performance.now();
      const setup = await sheetSetup(ctx);
      const rt = setup.runtime as PerfRuntime;
      rt.sessionStartMs = start;
      rt.stages = [];
      rt.activeDocId = rt.docId;
      rt.originalWindows = BrowserWindow.getAllWindows().length;
      return setup;
    },
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      const original = await snapshot(rt, "sheets", rt.docId, performance.now() - rt.sessionStartMs);
      rt.stages.push(original);
      return {
        ok: original.liveViews === 1 && original.nativeRendererPid > 0 &&
          original.nativeRendererWorkingSetKiB > 0,
        observed: original,
      };
    }, "sheets-initial-footprint", { assert: true }),

    ...ORDER.map((kind) => step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      const start = performance.now();
      const previous = rt.activeDocId;
      const paused = rt.harness.host.hide(previous);
      const docId = "office-resident-" + kind;
      const opened = rt.harness.host.open({
        docId,
        url: editorUrl(kind),
        ...(kind === "docs" ? {} : { editor: kind, filePath: rt.fixtures[kind] }),
        visible: true,
        bounds: { x: 0, y: 0, width: 1280, height: 900 },
        mcodeSessionId: "office-residency-session",
      });
      if (!opened.ok) return { ok: false, detail: "Mcode failed to attach " + kind + ": " + opened.reason };
      const wc = rt.harness.webContentsOf(docId);
      if (!wc) return { ok: false, detail: "Mcode lost native webContents for " + kind };
      const mounted = await waitFor(async () => await js<boolean>(wc, "!!document.querySelector(" + JSON.stringify(MARKERS[kind]) + ")"), 45_000, 280);
      if (mounted !== true) {
        return { ok: false, detail: kind + " native renderer failed to mount its editor surface" };
      }
      if (kind === "docs") {
        const sent = await invokeAs(wc, rt.harness, "documentView:openPath", {
          docId, filePath: rt.fixtures.docs,
        }) as { ok: boolean; reason?: string };
        if (!sent.ok) return { ok: false, detail: "Docs real openPath failed: " + sent.reason };
        const openedDoc = await waitFor(async () => rt.harness.host.sessionFor(docId), 30_000, 300);
        if (!openedDoc) return { ok: false, detail: "Docs opened no committed Mcode file session" };
      }
      rt.activeDocId = docId;
      const sample = await snapshot(rt, kind, docId, performance.now() - start);
      rt.stages.push(sample);
      return {
        ok: paused.ok && sample.liveViews === rt.stages.length &&
          sample.browserWindowCount === rt.originalWindows &&
          sample.nativeRendererPid > 0 &&
          sample.nativeRendererWorkingSetKiB > 0,
        observed: sample,
        detail: sample.browserWindowCount !== rt.originalWindows
          ? "Office unexpectedly opened a second BrowserWindow" : undefined,
      };
    }, "open-" + kind + "-within-one-mcode-host", { assert: true })),

    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      // Hidden Sheets must stay alive and retain its original webContents id.
      const before = rt.webContentsId;
      const shown = rt.harness.host.show(rt.docId);
      const wc = rt.harness.webContentsOf(rt.docId);
      const stillReady = wc
        ? await waitFor(() => js<boolean>(wc, "!!document.querySelector('#univer-container canvas')"), 15_000, 200)
        : null;
      const restored = wc?.id === before && stillReady === true;
      const metrics = rt.stages.map(s => ({ editor:s.editor, ms:s.elapsedMs, pid:s.nativeRendererPid, rendererKiB:s.nativeRendererWorkingSetKiB, electronTotalKiB:s.electronWorkingSetKiB }));
      return {
        ok: shown.ok && restored && rt.harness.host.list().length === 6,
        observed: { restored, reusedWebContentsId: wc?.id, originally: before, rendererFootprints: metrics,
          currentElectronProcesses: app.getAppMetrics().length, mainRssBytes: process.memoryUsage().rss },
      };
    }, "switch-back-to-hidden-sheets-without-reinitialization", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      const observed: Record<string, unknown> = {};
      let ok = true;
      for (const kind of ["slides", "docs"] as const) {
        const wc = rt.harness.webContentsOf("office-resident-" + kind);
        if (!wc) return { ok: false, detail: "missing editor for resource audit: " + kind };
        const resources = await js<{ host: boolean; aiChunks: string[]; sourceChunks: string[]; trackedResourceCount: number }>(
          wc,
          `(() => {
            const urls = performance.getEntriesByType('resource').map(e => e.name);
            return {
              host: /\\bMcode\\//.test(navigator.userAgent),
              aiChunks: [
                ...urls,
                ...[...document.scripts].map(s => s.src),
              ].filter(url => /\\/AiPanel-[^/]+\\.js(?:\\?|$)/.test(url)),
              // Chromium does not necessarily record the entry module in
              // PerformanceResourceTiming; the DOM script source is
              // authoritative evidence that the normal editor did load.
              sourceChunks: [...document.scripts].map(s => s.src)
                .filter(url => /\\/index-[^/]+\\.js(?:\\?|$)/.test(url)),
              trackedResourceCount: urls.length,
            };
          })()`,
        );
        observed[kind] = resources;
        // Chromium may omit local app/file module fetches entirely from
        // Resource Timing (trackedResourceCount can be zero). This verifies
        // a Mcode host editor mounted its main entry and no AI chunk was
        // observed, NOT a complete network trace. Build split is verified
        // independently from the production bundle output.
        ok = ok && resources.host && resources.aiChunks.length === 0 && resources.sourceChunks.length > 0;
      }
      return {
        ok,
        observed,
        detail: ok ? undefined : "Mcode Office view did not mount the expected main entry or observed an unexpected AI chunk",
      };
    }, "mcode-docs-slides-use-main-entry-without-observed-ai-chunk", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      // AppMetrics is sampled twice; CPU percentage from one isolated sample
      // is not a usable "steady-state CPU" claim.
      const before = app.getAppMetrics();
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const after = app.getAppMetrics();
      const tracked = rt.stages.map(stage => {
        const current = rt.harness.webContentsOf(
          stage.editor === "sheets" ? rt.docId : "office-resident-" + stage.editor,
        );
        return {
          editor: stage.editor,
          processPid: current?.getOSProcessId() ?? 0,
          originalPid: stage.nativeRendererPid,
          alive: current !== null,
        };
      });
      return {
        ok: tracked.length === 6 &&
          tracked.every(item => item.alive && item.processPid === item.originalPid) &&
          rt.harness.host.list().length === 6 &&
          BrowserWindow.getAllWindows().length === rt.originalWindows,
        observed: {
          samplesMs: 3000,
          residentEditors: tracked,
          processCountBefore: before.length,
          processCountAfter: after.length,
          workingSetKiBBefore: before.reduce((total,p) => total+(p.memory?.workingSetSize ?? 0),0),
          workingSetKiBAfter: after.reduce((total,p) => total+(p.memory?.workingSetSize ?? 0),0),
          cpuPercentByProcess: after.map(p => ({ pid:p.pid, kind:p.type, cpu:p.cpu?.percentCPUUsage ?? null })),
          hostRssBytes: process.memoryUsage().rss,
        },
      };
    }, "six-resident-editors-remain-alive-with-background-cpu-sample", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRuntime;
      const documents = [...rt.harness.host.list()];
      const results = documents.map((entry) => ({
        docId: entry.docId,
        result: rt.harness.host.close(entry.docId),
      }));
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return {
        ok: results.every(item => item.result.ok) && rt.harness.host.list().length === 0 &&
          BrowserWindow.getAllWindows().length === rt.originalWindows,
        observed: { count: results.length, results, residualViewCount: rt.harness.host.list().length,
          electronProcessCount: app.getAppMetrics().length, hostRssBytes: process.memoryUsage().rss },
      };
    }, "close-all-six-without-a-second-standalone-app", { assert: true }),
  ],
});
