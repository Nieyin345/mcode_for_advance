import { createRequire } from "node:module";
import * as path from "node:path";

export interface NativeFsStat {
  type: "file" | "directory" | "other";
  size: number;
  links: number;
  device: string;
  inode: string;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface NativeFsEntry {
  name: string;
  type: 0 | 1 | 2;
  size: number;
}

export interface NativeFsRoot {
  stat(segments: readonly string[]): Promise<NativeFsStat>;
  readdir(segments: readonly string[], maxEntries?: number): Promise<NativeFsEntry[]>;
  readFile(segments: readonly string[], maxBytes: number): Promise<Buffer>;
  writeFile(segments: readonly string[], bytes: Buffer, exclusive?: boolean): Promise<void>;
  mkdir(segments: readonly string[]): Promise<void>;
  rename(from: readonly string[], to: readonly string[], overwrite?: boolean): Promise<void>;
  copy(from: readonly string[], to: readonly string[], overwrite?: boolean): Promise<void>;
  remove(segments: readonly string[]): Promise<void>;
  close(): void;
}

interface NativeFsAddon {
  napiVersion: number;
  openRoot(absolutePath: string): NativeFsRoot;
}

const require = createRequire(import.meta.url);
let addon: NativeFsAddon | undefined;
let addonLoadError: unknown;

function nativeAddonPath(): string {
  const override = process.env.MCODE_NATIVE_FS_PATH;
  if (override) return path.resolve(override);
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string;
    defaultApp?: boolean;
  };
  if (electronProcess.resourcesPath && electronProcess.defaultApp !== true) {
    return path.join(electronProcess.resourcesPath, "native-fs", "mcode_fs.node");
  }
  // Electron dev and the headless smoke runners execute with the desktop
  // package as cwd. Avoid import.meta-relative lookup: esbuild-based smokes
  // bundle this module into a temporary directory.
  return path.resolve(process.cwd(), "native", "mcode-fs", "build", "Release", "mcode_fs.node");
}

function loadAddon(): NativeFsAddon {
  if (addon) return addon;
  if (addonLoadError) throw addonLoadError;
  const binary = nativeAddonPath();
  try {
    const loaded = require(binary) as NativeFsAddon;
    if (typeof loaded.openRoot !== "function" || loaded.napiVersion < 8) {
      throw new Error("native filesystem addon does not expose the required N-API 8 interface");
    }
    addon = loaded;
    return loaded;
  } catch (error) {
    addonLoadError = new Error(
      "Mcode native filesystem is unavailable. Rebuild the Electron addon with " +
      "pnpm --filter @mcode/desktop exec node build/build-native-fs.cjs. " +
      "Expected binary: " + binary + ". Cause: " +
      (error instanceof Error ? error.message : String(error)),
    );
    throw addonLoadError;
  }
}

export function openNativeFsRoot(absoluteRoot: string): NativeFsRoot {
  if (!path.isAbsolute(absoluteRoot)) throw new Error("native filesystem root must be absolute");
  return loadAddon().openRoot(absoluteRoot);
}
