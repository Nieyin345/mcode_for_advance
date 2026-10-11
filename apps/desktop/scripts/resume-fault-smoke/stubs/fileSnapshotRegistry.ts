/** 内存文件快照桩:provider/adapter 只调这些方法,不碰真磁盘回放。 */
const snapshots = new Map<string, unknown>();
function makeSnapshot() {
  return {
    recordPre: async () => {},
    freeze: async () => [],
    setTurnDiff: () => {},
    getGrantRoot: () => undefined,
  };
}
export const getFileSnapshot = (_sessionId: string) => {
  if (!snapshots.has(_sessionId)) snapshots.set(_sessionId, makeSnapshot());
  return snapshots.get(_sessionId);
};
export const getOrSetFileSnapshot = (_sessionId: string, factory?: () => unknown) => {
  if (!snapshots.has(_sessionId)) snapshots.set(_sessionId, factory ? factory() : makeSnapshot());
  return snapshots.get(_sessionId);
};
export const clearFileSnapshot = (_sessionId: string) => snapshots.delete(_sessionId);
