/**
 * `@main/store/repositories.js` 的替身 —— 只为无头脚本。
 *
 * 真那一份顶层 import `db.ts` → electron。这一套要验的是 delegateHost 拿 SettingRepo
 * 读/写哪些键、拿 SessionRepo 建出什么样的会话行、拿 ProjectRepo 解析项目目录 —— 都在
 * 一张内存表上跑同一套接口语义即可。
 *
 * 与 `public-mcp-session-smoke` 的同名桩形状一致(那一套验的是 publicMcpSession 里同一批
 * 键),但**本套自带一份**:delegateHost 的边界就靠这几个 Repo 的读/写,夹具要能随手
 * `resetRepositories(...)` 清干净。
 */
const settings = new Map<string, string>();
const sessions = new Map<string, any>();
let projects: any[] = [];

export const SettingRepo = {
  get: (key: string): string | null => settings.get(key) ?? null,
  set: (key: string, value: string): void => void settings.set(key, value),
};
export const SessionRepo = {
  get: (id: string): any => sessions.get(id) ?? null,
  create: (session: any): void => void sessions.set(session.id, session),
};
export const ProjectRepo = {
  list: (): any[] => projects,
  get: (id: string): any => projects.find((project) => project.id === id) ?? null,
};

export function resetRepositories(nextProjects: any[] = []): void {
  settings.clear();
  sessions.clear();
  projects = nextProjects;
}

/** 本套辅助:全部建出来的会话,便于断言"没有多余的会话被建出来"。 */
export function sessionsOf(): any[] {
  return [...sessions.values()];
}
