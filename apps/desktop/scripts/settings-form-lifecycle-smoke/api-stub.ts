/**
 * `@renderer/lib/api.js` 替身 —— **可控的设置读写**(MC-047 回归网地基)。
 *
 * 能力:
 *   - 按 key 预置值(`seedSetting`);
 *   - **按 key** 注入下一次读/写失败(`failNextGetFor` / `failNextSetFor`)——
 *     浏览器面板一次挂载会按树序读好几格,不按键定向就没法精确砸哪一格;
 *   - 记录每次 get/set 调用;
 *   - 其他命名空间给递归空壳(`api.anything.whatever()` 都解析,返回值字段为
 *     undefined —— 消费方读取不到就安静跳过,不影响本套的断言面)。
 */
const values = new Map<string, string>();
const gets: string[] = [];
const sets: Array<{ key: string; value: string }> = [];
const failGetKeys = new Map<string, string>();
const failSetKeys = new Map<string, string>();
const vaultFailures: string[] = [];
let vaultCalls = 0;
/** `browser.vaultStatus()` 的成功回执。`seedVaultStatus` 覆盖默认值(健康态)。 */
let vaultStatus: Record<string, unknown> = {
  encryptionAvailable: true,
  persistLogin: true,
  savedCount: 0,
  plaintextErased: false,
  lastError: null,
  restoreError: null,
};

export function seedSetting(key: string, value: string): void {
  values.set(key, value);
}
export function failNextGetFor(key: string, message: string): void {
  failGetKeys.set(key, message);
}
export function failNextSetFor(key: string, message: string): void {
  failSetKeys.set(key, message);
}
/** 下一次 `browser.vaultStatus()` 失败(之后恢复成功)。 */
export function failNextVaultStatus(message: string): void {
  vaultFailures.push(message);
}
export function vaultStatusCalls(): number {
  return vaultCalls;
}
/** 覆盖 `vaultStatus()` 的成功回执(不传的字段保持健康默认值)。 */
export function seedVaultStatus(patch: Record<string, unknown>): void {
  vaultStatus = { ...vaultStatus, ...patch };
}
export function getCalls(): string[] {
  return [...gets];
}
export function setCalls(): Array<{ key: string; value: string }> {
  return [...sets];
}
export function readValue(key: string): string | undefined {
  return values.get(key);
}
export function resetApiStub(): void {
  values.clear();
  gets.length = 0;
  sets.length = 0;
  failGetKeys.clear();
  failSetKeys.clear();
  vaultFailures.length = 0;
  vaultCalls = 0;
  panelFailures.clear();
  panelCallCounts.clear();
  vaultStatus = {
    encryptionAvailable: true,
    persistLogin: true,
    savedCount: 0,
    plaintextErased: false,
    lastError: null,
    restoreError: null,
  };
}

const settingsApi = {
  setting: {
    get(input: { key: string }): Promise<{ value: string | null }> {
      gets.push(input.key);
      const failure = failGetKeys.get(input.key);
      if (failure !== undefined) {
        failGetKeys.delete(input.key);
        return Promise.reject(new Error(failure));
      }
      return Promise.resolve({ value: values.get(input.key) ?? null });
    },
    set(input: { key: string; value: string }): Promise<unknown> {
      sets.push({ ...input });
      const failure = failSetKeys.get(input.key);
      if (failure !== undefined) {
        failSetKeys.delete(input.key);
        return Promise.reject(new Error(failure));
      }
      values.set(input.key, input.value);
      return Promise.resolve({ ok: true });
    },
  },
  pickFolder: (): Promise<{ path: string }> => Promise.resolve({ path: "" }),
  browser: {
    vaultStatus(): Promise<unknown> {
      vaultCalls += 1;
      const failure = vaultFailures.shift();
      if (failure !== undefined) return Promise.reject(new Error(failure));
      return Promise.resolve(vaultStatus);
    },
  },
};

/** 递归空壳:`api.browser.vaultStatus()` / `api.whatever.deep.call()` 都能解析并
 *  resolve 一个通用回执(字段读取为 undefined,消费方按"拿不到"处理)。 */
function shell(path: string): unknown {
  const callable = (...args: unknown[]): Promise<unknown> => Promise.resolve({ path, args });
  return new Proxy(callable, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return shell(`${path}.${prop}`);
    },
  });
}

/* ── 【MC-026 复核】三个设置面板的读/存注入面 ─────────────────────────────────
 *
 * 与上面的 setting.get/set 同一套手法:`failNext<Rpc>` 注入**下一次**失败,
 * `<rpc>Calls()` 数调用次数(重试是否真的重发就看它)。面板挂载时各自读一遍,
 * 所以"读失败"场景用 failNext(只砸第一次);"重试成功"自然是第二次。 */

type PanelRpc = "customModel.list" | "piModels.list" | "codexModels.list" | "engineTools.get" | "workflow.list" | "workflow.get" | "workflow.save" | "engineTools.set";
const panelFailures = new Map<PanelRpc, string[]>();
const panelCallCounts = new Map<PanelRpc, number>();

export function failNextPanel(rpc: PanelRpc, message: string): void {
  const q = panelFailures.get(rpc) ?? [];
  q.push(message);
  panelFailures.set(rpc, q);
}
export function panelCalls(rpc: PanelRpc): number {
  return panelCallCounts.get(rpc) ?? 0;
}

/** 面板类 RPC 夹具的返回值(与生产同形到消费方只读的那几个字段)。 */
const customModels: Array<Record<string, unknown>> = [];
let engineSnapshot: Record<string, unknown> = {
  engines: {
    claude: { exclude: [], supported: true, known: ["Bash", "Read"], guidance: "" },
    pi: { exclude: [], supported: true, known: ["read", "bash"], guidance: "" },
    codex: { exclude: [], supported: false, known: [], guidance: "" },
  },
  status: "MISSING",
};
const workflowDocs = new Map<string, Record<string, unknown>>([
  ["auto-1", { id: "auto-1", name: "每日整理", nodes: [], edges: [], builtin: false, updatedAt: 1 }],
]);

function panelInvoke(rpc: PanelRpc, args: unknown[]): Promise<unknown> {
  panelCallCounts.set(rpc, (panelCallCounts.get(rpc) ?? 0) + 1);
  const queue = panelFailures.get(rpc);
  if (queue !== undefined && queue.length > 0) {
    const message = queue.shift()!;
    return Promise.reject(new Error(message));
  }
  switch (rpc) {
    case "customModel.list":
      return Promise.resolve({ models: [...customModels], storeInvalid: false });
    case "piModels.list":
      return Promise.resolve({ providers: {} });
    case "codexModels.list":
      return Promise.resolve({ providers: [] });
    case "engineTools.get":
      return Promise.resolve(engineSnapshot);
    case "engineTools.set":
      return Promise.resolve({ ok: true, snapshot: engineSnapshot });
    case "workflow.list":
      return Promise.resolve({
        workflows: [...workflowDocs.values()].map((d) => ({ ...d, kind: "graph", trigger: { kind: "manual" } })),
      });
    case "workflow.get": {
      const id = (args[0] as { id?: string } | undefined)?.id;
      return Promise.resolve({ workflow: workflowDocs.get(id ?? "") ?? null, review: null });
    }
    case "workflow.save":
      return Promise.resolve({ ok: true });
  }
}

const panelApi = {
  customModel: { list: () => panelInvoke("customModel.list", []) },
  piModels: { list: () => panelInvoke("piModels.list", []) },
  codexModels: { list: () => panelInvoke("codexModels.list", []) },
  engineTools: {
    get: () => panelInvoke("engineTools.get", []),
    set: (input: unknown) => panelInvoke("engineTools.set", [input]),
  },
  workflow: {
    list: () => panelInvoke("workflow.list", []),
    get: (input: unknown) => panelInvoke("workflow.get", [input]),
    save: (input: unknown) => panelInvoke("workflow.save", [input]),
    nodeTypes: () => Promise.resolve({ entries: [], problems: [] }),
    agentProfiles: () => Promise.resolve({ profiles: [], problems: [] }),
  },
  project: { list: () => Promise.resolve({ projects: [{ id: "p1", name: "项目", path: "C:/p1" }] }) },
  automation: {
    runs: () => Promise.resolve({ runs: [] }),
    statusAll: () => Promise.resolve([]),
  },
};

/** 命名导出 `api` 与默认导出**同一份** —— 组件用的是 `import { api }`,
 *  测试用的是 `import * as stub`,两边必须看到同一组注入面。 */
const apiProxy = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (prop === "setting") return settingsApi.setting;
    if (prop === "pickFolder") return settingsApi.pickFolder;
    if (prop === "browser") return settingsApi.browser;
    if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(panelApi, prop)) {
      return (panelApi as Record<string, unknown>)[prop];
    }
    if (prop === "on") return new Proxy({}, { get: () => () => () => {} });
    if (typeof prop !== "string") return undefined;
    return shell(prop);
  },
});
export { apiProxy as api };
export default apiProxy;
