/**
 * Electron 替身 —— 只给 `ipc/files.ts` 的剪贴板通路用。
 *
 * 判定立在一个**真实失败**上:`clipboard:saveFile` 走 `mkdir(pasteTempDir(),
 * {recursive:true})`,而 `pasteTempDir()` = `join(app.getPath("temp"), "mcode-pastes")`。
 * 本套件让 `app.getPath("temp")` 指向一个受控临时目录,并在那里摆一个**同名普通文件**
 * `mcode-pastes`,于是 `mkdir` 真的抛 `EEXIST`(实测:`EEXIST: file already exists,
 * mkdir 'C:\…\mcode-pastes'`)。
 *
 * ⚠️ 目录必须由 run.sh 通过 `MCODE_SMOKE_TEMP_DIR` 给,**没给就抛** —— 绝不回落到真
 * `os.tmpdir()`,否则测试会在用户真实临时目录里摆文件。
 */
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`ipc-clipboard-smoke stub: ${name} must be set (run via run.sh)`);
  return v;
}

export const app = {
  getPath(name: string): string {
    if (name === "temp") return requiredEnv("MCODE_SMOKE_TEMP_DIR");
    throw new Error(`ipc-clipboard-smoke stub: unexpected app.getPath("${name}")`);
  },
};

/** 由主脚本控制的剪贴板行为:`write` 抛错用来驱动 writeImage 的 catch。 */
export const clipboardControl: { writeError: Error | null } = { writeError: null };
export const clipboard = {
  write: async (): Promise<void> => {
    if (clipboardControl.writeError) throw clipboardControl.writeError;
  },
  writeText: async (): Promise<void> => {},
};

/** 让剪贴板图像写入真的走到 `clipboard.write`。 */
export const nativeImageControl: { empty: boolean } = { empty: false };
export const nativeImage = {
  createFromDataURL: (_dataUrl: string): { isEmpty: () => boolean; toPNG: () => Buffer } => ({
    isEmpty: () => nativeImageControl.empty,
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }),
};

export class ClipboardItem {
  constructor(_data: unknown) {}
}

export const shell = { trashItem: async (): Promise<void> => {} };
