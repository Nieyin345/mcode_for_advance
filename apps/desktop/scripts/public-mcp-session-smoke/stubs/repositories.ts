const settings = new Map<string, string>();
const sessions = new Map<string, any>();
let projects: any[] = [];

export const SettingRepo = {
  get: (key: string) => settings.get(key) ?? null,
  set: (key: string, value: string) => settings.set(key, value),
};
export const SessionRepo = {
  get: (id: string) => sessions.get(id) ?? null,
  create: (session: any) => void sessions.set(session.id, session),
};
export const ProjectRepo = {
  list: () => projects,
  get: (id: string) => projects.find((project) => project.id === id) ?? null,
};

export function resetRepositories(nextProjects: any[] = []): void {
  settings.clear();
  sessions.clear();
  projects = nextProjects;
}
