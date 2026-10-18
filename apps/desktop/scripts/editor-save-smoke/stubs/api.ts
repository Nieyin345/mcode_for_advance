type Request = { filePath: string; content: string };
/** 【MC-024】IPC 回包形状与真契约一致：冲突时可能带 `conflictPath`。 */
let handler: (req: Request) => Promise<{ ok: boolean; conflict?: boolean; conflictPath?: string }> = async () => ({ ok: true });
let reader: (req: { filePath: string }) => Promise<{ content: string }> = async () => { throw new Error("no file"); };
export function setWriteHandler(next: typeof handler): void { handler = next; }
export function setReadHandler(next: typeof reader): void { reader = next; }
export const api = {
  file: {
    writeFile: (req: Request) => handler(req),
    readFile: (req: { filePath: string }) => reader(req),
  },
};
export type WriteResult = { ok: boolean; conflict?: boolean; conflictPath?: string };
