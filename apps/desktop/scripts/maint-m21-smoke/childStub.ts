/**
 * `node:child_process` 的替身:不启动任何进程,只记录调用。
 * 这是本套件安全性的底线 —— 被测代码在真实环境里会拉起**提权** PowerShell,
 * 这里必须一个进程都不起。
 */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

export interface SpawnCall { cmd: string; args: string[]; }
export const spawnCalls: SpawnCall[] = [];
/** 测试设置:fake spawn 在"退出"前要创建的 marker 文件(模拟脚本跑成功)。 */
export const spawnHooks: { markerToCreate: string | null } = { markerToCreate: null };

export function spawn(cmd: string, args: string[]): EventEmitter & { stderr: EventEmitter } {
  spawnCalls.push({ cmd, args });
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  setTimeout(() => {
    // 模拟「提权脚本跑成功」：脚本自己会写 marker，所以从内联脚本里解析出它要写
    // 的那个路径再写——marker 是随机名的，写死路径就跟真实行为对不上了。
    const marker = markerFromArgs(args) ?? spawnHooks.markerToCreate;
    if (marker) writeFileSync(marker, "OK");
    child.emit("exit", 0);
  }, 0);
  return child;
}

/** 从 `-EncodedCommand <base64>` 里还原脚本，取出它要写的 marker 路径。 */
function markerFromArgs(args: string[]): string | null {
  const joined = args.join(" ");
  const enc = /-EncodedCommand['",\s]+([A-Za-z0-9+/=]+)/.exec(joined);
  const script = enc?.[1]
    ? Buffer.from(enc[1], "base64").toString("utf16le")
    : joined;
  const m = /'OK'\s*\|\s*Set-Content -Path '(.+?)'/.exec(script);
  return m?.[1] ?? null;
}

export function execFile(
  _cmd: string,
  _args: string[],
  _opts: unknown,
  cb: (err: Error | null, stdout: string) => void,
): void {
  // `sc query ds-docservice` → 装好且在跑
  setTimeout(() => cb(null, "        STATE              : 4  RUNNING"), 0);
}
