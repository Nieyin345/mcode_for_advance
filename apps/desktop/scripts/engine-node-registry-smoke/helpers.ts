/**
 * `engine-node-registry-smoke` 的安装辅助 —— 只把「用真盘做安装」这段从 main.ts
 * 里拆出来，避免主套件被文件系统细节淹没。
 *
 * 这些函数**不是被测代码**：被测的是 `engineNodeRegistry.ts` 的 `installFromBytes`
 * / `installFromDirectory` / `stableDirectoryHash`。这里只负责：
 *   - 用真盘实现 `EngineNodeRegistryFs`（与生产 `nodeFs` 同形，便于制造写失败）；
 *   - 用临时目录构造一个「目录包」；`meta.sha256` 由 `stableDirectoryHash` 现算。
 */
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineNodeRegistry,
  stableDirectoryHash,
  type EngineNodeInstallRequest,
  type EngineNodeRegistryFs,
} from "@main/workflowEngines/engineNodeRegistry.js";

/** 与生产默认端口同形的真盘实现（测试里用它制造「第 N 次写入失败」）。 */
export async function readTreeReal(): Promise<EngineNodeRegistryFs> {
  return {
    async readFile(path) { return readFile(path, "utf8"); },
    async writeFile(path, text) { await writeFile(path, text, "utf8"); },
    async rename(from, to) { await rename(from, to); },
    async mkdir(path) { await mkdir(path, { recursive: true }); },
    async remove(path) { await rm(path, { recursive: true, force: true }); },
    async writeBytes(path, bytes) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, bytes);
    },
    async readTree(root) {
      const out: Array<{ path: string; bytes: Uint8Array }> = [];
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          else if (entry.isFile()) out.push({ path: rel, bytes: await readFile(join(dir, entry.name)) });
          else throw Error(`unsupported entry: ${rel}`);
        }
      };
      await walk(root, "");
      return out;
    },
  };
}

/** 在真盘实现上再包一层：第 `shouldFailAfter()` 次 `writeBytes` 抛错。 */
export function mkFailingFs(
  real: EngineNodeRegistryFs,
  _dataDir: string,
  shouldFail: () => boolean,
): EngineNodeRegistryFs {
  return {
    ...real,
    async writeBytes(path, bytes) {
      if (shouldFail()) throw Error("EIO: 模拟写盘失败");
      return real.writeBytes!(path, bytes);
    },
  };
}

/** 构造一个两个文件的目录包，返回临时目录与按稳定哈希算出的 meta。 */
export async function installDir(
  registry: EngineNodeRegistry,
  meta: EngineNodeInstallRequest,
): Promise<{ ok: true; entry: unknown } | { ok: false; reason: string }> {
  const sourceDir = await mkdtemp(join(tmpdir(), "mcode-engine-node-src-"));
  try {
    await mkdir(join(sourceDir, "nodes"), { recursive: true });
    await writeFile(join(sourceDir, "package.json"), '{"name":"node-red-contrib-dir"}', "utf8");
    await writeFile(join(sourceDir, "nodes", "hello.js"), "module.exports = function(RED){};", "utf8");
    return (await registry.installFromDirectory(meta, sourceDir)) as
      | { ok: true; entry: unknown }
      | { ok: false; reason: string };
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

/** 便利：把一个内存里的包体直接交给 `installFromBytes`（套件里只有一处用得到）。 */
export async function installBytes(
  registry: EngineNodeRegistry,
  meta: EngineNodeInstallRequest,
  bytes: Uint8Array,
): Promise<{ ok: true; entry: unknown } | { ok: false; reason: string }> {
  return (await registry.installFromBytes(meta, bytes)) as
    | { ok: true; entry: unknown }
    | { ok: false; reason: string };
}

/** 目录枚举（只用于断言「没有 .staging-* 残留」）。 */
export async function readdirNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export { stableDirectoryHash };
