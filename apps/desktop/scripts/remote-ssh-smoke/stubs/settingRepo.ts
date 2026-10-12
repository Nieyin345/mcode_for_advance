/**
 * `@main/store/repositories.js` 的替身 —— 内存版 SettingRepo,只为本套无头脚本存在。
 *
 * `agentRemoteSsh.ts` 现在用 `SettingRepo` 存 known_hosts(主机指纹 TOFU)。真的那个会
 * 拉进 `sql.js` + `electron` 的 `app`,而无头脚本里既没有 electron 也没必要碰真库 ——
 * 换成内存表就够,本套一行 sqlite 都不碰。
 *
 * 本套自己抄一份,不复用别的套件目录里的替身(规则第 1 条:共用一个会在别人改它时连带
 * 改到这里)。
 */
const store = new Map<string, string>();

/** 【MC-014】可注入的读取故障:让下一次(或持续)`get` 抛错,模拟"设置库读不出来"。 */
let getThrowing = false;
let getThrowHits = 0;
export function armGetThrow(on: boolean): void {
  getThrowing = on;
  if (on) getThrowHits = 0;
}
export function getThrowCount(): number {
  return getThrowHits;
}

/** 【MC-014 / 第 47.2 节】可注入的**写入**故障:让 `set` 抛错,模拟"pin 落盘失败"。 */
let setThrowing = false;
let setThrowHits = 0;
export function armSetThrow(on: boolean): void {
  setThrowing = on;
  if (on) setThrowHits = 0;
}
export function setThrowCount(): number {
  return setThrowHits;
}

export const SettingRepo = {
  get(key: string): string | null {
    if (getThrowing) {
      getThrowHits += 1;
      throw new Error("injected settings read failure (isolated smoke)");
    }
    return store.get(key) ?? null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = store.get(k) ?? null;
    return out;
  },
  set(key: string, value: string): void {
    if (setThrowing) {
      setThrowHits += 1;
      throw new Error("injected settings write failure (isolated smoke)");
    }
    store.set(key, value);
  },
  delete(key: string): void {
    store.delete(key);
  },
  /** 仅供本套断言用:看设置表里到底写了什么。 */
  __dump(): Record<string, string> {
    return Object.fromEntries(store);
  },
  /** 仅供本套断言用:清空,给"全新用户"的场景用。 */
  __clear(): void {
    store.clear();
  },
};

/**
 * `agent_ssh_connect` 的**真正工具 handler** 也要能被本套驱动(台账第 48.4 节要求"在真正
 * 工具 handler 与可信授权服务两侧承重")。`agentMcpTools` 的 import 图会经
 * `providers/envPrompt`、`library/*` 拉到这几个 repo —— 无头给不出真库,这里补空实现,
 * 与 `mcode-admin-smoke/stubs/repositories.ts` 同形(但**不共用**那个文件:规则第 1 条)。
 *
 * 关键:**SettingRepo 仍是上面这一个 store** —— handler 与 manager 走同一份设置,
 * 所以夹具里 `grantHostTrust` 写进去的授权,handler 那条路读得到。
 */
export const ProjectRepo = {
  list(): { id: string; name: string; path: string; archived: boolean }[] {
    return [];
  },
};

export const LibraryRepo = {
  list(_filter?: unknown): { items: unknown[]; total: number } {
    return { items: [], total: 0 };
  },
};

export const CollectionRepo = {
  list(): { id: string; name: string; parentId: string | null }[] {
    return [];
  },
};

export const SessionRepo = {
  get(_id: string): undefined { return undefined; },
  listByProject(_projectId: string, _opts?: unknown): unknown[] { return []; },
  listPinned(): unknown[] { return []; },
};

export const MessageRepo = {
  listBySession(_sessionId: string): { messages: unknown[] } { return { messages: [] }; },
};
