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

/**
 * 还没有 `.mcode-shipped-node-types.json` 的老安装,靠这张表认「这是某次发过的原版」。
 *
 * ⚠️ **非有不可。** `seedShippedFiles` 的判据是「记录文件里的 hash == 磁盘上那份 ⇒ 没改过,
 * 可以升」;而 2026-09-26 之前的老安装**从来没有过记录文件**,磁盘上那份旧 README 的 hash
 * 在记录里查不到 —— 于是被判成"用户改过",原样留着。那份旧 README 写着「`runner.kind`
 * 只有四个值」,模型照它写不出 `command`/`trigger`/`condition`/`code`,而**这正是本文件
 * 存在的理由**。没有这张表,升级对老用户从来没生效过(`seed.ts` 那份流程脚本表就是为此
 * 而设,见 `LEGACY_SHIPPED_SHA256`;这里漏了同一份)。
 *
 * 每项是**历次随应用发布过**的 `node-types-README.md` 内容(LF 归一后)的 sha256,由
 * git 历史算出。有了记录文件之后新版本自己会被记下,这张表**不用再加**;它只为更早装的那批。
 */
export const LEGACY_NODE_TYPES_README_SHA256: readonly string[] = [
  "d1ff664daa41ba4c0d6b6edfd6d8ec9ebbf19ae3595373737967233b4b5befeb", // a49d3c7a
  "0125d64f5c8635907bb7fc10040853d7922e4f43c740641ca99c01a7d78421f5", // dd8acea6
  "f017550f83d8c15e91ffe92c940d0735c3403f349c34c44441ed2baf6ad5d5a7", // 4fc265ed
  "9e4ab2a0cabbebfb82f43419fd73995c144f608354e79df721ed4ad44ed00a2c", // 65edc870
  "808490588febad6f6cade6d7049abdaf5873de89299b9353fe797490936f3844", // ef745009
  "a6fb8bc6558d73113015f3f9a07797f6f60f9c1c00f5dd6e6082845574169aa1", // fb42b6e2
  "0ac0a684cc4d376d3ea40fa146b74d29a77d01dbb4daf7920afc91b82e5deebb", // 281fe4da
  "4a12ad714bec9f0e5d25a1939b15db8857df07b8655aaf16b527b358bda3b0b2", // 943c9b89
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
      // 老安装(还没有记录文件)靠它认「这是发过的原版 README」——没有它,升级对那批用户
      // 从来没生效过(见上面那张表的注释)。
      legacyHashes: { "README.md": LEGACY_NODE_TYPES_README_SHA256 },
    },
  );
}
