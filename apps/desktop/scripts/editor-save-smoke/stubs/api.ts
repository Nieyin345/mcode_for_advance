type Request = { filePath: string; content: string };
let handler: (req: Request) => Promise<{ ok: boolean }> = async () => ({ ok: true });
export function setWriteHandler(next: typeof handler): void { handler = next; }
export const api = { file: { writeFile: (req: Request) => handler(req) } };
