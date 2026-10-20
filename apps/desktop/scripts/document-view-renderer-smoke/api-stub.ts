/**
 * `@renderer/lib/api.js` 替身 —— 可编程的 `document.capabilities` 与
 * `documentView.*` 调用记录。
 *
 * 这套的判据是"组件到底向主进程发了什么、按什么顺序、带什么参数"，所以
 * `documentView` 的七个方法全部记录调用（参数 + 序号），能力报告由
 * `__setCapabilities()` 喂。其余命名空间走 Proxy 返回 `undefined`（传递依赖可能顺手
 * 读一个，不在判据内）。
 */
import type { DocViewResult } from "@contracts/ipc";

export interface DocumentViewCall {
  method: "open" | "openPath" | "bounds" | "show" | "hide" | "focus" | "close" | "list";
  input: unknown;
  seq: number;
}

/** 全局单调序号 —— 跨方法排序（"先 open 后 bounds、卸载时 close"要按真实发生顺序验）。 */
let seq = 0;
export const documentViewCalls: DocumentViewCall[] = [];
/** 每个方法下一次返回的结果；默认全部成功。 */
const plans = new Map<string, DocViewResult>();
let deferredNextOpen: { promise: Promise<DocViewResult>; resolve: (value: DocViewResult) => void } | null = null;
let rejectNextOpenPath: string | null = null;
export function __rejectOpenPathOnce(reason: string): void { rejectNextOpenPath = reason; }
export function __deferNextOpen(): (value: DocViewResult) => void {
  let resolve!: (value: DocViewResult) => void;
  const promise = new Promise<DocViewResult>((r) => { resolve = r; });
  deferredNextOpen = { promise, resolve };
  return resolve;
}
export function __plan(method: DocumentViewCall["method"], result: DocViewResult): void {
  plans.set(method, result);
}
export function __resetCalls(): void {
  documentViewCalls.length = 0;
  plans.clear();
  deferredNextOpen = null;
  rejectNextOpenPath = null;
}

type CapabilityPlan =
  | { kind: "ok"; cli: { available: boolean; path: string | null }; hosts?: { docs: boolean; slides: boolean; sheets: boolean } }
  | { kind: "error"; message: string };
let capabilityPlan: CapabilityPlan = { kind: "ok", cli: { available: false, path: null } };
export function __setCapabilities(next: CapabilityPlan): void {
  capabilityPlan = next;
}
export const capabilityCalls: number[] = [];

const documentView = {
  open: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "open", input, seq: ++seq });
    if (deferredNextOpen !== null) {
      const pending = deferredNextOpen;
      deferredNextOpen = null;
      return pending.promise;
    }
    return Promise.resolve(plans.get("open") ?? { ok: true });
  },
  openPath: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "openPath", input, seq: ++seq });
    if (rejectNextOpenPath !== null) {
      const reason = rejectNextOpenPath;
      rejectNextOpenPath = null;
      return Promise.reject(new Error(reason));
    }
    return Promise.resolve(plans.get("openPath") ?? { ok: true });
  },
  bounds: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "bounds", input, seq: ++seq });
    return Promise.resolve(plans.get("bounds") ?? { ok: true });
  },
  show: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "show", input, seq: ++seq });
    return Promise.resolve(plans.get("show") ?? { ok: true });
  },
  hide: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "hide", input, seq: ++seq });
    return Promise.resolve(plans.get("hide") ?? { ok: true });
  },
  focus: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "focus", input, seq: ++seq });
    return Promise.resolve(plans.get("focus") ?? { ok: true });
  },
  close: (input: unknown): Promise<DocViewResult> => {
    documentViewCalls.push({ method: "close", input, seq: ++seq });
    return Promise.resolve(plans.get("close") ?? { ok: true });
  },
  list: (): Promise<unknown> => {
    documentViewCalls.push({ method: "list", input: undefined, seq: ++seq });
    return Promise.resolve({ views: [] });
  },
};

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (ns === "documentView" && prop in documentView) {
          return documentView[prop as keyof typeof documentView];
        }
        if (ns === "document" && prop === "capabilities") {
          return (): Promise<unknown> => {
            capabilityCalls.push(++seq);
            if (capabilityPlan.kind === "error") return Promise.reject(new Error(capabilityPlan.message));
            return Promise.resolve({
              cli: capabilityPlan.cli,
              hosts: capabilityPlan.hosts ?? { docs: true, slides: false, sheets: false },
              local: [],
              needsApp: [],
              needsSidecar: [],
              note: "",
            });
          };
        }
        return (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined);
      },
    },
  );
}

const namespaces = new Map<string, unknown>();
export const api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (typeof ns !== "string") return undefined;
      let v = namespaces.get(ns);
      if (!v) {
        v = makeNs(ns);
        namespaces.set(ns, v);
      }
      return v;
    },
  },
);
