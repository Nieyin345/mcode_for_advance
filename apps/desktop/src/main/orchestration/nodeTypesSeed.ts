/**
 * 把 `<数据根>/workflows/node-types/` 铺出来 —— 目录本身,和写它需要的规范。
 *
 * 命名和做法都照 `main/workflows/seed.ts`(那套 Python 脚本的落盘器),规矩也一样:
 * **已存在就跳过,绝不覆盖** —— 用户改过的东西不能被启动流程冲掉。
 *
 * ## 为什么要铺一份 README
 *
 * 节点类型是"可下载、可由 AI 现场撰写"的东西,而**写它需要的那份规范只有仓库里有**。
 * 把规范放在目录旁边,系统提示词里就只需要给一个路径,不必每一轮把整份规范塞进上下文
 * (用户对 token 成本很敏感,那是实打实的一笔)。
 *
 * ## 这份 README 和 `docs/节点类型.md` 不是重复
 *
 * | | 写给谁 | 讲什么 |
 * |---|---|---|
 * | 这份(铺到数据根) | **用户和 AI** | 怎么写一个(字段、例子、怎么生效) |
 * | `docs/节点类型.md`(仓库里) | 维护者 | 为什么这么设计(边界、取舍) |
 *
 * ## 为什么用 `?raw` 而不是 TS 模板字符串
 *
 * 正文是 markdown,到处是反引号,
 * 写成模板字符串要逐个转义,迟早漏一个。`?raw` 是构建期纯文本内联,文件逐字不动。
 *
 * ⚠️ `?raw` 是**构建期**的东西,**纯 Node** 里解析不了 `./node-types-README.md?raw`
 * —— 所以"读类型"和"铺目录"分成两个模块:`nodeTypes.ts` 不依赖本文件。
 *
 * 但**无头探针照样能直接 import 本文件**:esbuild 打包时给 `.md` 加一个 text loader
 * (`--loader:.md=text`),`x.md?raw` 就会被解析回 `x.md` 再套上那个 loader —— `?raw`
 * 的等价物,一个字符都不少。所以这套冒烟测的是**真的这一份**(见
 * `scripts/orchestration-ipc-smoke/` 的 §2:断的是"铺出来那份与仓库里那份逐字节一致")。
 *
 * ⚠️ 这里以前写着"不能被无头探针直接 import",于是**那句话本身成了这个文件零覆盖的
 * 理由**。那句话对纯 Node 成立、对 esbuild 不成立 —— 别再按它跳过这一份。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import readmeMd from "./node-types-README.md?raw";
import { log } from "@main/lib/logger.js";
import { localNodeTypesDir } from "./nodeTypes.js";

/** 相对 `<数据根>/workflows/node-types/` 的文件名 → 正文。 */
export const NODE_TYPES_FILES: ReadonlyArray<[name: string, body: string]> = [
  ["README.md", readmeMd],
];

/** 建目录 + 铺 README。跑在启动路径上,**任何失败都只记日志,不往外抛** —— 用户可能
 *  把数据根放到了只读位置或网盘上,那不该让整个应用起不来。
 *
 * ## 为什么是**每个文件一个 try**,而不是整个循环外面一个
 *
 * 照 `main/workflows/seed.ts` 那份的做法。差别在**一个文件写失败时,后面的还铺不铺**:
 *
 *  - 整个循环一个 try(以前这里)→ 第一个文件写失败,**后面每一个都不再尝试**。今天
 *    `NODE_TYPES_FILES` 只有一项,所以看不出差别 —— 等哪天加了第二项,磁盘上少一份
 *    文件、日志里也只有一条(而且那条报的是第一个文件的错),排查时得从第一个开始猜。
 *  - 每个文件一个 try(这里)→ 坏的那一份自己报自己,其余照铺。 */
export function ensureLocalNodeTypesDir(): void {
  const dir = localNodeTypesDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn(`[orchestration] 节点类型目录没建出来(${dir}):${(err as Error).message}`);
    return;
  }
  for (const [name, body] of NODE_TYPES_FILES) {
    const file = path.join(dir, name);
    if (existsSync(file)) continue; // 用户改过的留着
    try {
      writeFileSync(file, body, "utf-8");
    } catch (err) {
      log.warn(`[orchestration] 节点类型文件没铺出来(${file}):${(err as Error).message}`);
    }
  }
}
