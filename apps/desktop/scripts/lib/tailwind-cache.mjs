/**
 * Tailwind 编译的**跨次缓存** —— 被各 UI 套件的 `build.mjs` 用。
 *
 * ## 为什么要缓存
 *
 * 每个起真浏览器的 UI 套件都要编译一次 Tailwind(`spawnSync` 调 tailwindcss CLI),
 * 实测单次约 2.5 秒,而它只是把 `src/renderer/styles.css` 加一组 content glob
 * 编译成 CSS。而**同一套件的输入没变时输出逐字节一致**(已验证)——重复跑(改一处
 * 只跑相关套件、或全量跑第二遍)时这 2.5 秒纯属白等。
 *
 * ## 缓存键
 *
 * `styles.css 的内容哈希 + config 文件内容哈希 + tailwind 版本`。任一变了就重编译。
 * **不用 mtime** —— 内容哈希才挡得住"改了又改回来"和"checkout 换了时间戳"。
 *
 * ## 输出位置
 *
 * `.tmp/tw-cache/<key>.css`。`.tmp` 已被 git 忽略。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".tmp", "tw-cache");

/**
 * 编译(或命中缓存)一份 Tailwind CSS,写到 `outPath`。
 *
 * @param {object} o
 * @param {string} o.cliPath   tailwindcss CLI 入口(各 build.mjs 已解析出)
 * @param {string} o.configPath 已写好的 tailwind.config.cjs 路径
 * @param {string} o.inputCss  输入 styles.css(仓库相对 cwd)
 * @param {string} o.outPath   输出 css 路径(临时构建目录里)
 * @param {string} o.cwd       运行 CLI 的目录(仓库根/apps/desktop)
 * @returns {{ cached: boolean }}
 */
export function buildTailwindCached({ cliPath, configPath, inputCss, outPath, cwd }) {
  const key = createHash("sha1")
    .update(readFileSync(join(cwd, inputCss)))
    .update(readFileSync(configPath))
    .update(cliPath)          // 版本随路径变
    .digest("hex")
    .slice(0, 16);
  const cacheFile = join(CACHE_DIR, `${key}.css`);

  if (existsSync(cacheFile)) {
    copyFileSync(cacheFile, outPath);
    return { cached: true };
  }

  const r = spawnSync(process.execPath, [cliPath, "-c", configPath, "-i", inputCss, "-o", outPath], {
    cwd, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr || `tailwind exited ${r.status}`);

  // 存缓存(失败不影响本次结果 —— 缓存只是加速)。
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(outPath, cacheFile);
  } catch { /* ignore */ }
  return { cached: false };
}
