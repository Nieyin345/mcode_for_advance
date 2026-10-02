type Request = { filePath: string; content: string };
let handler: (req: Request) => Promise<{ ok: boolean }> = async () => ({ ok: true });
let reader: (req: { filePath: string }) => Promise<{ content: string }> = async () => { throw new Error("no file"); };
export function setWriteHandler(next: typeof handler): void { handler = next; }
export function setReadHandler(next: typeof reader): void { reader = next; }
export const api = {
  file: {
    writeFile: (req: Request) => handler(req),
    readFile: (req: { filePath: string }) => reader(req),
  },
};
