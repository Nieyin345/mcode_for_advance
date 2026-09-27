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
 * ## 没改过的换新版,改过的不动
 *
 * 用户改过的东西不能被启动流程覆盖 —— 这条不变。但**只在缺失时写**(2026-09-26 以前
 * 的规则)让老安装永远停在第一次装的那一版:用户磁盘上的 library.py 还是 9 月 16 日
 * 那份,没有屏蔽逻辑、还收已退役的 `--kind`,而系统提示词叫 AI 用它查库 —— 屏蔽了
 * 的条目在 AI 眼里一条不少。
 *
 * 所以现在分辨「原版」和「改过的」:
 *   - 每次写出去的内容,哈希记在 `workflows/.mcode-shipped.json`;下次启动时文件的哈希
 *     还等于记录 → 用户没动过 → 换成这一版。
 *   - 还没有记录的老安装,拿 `LEGACY_SHIPPED_SHA256`(历次发过的版本)认。
 *   - 其余一律当作用户改过:不动,启动日志记一条(那份脚本不会有新版的屏蔽逻辑)。
 * 哈希按 LF 归一再算 —— Windows 上 git / 编辑器把换行变成 CRLF 不算「改过」。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";
import { LIBRARY_PY, CHECK_CITATIONS_PY, MINERU_PY } from "./assets.js";

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

    python library.py collections                 # 先看有哪些大类、分类(括号里是 id)
    python library.py list [--group <大类 id>]
    python library.py find 关键词 [--group ...]
    python library.py show <id 前缀或标题片段>
    python library.py files [--group ...] [--missing-md]
    python library.py notes

数据根会自动查找(读 Mcode 的 data-root.json);也可以显式给 \`--root "<绝对路径>"\`。

一条条目有 Markdown 转录时,先给转录,后面方括号里是原件(转录拿不准的图表、公式再看原件)。
设置里的屏蔽(资料库 → 屏蔽)在这里照样生效:被屏蔽的文件类型不列(屏蔽 pdf 时,转录过的
只给转录);一条的文件全被屏蔽、或它所在的分类被屏蔽,整条不出现,输出顶上会说挡掉了几条。

### check_citations.py —— 引用核对

    python check_citations.py refs.bib
    python check_citations.py refs.bib --manuscript 稿件.tex

把 .bib 里每一条拿到库里对,分成三档:**库里有** / **库里没有但标题很像** /
**库里没有也对不上**(仅表示本地未核实,不能断定是编造;外部核实后再引用)。

## 改这些脚本

直接改就行,它们是普通 Python 文件。

**想恢复成随应用发布的原版**:删掉对应文件,重启 Mcode —— 启动时会重新写一份。

**升级**:你没改过的脚本,Mcode 更新后启动时会自动换成新版;**改过的一律不动**
(Mcode 记得每次写出去的是哪一版,对不上就当你改过)。改过的脚本拿不到新版的修复 ——
想要新版,删掉它重启即可。
`;

/** 记每个文件**上次写出去的是哪一版**(哈希)。放在 workflows 根下,与脚本同搬。 */
export const SHIPPED_RECORD_FILE = ".mcode-shipped.json";

/**
 * 还没有 `.mcode-shipped.json` 的老安装,靠这张表认「这是某次发过的原版」。
 *
 * 每项是**历次随应用发布过的内容**(LF 归一后)的 sha256,由 git 历史算出。有了记录文件
 * 之后新版本自己会被记下,这张表**不用再加**;它只为 2026-09-26 之前装的那批用户。
 */
export const LEGACY_SHIPPED_SHA256: Readonly<Record<string, readonly string[]>> = {
  "scripts/library.py": [
    "eb9a03c68be957c843ac7e8b89062a1439dd5f898447f31ddf03a699fd651052", // e1687e4
    "10dd0e19976437246aac37fd3b8c7a7a003d53649070c1f4e663746b364c2839", // e1a5d87
    "a925405a3176ff146ebd5a8e579fe3c875eca65a33d61eb73e4e09a80609547c", // bcd3a2e
    "cd41100e699c880336ab615649ed6ac9d913c7f9fef0ccb7176fc9f887fb76e3", // 344aad1
  ],
  "scripts/check_citations.py": ["e0fbb2971c386aed7faf5cc0a79cadba0c12d2534765ca94c5a1b50835324ee2"],
  "scripts/mineru_transcribe.py": ["0cf861437921d1e378dc485295923b302321c497c2643a2485b77a70e1bdb73c"],
  "README.md": ["7e89e005d1f72982574aa83b8cbff8259b266272dd92ff017859152ffc816223"],
};

/** 比对用的哈希:LF 归一后的 sha256。 */
export function shippedHashOf(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** 一次 `ensureWorkflows()` 做了什么。启动流程只拿它记日志;smoke 拿它断言。 */
export interface SeedReport {
  /** 原来没有、新写的。 */
  written: string[];
  /** 原来是没改过的旧版、换成了这一版的。 */
  upgraded: string[];
  /** 和任何发过的版本都对不上 —— 当作用户改过,没动。 */
  keptModified: string[];
}

function readShippedRecord(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(workflowsRoot(), SHIPPED_RECORD_FILE), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      return out;
    }
  } catch {
    /* 没有或坏了:当老安装处理,靠 LEGACY_SHIPPED_SHA256 认 */
  }
  return {};
}

/**
 * 确保流程目录与脚本存在。幂等,启动时调一次。
 *
 * 失败**不阻断启动** —— 流程脚本是增强,不是应用能跑起来的前提。建不出来只记一条
 * 警告:用户至少还能用清单文件那条老路读库。
 */
export function ensureWorkflows(): SeedReport {
  const report: SeedReport = { written: [], upgraded: [], keptModified: [] };
  try {
    mkdirSync(scriptsDir(), { recursive: true });
  } catch (err) {
    log.warn(`workflows: 建目录失败:${(err as Error).message}`);
    return report;
  }
  const record = readShippedRecord();
  let recordDirty = false;

  const files: Array<[string, string]> = [
    ["README.md", README],
    ["scripts/library.py", LIBRARY_PY],
    ["scripts/check_citations.py", CHECK_CITATIONS_PY],
    // 内置自动化「下载完自动转 Markdown」那一步跑的转录脚本(见 `builtins.ts`)。
    ["scripts/mineru_transcribe.py", MINERU_PY],
    // ⚠️ **外部检索脚本已移除**（2026-09-22 用户要求）。
    //
    // 原先这里还会铺一整套 `scripts/search-scripts/`（多源检索客户端、PubMed、
    // 分页遍历、引用核验），是从两个第三方技能仓库原样搬进来的。用户明确不要
    // 内置它们，连带工作区那个克隆一起删了 —— 所以这里不再写。
    //
    // 连带改过的地方（**别再往回加**）：
    //   - `lib/systemPrompt.ts` 里教模型用这些脚本的那几行也删了；
    //   - `searchScriptsAssets.ts` 与 `search-scripts/` 两个路径都已不存在。
    // 要恢复的话，别手抄：去 `github.com/Imbad0202/academic-research-skills` 重新
    // 克隆，再按当初那套生成脚本(一次性的，已随 `.scholar_tmp/` 移出源码树)重新生成。
  ];

  for (const [rel, body] of files) {
    const abs = join(workflowsRoot(), rel);
    const want = shippedHashOf(body);
    let kind: "written" | "upgraded" = "written";
    if (existsSync(abs)) {
      let have: string;
      try {
        have = shippedHashOf(readFileSync(abs, "utf8"));
      } catch (err) {
        log.warn(`workflows: 读 ${rel} 失败,不动它:${(err as Error).message}`);
        report.keptModified.push(rel);
        continue;
      }
      if (have === want) {
        // 已经是这一版(包括只差换行的)。补记录 —— 老安装第一次跑到这里时还没有。
        if (record[rel] !== want) { record[rel] = want; recordDirty = true; }
        continue;
      }
      const pristine = record[rel] === have || (LEGACY_SHIPPED_SHA256[rel] ?? []).includes(have);
      if (!pristine) {
        report.keptModified.push(rel);
        log.warn(`workflows: ${rel} 被改过,不覆盖 —— 它拿不到新版的修复(想要新版就删掉它再重启)`);
        continue;
      }
      kind = "upgraded";
    }
    try {
      // 剩下的两个脚本都在 `scripts/` 一层里；`recursive` 留着无妨
      // （从前 search-scripts 是嵌套的，现在没有了）。
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
      report[kind].push(rel);
      record[rel] = want;
      recordDirty = true;
    } catch (err) {
      log.warn(`workflows: 写 ${rel} 失败:${(err as Error).message}`);
    }
  }

  if (recordDirty) {
    try {
      writeFileSync(join(workflowsRoot(), SHIPPED_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (err) {
      log.warn(`workflows: 写 ${SHIPPED_RECORD_FILE} 失败:${(err as Error).message}`);
    }
  }
  if (report.upgraded.length > 0) log.info(`workflows: 已把没改过的旧版换成新版:${report.upgraded.join("、")}`);
  return report;
}
