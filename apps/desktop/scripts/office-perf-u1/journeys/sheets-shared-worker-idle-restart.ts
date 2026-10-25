/**
 * Real Windows x64 / Electron process-level regression for O17.
 * Each probe uses the genuine Mcode DocumentViewHost, vendor Sheets renderer
 * and one native Rust XLSX sidecar. Only child processes of THIS test's
 * Electron PID are queried (never inspect/stop other Mcode sessions).
 *
 * This journey is opt-in because it needs >60 seconds of idle observation.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, editorUrl, js, waitFor, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";

type Metric = { pid: number; workingSetBytes: number };
type PerfRun = EditorRuntime & {
  setupStartMs: number;
  firstSidecar: Metric | null;
  secondaryDocId?: string;
  secondaryFile?: string;
  retiredAtMs?: number;
};

function childWorkerMetrics(): Metric[] {
  if (process.platform !== "win32") {
    throw new Error("This process-level U1 currently supports Windows; use the vendor fake-time unit tests on other platforms");
  }
  // Read-only CIM query, strictly scoped to the current disposable Electron
  // harness, never by name alone (other chat threads may run sidecars).
  const script = [
    "$ErrorActionPreference='Stop'",
    `$items=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'xlsx-sidecar.exe'" | Select-Object ProcessId, WorkingSetSize)`,
    "ConvertTo-Json -InputObject $items -Compress",
  ].join("; ");
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 15_000, windowsHide: true,
  }).trim();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CIM process response was not an array: " + raw.slice(0, 256));
  return parsed.map((p) => {
    const row = p as { ProcessId?: number; WorkingSetSize?: number | string };
    const pid = Number(row.ProcessId);
    const workingSetBytes = Number(row.WorkingSetSize);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(workingSetBytes) || workingSetBytes < 0) {
      throw new Error("Invalid child process metrics: " + JSON.stringify(row));
    }
    return { pid, workingSetBytes };
  });
}

async function getOneWorker(timeoutMs = 20_000): Promise<Metric | null> {
  return await waitFor(async () => {
    const metrics = childWorkerMetrics();
    return metrics.length === 1 ? metrics[0]! : null;
  }, timeoutMs, 700);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nativeSetup = editorSetup("sheets");

export const sheetsSharedWorkerJourney = defineU1Journey({
  name: "sheets-shared-worker-idle-restart",
  launch: {
    window: false,
    size: { width: 1280, height: 900 },
    defaultTimeoutMs: 45_000,
    setup: async (ctx) => {
      const start = performance.now();
      const setup = await nativeSetup(ctx);
      const runtime = setup.runtime as PerfRun;
      runtime.setupStartMs = start;
      runtime.firstSidecar = null;
      return setup;
    },
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor("#univer-container canvas", "first-sheets-canvas", { timeoutMs: 40_000 }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      const one = await getOneWorker();
      rt.firstSidecar = one;
      return {
        ok: one !== null && one.workingSetBytes > 0,
        observed: { worker: one, startToGridMs: Math.round(performance.now() - rt.setupStartMs), parentPid: process.pid },
        detail: one ? undefined : "Mcode Sheets renderer opened but no uniquely owned xlsx-sidecar.exe was detected",
      };
    }, "first-sidecar-pid-rss-and-load-ms", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      const second = join(rt.harness.projectDir, "office-perf-second.xlsx");
      copyFileSync(rt.fixtures.sheets, second);
      const docId = "office-perf-second";
      rt.secondaryDocId = docId;
      rt.secondaryFile = second;
      // Emulate two real tabs: the first stays alive but hidden; the
      // second becomes visible and must actually mount its own workbook.
      rt.harness.host.hide(rt.docId);
      const open = rt.harness.host.open({
        docId, url: editorUrl("sheets"), editor: "sheets", filePath: second,
        visible: true,
        bounds: { x: 0, y: 0, width: 1280, height: 900 },
        mcodeSessionId: "office-perf-session",
      });
      const secondWc = rt.harness.webContentsOf(docId);
      const secondReady = secondWc
        ? await waitFor(() => js<boolean>(secondWc, "!!document.querySelector('#univer-container canvas')"), 30_000, 350)
        : null;
      const metrics = childWorkerMetrics();
      return {
        ok: open.ok && secondReady === true && rt.harness.host.list().length === 2 &&
          metrics.length === 1 && metrics[0]?.pid === rt.firstSidecar?.pid,
        observed: { open, secondRendered: secondReady, worker: metrics, views: rt.harness.host.list().map(v => v.docId) },
      };
    }, "second-workbook-shares-existing-rust-process", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      const first = rt.harness.host.close(rt.docId);
      const metrics = childWorkerMetrics();
      return {
        ok: first.ok && rt.harness.host.list().length === 1 &&
          metrics.length === 1 && metrics[0]?.pid === rt.firstSidecar?.pid,
        observed: { first, worker: metrics, remaining: rt.harness.host.list().map(v => v.docId) },
      };
    }, "closing-first-workbook-keeps-shared-worker-for-second", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      if (!rt.secondaryDocId) return { ok: false, detail: "secondary view not registered" };
      const closed = rt.harness.host.close(rt.secondaryDocId);
      const started = performance.now();
      // Grace = 60 seconds after all session cleanup. At +8s the shared
      // process should still exist; this protects rapid close/reopen.
      await sleep(8_000);
      const soon = childWorkerMetrics();
      rt.retiredAtMs = started;
      return {
        ok: closed.ok && rt.harness.host.list().length === 0 &&
          soon.length === 1 && soon[0]?.pid === rt.firstSidecar?.pid,
        observed: { closed, workerAt8s: soon, firstWorker: rt.firstSidecar },
      };
    }, "last-workbook-close-starts-grace-not-immediate-kill", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      // Timer may start after Rust confirms workbook:close and deletes
      // temporary snapshots. Allow an extra 20s beyond the 60s grace.
      const deadline = (rt.retiredAtMs ?? performance.now()) + 85_000;
      let observations = 0;
      let currently: Metric[] = [];
      while (performance.now() < deadline) {
        currently = childWorkerMetrics();
        observations++;
        if (currently.length === 0) break;
        await sleep(1_500);
      }
      const elapsedMs = Math.round(performance.now() - (rt.retiredAtMs ?? performance.now()));
      const freedWorkingSetBytes = rt.firstSidecar?.workingSetBytes ?? 0;
      return {
        ok: currently.length === 0,
        observed: { workerAtIdle: currently, idleElapsedMs: elapsedMs, freedWorkingSetBytes, observations },
        detail: currently.length > 0 ? "Expected last-tab Rust worker to exit after idle grace" : undefined,
      };
    }, "worker-exits-after-idle-and-releases-sampled-rss", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as PerfRun;
      if (!rt.secondaryFile) return { ok: false, detail: "no secondary fixture" };
      const start = performance.now();
      const reopened = rt.harness.host.open({
        docId: "office-perf-reopen", url: editorUrl("sheets"), editor: "sheets",
        filePath: rt.secondaryFile, visible: true,
        bounds: { x: 0, y: 0, width: 1280, height: 900 },
        mcodeSessionId: "office-perf-session",
      });
      const wc = rt.harness.webContentsOf("office-perf-reopen");
      const canvas = wc ? await waitFor(() => js<boolean>(wc, "!!document.querySelector('#univer-container canvas')"), 35_000, 300) : null;
      const worker = await getOneWorker();
      return {
        ok: reopened.ok && canvas === true && worker !== null &&
          worker.pid !== rt.firstSidecar?.pid,
        observed: { reopened, worker, reopenedCanvas: canvas, reopenToCanvasMs: Math.round(performance.now() - start) },
      };
    }, "post-retirement-reopen-respawns-and-renders-workbook", { assert: true }),
  ],
});
