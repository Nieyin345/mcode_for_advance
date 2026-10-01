/**
 * 出厂的项目初始化模板(2026-09-30)。
 *
 * 初始化器本身是纯用户数据(`projectInit.template.<uuid>`,见 `service.ts`);新装的用户
 * 打开「记忆与上下文 → 初始化」却是一片空白,不知道这东西能干什么。于是出厂带一份
 * 「研究项目」:建好一套目录、每个目录放一份 README 说清楚它装什么,再写两条置顶的项目
 * 记忆(目录约定 + 项目概况),让之后在这个项目里的每一轮对话都知道东西该往哪放。
 *
 * ## 播种语义 —— 与出厂工作流(`orchestration/library.ts` 的 `ensureShippedSeeded`)同一取向
 *
 * - 按**固定 id** 只播种一次,播过的 id 记进 `projectInit.seededShipped`;
 * - 播下去就是一条**普通模板**:可改、可删;删了**不复活**(id 已在清单里);
 * - 用户已经有同名模板(命令名冲突)时不播,也记进清单 —— 不抢用户的名字。
 *
 * 模板只在用户输入 `/init`(选场景)或 `/init-场景名` 并在预览里确认后才落盘;已存在的文件 /
 * 记忆一律跳过,从不覆盖(见 `service.ts` 文件头)。
 *
 * ## 2026-10:三个场景 + AI 生成说明文件
 *
 * 每个场景都可以让当前引擎分析项目、生成 AGENTS.md(见契约里的 `buildAgentFilePrompt`)。
 * 「代码项目」就是 Claude Code / Codex 的 `/init`:不建目录,只生成说明文件。
 * 「研究项目」是先出厂的,老用户库里已经有一份不带 AI 生成的:`upgradeAddsAgentFile` 让
 * **从没改过**的那份原地升级(见 `service.ts` 的 `upgradeUntouchedShipped`)。所以 RESEARCH
 * 除了 agentFile 之外的内容**不要再改** —— 改了老用户那份就不再「逐字相等」,升级不了。
 */
import type { ProjectInitDraft } from "@contracts/ipc/projectInit";

export interface ShippedInitializer {
  /** 固定 UUID —— 播种清单靠它认「播过没有」。**不要改**,改了等于换一份新模板重新播。 */
  id: string;
  draft: ProjectInitDraft;
  /** 老版本出厂时没有 agentFile:用户没改过的那份原地补上(只为「研究项目」设)。 */
  upgradeAddsAgentFile?: true;
}

const readme = (title: string, body: string): string => `# ${title}\n\n${body.trim()}\n`;

const RESEARCH: ProjectInitDraft = {
  name: "研究项目",
  description:
    "研究 / 论文类项目的标准骨架:建好 notes、references、data、code、experiments、results、drafts、archive 等目录," +
    "每个目录附一份 README 说明用途;并写入两条置顶项目记忆(目录约定、项目概况),让助手在这个项目里始终按同一套结构存放文件。",
  directories: [
    "notes",
    "references",
    "data/raw",
    "data/processed",
    "code",
    "experiments",
    "results/figures",
    "results/tables",
    "drafts",
    "archive",
  ],
  files: [
    {
      path: "notes/README.md",
      content: readme("notes — 笔记", `
阅读笔记、想法、讨论与会议记录。

- 一篇文献一份笔记,文件名用 \`作者-年份-关键词.md\`(如 \`smith-2023-attention.md\`)。
- 会议 / 讨论记录用 \`YYYY-MM-DD-主题.md\`。
- 零散想法先记在 \`ideas.md\`,成形后再拆出去。
`),
    },
    {
      path: "references/README.md",
      content: readme("references — 参考文献", `
引用管理相关的文件:BibTeX(\`.bib\`)、引用样式(\`.csl\`)、文献清单。

- PDF 原文建议导入资料库统一管理;这里只放写作时直接要用的引用数据。
- 主参考文献文件固定叫 \`references.bib\`,写作时从这里引用。
`),
    },
    {
      path: "data/README.md",
      content: readme("data — 数据", `
- \`raw/\`:**原始数据,只读**。拿到后不再修改;在下面记录来源、获取日期与许可。
- \`processed/\`:清洗 / 转换后的数据,必须能由 \`code/\` 里的脚本从 \`raw/\` 重新生成。

大文件不要提交进版本库;在这里写清楚从哪里下载即可。

## 数据来源

| 文件 | 来源 | 获取日期 | 许可 |
|---|---|---|---|
`),
    },
    {
      path: "code/README.md",
      content: readme("code — 代码", `
数据处理、分析与实验脚本。

- 脚本从项目根目录运行,路径一律写相对路径(\`data/raw/...\`)。
- 依赖写进 \`requirements.txt\` / \`environment.yml\` 等,放在这个目录或项目根目录。
- 可复用的函数抽到模块里,一次性的探索放 \`scratch/\`。
`),
    },
    {
      path: "experiments/README.md",
      content: readme("experiments — 实验记录", `
每次实验一个子目录,命名 \`YYYY-MM-DD-简述\`(如 \`2026-10-01-baseline\`),里面放:

- \`config\`:这次用的参数 / 配置;
- \`log\`:运行日志;
- \`README.md\`:目的、做法、结论,以及和上一次相比改了什么。

失败的实验也保留并写明原因 —— 它们同样是结果。
`),
    },
    {
      path: "results/README.md",
      content: readme("results — 结果", `
可以直接进论文 / 报告的产出。

- \`figures/\`:图(建议同时保存矢量格式 \`.pdf\` / \`.svg\` 与 \`.png\`)。
- \`tables/\`:表(\`.csv\` / \`.tex\` / \`.md\`)。

每个产出都应能追溯到生成它的脚本或实验目录;在文件名或旁边的说明里注明。
`),
    },
    {
      path: "drafts/README.md",
      content: readme("drafts — 草稿", `
论文、报告、幻灯片的草稿。

- 主稿固定一个文件,重大修改前另存 \`v1\`、\`v2\`……或依赖版本库。
- 审稿意见与回复放 \`review/\`。
`),
    },
    {
      path: "archive/README.md",
      content: readme("archive — 归档", `
不再使用但暂时不想删的材料:废弃的草稿、旧版本数据、放弃的思路。

移进来时在文件名或这里记一笔原因和日期,别让它变成第二个杂物间。
`),
    },
  ],
  memories: [
    {
      category: "rules",
      filename: "项目目录约定.md",
      title: "项目目录约定",
      pinned: true,
      content: `本项目按以下目录组织,新建或移动文件时照此存放(每个目录里有 README 详细说明):

- notes/ — 阅读笔记、想法、会议记录
- references/ — BibTeX 等引用数据
- data/raw/ — 原始数据,**只读,不得修改**
- data/processed/ — 由脚本从 raw 生成的数据
- code/ — 数据处理、分析与实验脚本
- experiments/ — 每次实验一个子目录(YYYY-MM-DD-简述),含配置、日志与结论
- results/figures/、results/tables/ — 可直接进论文的图表
- drafts/ — 论文 / 报告草稿
- archive/ — 废弃但保留的材料

规则:
1. 不修改 data/raw/ 里的任何文件。
2. 生成的数据、图表必须能由 code/ 里的脚本复现;脚本用项目根目录的相对路径。
3. 不确定文件该放哪时,先问用户,不要在项目根目录随手新建文件。`,
    },
    {
      category: "project",
      filename: "项目概况.md",
      title: "项目概况",
      pinned: true,
      content: `(待补充 —— 了解到以下信息后,与用户确认并更新这条记忆)

- 研究问题:
- 目标产出(论文 / 报告 / 毕业论文 / 其他):
- 关键时间节点:
- 当前进度:
- 主要方法与数据:`,
    },
  ],
  agentFile: {
    enabled: true,
    filename: "AGENTS.md",
    focus: `这是研究 / 论文类项目。说明文件重点写:
- 研究问题与目标产出(论文 / 报告 / 毕业论文);信息不足时留「待补充」,不要猜;
- 各目录的用途与存放规则:data/raw 只读;生成的数据和图表必须能由 code/ 里的脚本复现;
- 实验怎么组织(experiments/ 下一次一个目录)、怎么复现一次实验;
- 写作约定:主稿在哪、引用数据(references/references.bib)、图表格式。`,
  },
};

const CODE: ProjectInitDraft = {
  name: "代码项目",
  description:
    "相当于 Claude Code / Codex 的 /init:不建任何目录,只让 AI 分析现有代码库,生成(已有则改进)AGENTS.md ——" +
    "常用命令、整体架构、代码与提交约定。适合已经有代码的仓库。",
  directories: [],
  files: [],
  memories: [],
  agentFile: {
    enabled: true,
    filename: "AGENTS.md",
    focus: `这是软件 / 代码仓库。参照 Claude Code 与 Codex 的 /init,重点写:
- 构建、运行、测试、代码检查的命令,特别是怎么只跑单个测试;
- 需要读多个文件才能看懂的整体架构:模块划分、入口、数据流、关键抽象;
- 代码风格与命名约定,用到的格式化 / lint 工具;
- 测试框架、测试文件放在哪、怎么命名;
- 从 git 历史总结出的提交信息写法;
- 生成的代码、锁文件等不该手动修改的位置。`,
  },
};

const THESIS: ProjectInitDraft = {
  name: "论文写作",
  description:
    "论文 / 学位论文写作项目:建好 manuscript(主稿与分章)、figures、references、reviews、submissions、notes 目录," +
    "每个目录附 README;写入一条置顶的写作约定;再让 AI 生成 AGENTS.md(目标期刊、编译方式、引用与图表规范)。",
  directories: ["manuscript/sections", "figures", "references", "reviews", "submissions", "notes"],
  files: [
    {
      path: "manuscript/README.md",
      content: readme("manuscript — 主稿", `
论文主稿与分章文件。

- 主文件固定一个:LaTeX 用 \`main.tex\`,Word 用 \`main.docx\`。
- 分章放 \`sections/\`,文件名带序号(如 \`01-introduction.tex\`),主文件里按顺序引入。
- 大改之前打个版本(依赖版本库,或在 \`submissions/\` 留定稿快照),不要在文件名里堆 \`final-final\`。
`),
    },
    {
      path: "figures/README.md",
      content: readme("figures — 图", `
论文里用到的图。

- 每张图都要能重新生成:保留生成脚本或源文件(\`.py\` / \`.drawio\` / \`.svg\`),和导出的图放在一起。
- 导出优先矢量格式(\`.pdf\` / \`.svg\`);位图至少 300 dpi。
- 文件名与正文里的引用标签一致(如 \`fig-system-model.pdf\` ↔ \`\\label{fig:system-model}\`)。
`),
    },
    {
      path: "references/README.md",
      content: readme("references — 参考文献", `
- 参考文献文件固定叫 \`references.bib\`,正文只引用这里有的条目。
- 引用样式文件(\`.bst\` / \`.csl\`)也放这里。
- PDF 原文建议导入资料库统一管理,这里只放写作直接要用的引用数据。
`),
    },
    {
      path: "reviews/README.md",
      content: readme("reviews — 意见与回复", `
导师意见、审稿意见与逐条回复。

- 每一轮一个文件:\`YYYY-MM-DD-来源.md\`(如 \`2026-10-01-reviewer2.md\`)。
- 回复逐条对应原意见,写明改了哪里(章节 / 页码)。
`),
    },
    {
      path: "submissions/README.md",
      content: readme("submissions — 提交快照", `
每次投稿 / 提交的定稿快照,**只读**。

- 一次一个子目录:\`YYYY-MM-DD-去向\`(如 \`2026-10-01-IEEE-TCOM\`),放当时提交的 PDF 与源文件。
- 之后的修改一律在 \`manuscript/\` 里做,不回头改快照。
`),
    },
    {
      path: "notes/README.md",
      content: readme("notes — 写作笔记", `
提纲、思路、待办与讨论记录。

- 总提纲放 \`outline.md\`,随写作推进更新。
- 讨论 / 组会记录用 \`YYYY-MM-DD-主题.md\`。
`),
    },
  ],
  memories: [
    {
      category: "rules",
      filename: "写作约定.md",
      title: "论文写作约定",
      pinned: true,
      content: `本项目是论文写作项目,文件按以下目录存放(每个目录里有 README 详细说明):

- manuscript/ — 主稿(main.tex 或 main.docx)与 sections/ 分章
- figures/ — 图及其生成脚本 / 源文件
- references/ — references.bib 与引用样式
- reviews/ — 导师 / 审稿意见与逐条回复
- submissions/ — 每次提交的定稿快照,只读
- notes/ — 提纲与写作笔记

规则:
1. 只引用 references/references.bib 里已有的文献;**不编造文献、不编造数据**。缺引用时告诉用户,而不是自己补一条。
2. 不修改 submissions/ 里的任何文件。
3. 改正文时保持术语、符号和时态前后一致;大段改写前先说明打算怎么改。`,
    },
  ],
  agentFile: {
    enabled: true,
    filename: "AGENTS.md",
    focus: `这是论文 / 学位论文写作项目。说明文件重点写:
- 目标期刊 / 会议或学位要求(字数、格式模板);不知道就留「待补充」;
- 主稿格式与编译方式:LaTeX 用什么引擎、怎么编译(如 latexmk -xelatex main.tex);Word 主文件在哪;
- 章节结构与各章对应的文件;
- 引用规范:引用样式、bib 文件位置、不编造文献;
- 图表规范:放哪、格式、怎么重新生成;
- 审稿意见的处理流程(reviews/ 与 submissions/ 的用法)。`,
  },
};

/** 顺序即播种顺序;RESEARCH 保持第一个(project-init-smoke 按下标取它)。 */
export const SHIPPED_INITIALIZERS: readonly ShippedInitializer[] = [
  { id: "7a3c5e0b-2f4d-4b8a-9c1e-6d0f3a8b5c21", draft: RESEARCH, upgradeAddsAgentFile: true },
  { id: "3e8d1f52-6b7a-4c3e-9f20-8a1d5c7b4e63", draft: CODE },
  { id: "c51a9e07-2d84-4f6b-b3a9-0e7c62d58f14", draft: THESIS },
];
