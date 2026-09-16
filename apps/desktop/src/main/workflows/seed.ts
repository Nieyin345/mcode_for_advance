/**
 * 流程脚本的落盘。
 *
 * ```
 * <数据根>/workflows/
 *   README.md            这套东西是什么、怎么改
 *   scripts/
 *     library.py         查库(只读)
 *     check_citations.py 引用核对(只读)
 * ```
 *
 * ## 为什么脚本放在数据根,而不是应用目录
 *
 * 三条:① 用户要能改 —— 一个查库方式不合他意,他应该直接编辑那个 .py,而不是等我们
 * 发版;② 跟着数据走 —— 用户搬数据根的时候,资料和操作资料的工具一起搬,不会出现
 * "库搬过去了、脚本还在老地方";③ 路径可陈述 —— 系统提示词里能写一个**绝对路径**
 * 告诉模型脚本在哪,不用它去猜安装目录。
 *
 * ## 只在缺失时写
 *
 * 已存在的文件一律不动 —— 用户改过的东西不能被启动流程覆盖掉。代价是改了内嵌版本
 * 之后老安装不会自动更新;那是有意换来的:宁可用户手动删一次文件,也不能某次启动
 * 悄悄把他调好的脚本换回去。README 里写了怎么刷新。
 */
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";
import { LIBRARY_PY, CHECK_CITATIONS_PY } from "./assets.js";
import { SEARCH_SCRIPT_FILES } from "./searchScriptsAssets.js";

/** 流程目录。与 `library/`、`templates/` 平级,同在数据根下。 */
export function workflowsRoot(): string {
  return join(dataRoot(), "workflows");
}

/** 脚本目录。系统提示词里陈述的就是这个路径。 */
export function scriptsDir(): string {
  return join(workflowsRoot(), "scripts");
}

/** 脚本的绝对路径 —— 提示词里要逐个点名,所以在这里集中给出。 */
export function scriptPath(name: "library" | "check_citations"): string {
  return join(scriptsDir(), `${name}.py`);
}

const README = `# 流程脚本

模型在执行工作模式(文献精读 / 文献写作 / 文献评审)的流程时用的脚本。它们都**只读**。

## 为什么是只读的

Mcode 把整个数据库放在内存里,任何一次变更都会把 \`mcode.db\` **整份重写一遍**。
从外部写进去的东西会在应用下一次保存时被无声地覆盖 —— 看起来写成功了,其实没有。
所以这些脚本一律只查不写。要改库,走 Mcode 的界面。

## 脚本

### library.py —— 查库

    python library.py list [--kind paper|textbook|note]
    python library.py find 关键词 [--kind ...]
    python library.py show <id 前缀或标题片段>
    python library.py files [--kind ...] [--missing-md]
    python library.py notes
    python library.py collections

数据根会自动查找(读 Mcode 的 data-root.json);也可以显式给 \`--root "<绝对路径>"\`。

### check_citations.py —— 引用核对

    python check_citations.py refs.bib
    python check_citations.py refs.bib --manuscript 稿件.tex

把 .bib 里每一条拿到库里对,分成三档:**库里有** / **库里没有但标题很像** /
**库里没有也对不上**(最要紧的一档 —— 很可能是编造的)。

## 改这些脚本

直接改就行,它们是普通 Python 文件。

**想恢复成随应用发布的原版**:删掉对应文件,重启 Mcode —— 启动时会重新写一份。
(反过来说,已存在的文件不会被启动流程覆盖,所以你改过的东西不会被某次启动冲掉。)
`;

/**
 * 确保流程目录与脚本存在。幂等,启动时调一次。
 *
 * 失败**不阻断启动** —— 流程脚本是增强,不是应用能跑起来的前提。建不出来只记一条
 * 警告:用户至少还能用清单文件那条老路读库。
 */
export function ensureWorkflows(): void {
  try {
    mkdirSync(scriptsDir(), { recursive: true });
  } catch (err) {
    log.warn(`workflows: 建目录失败:${(err as Error).message}`);
    return;
  }

  const files: Array<[string, string]> = [
    ["README.md", README],
    ["scripts/library.py", LIBRARY_PY],
    ["scripts/check_citations.py", CHECK_CITATIONS_PY],
    // 检索脚本 —— 从两个 skill 仓库原样搬过来的(见 searchScriptsAssets.ts):
    // research-clients(多源检索客户端 + 中文文献解析)与 lookup-tools(PubMed /
    // 引用核验 / BibTeX / 分页遍历)。都是纯标准库,不需要装依赖。
    ...SEARCH_SCRIPT_FILES.map(
      ([rel, body]): [string, string] => [`scripts/search-scripts/${rel}`, body],
    ),
  ];

  for (const [rel, body] of files) {
    const abs = join(workflowsRoot(), rel);
    if (existsSync(abs)) continue; // 用户可能改过 —— 不覆盖
    try {
      // search-scripts 是嵌套目录,父目录可能还不存在
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
      // 可执行位:非 Windows 上直接 ./library.py 就能跑。Windows 忽略它,不影响。
      if (rel.endsWith(".py") || rel.endsWith(".mjs")) {
        try {
          chmodSync(abs, 0o755);
        } catch {
          /* 文件系统不支持就跳过 */
        }
      }
    } catch (err) {
      log.warn(`workflows: 写 ${rel} 失败:${(err as Error).message}`);
    }
  }
}
