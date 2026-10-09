/**
 * 把 `<数据根>/workflows/node-types/` 铺出来 —— 目录本身,和写它需要的规范。
 *
 * 落盘规则**唯一实现在 `main/workflows/shippedFiles.ts`**(与流程脚本那份共用):
 * **没改过的换新版、改过的才不动**。
 *
 * ## 为什么不是"已存在就跳过"
 *
 * ⚠️ 这里从前写的是 `if (existsSync(file)) continue; // 用户改过的留着`,而文件头
 * 还声称"规矩照 `main/workflows/seed.ts`" —— 可 `seed.ts` 早在 2026-09-26 就把"只在
 * 缺失时写"改掉了(见那边的文件头),因为那条规矩让老安装**永远停在第一次装的那一版**。
 * 本文件停在被修掉的旧版上,于是:
 *
 * `<数据根>/workflows/node-types/README.md` 是系统提示词明确指给模型的规范。它首发出厂
 * (2026-09)写着「`runner.kind` 只有四个值」;现版已列 9 种。老用户升级 App 后,磁盘上
 * 那份**逐字没动**,模型照陈旧 README 以为只有 4 种 kind、`command` 不能跑,写不出
 * `trigger`/`condition`/`code` 这些合法种类。改走共享判据后,没改过的老 README 会在
 * 启动时换成新版。
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
import * as path from "node:path";
import readmeMd from "./node-types-README.md?raw";
import { seedShippedFiles } from "@main/workflows/shippedFiles.js";
import { localNodeTypesDir } from "./nodeTypes.js";

/** 相对 `<数据根>/workflows/node-types/` 的文件名 → 正文。 */
export const NODE_TYPES_FILES: ReadonlyArray<[name: string, body: string]> = [
  ["README.md", readmeMd],
];

/** 记录表文件名 —— **放在 `workflows/` 父目录、用独立的名字**。
 *
 *  ① 不能放 `node-types/` 里:那个目录的加载器扫 `*.json` 当节点清单,记录文件会被当成
 *     一个坏清单(报 "id: Required")。② 不能与流程脚本那份同名:两条记录都以 `rel` 为键
 *     (这里也有一项叫 `README.md`),共用一份会互相覆盖。 */
const SHIPPED_RECORD_FILE = ".mcode-shipped-node-types.json";

/** 建目录 + 铺 README。跑在启动路径上,**任何失败都只记日志,不往外抛** —— 用户可能
 *  把数据根放到了只读位置或网盘上,那不该让整个应用起不来。判据(哪些算原版、写失败
 *  怎么办)全在 `seedShippedFiles`;每个文件各自 try,一个坏不影响其余。 */
export function ensureLocalNodeTypesDir(): void {
  const dir = localNodeTypesDir();
  seedShippedFiles(
    NODE_TYPES_FILES.map(([rel, body]) => ({ rel, body })),
    {
      rootDir: dir,
      // 记录放在 node-types 的**父目录**(`workflows/`)——见上面那条理由。
      recordDir: path.dirname(dir),
      recordFile: SHIPPED_RECORD_FILE,
      label: "node-types",
    },
  );
}
