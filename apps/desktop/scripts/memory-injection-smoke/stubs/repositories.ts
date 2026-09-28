import type { Session } from '@contracts/session';
export const sessions = new Map<string, Session>();
export const SessionRepo = { get: (id: string) => sessions.get(id) };
export const SettingRepo = { get: () => null, getMany: () => ({}), set: () => { throw Error('No persistent settings writes in this suite'); } };
export const ProjectRepo = { get: (id: string) => ({ id, name: id, path: '/isolated/' + id }), list: () => [] };
