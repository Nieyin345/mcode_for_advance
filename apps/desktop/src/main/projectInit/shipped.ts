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
 * 模板只在用户输入 `/init-研究项目` 并在预览里确认后才落盘;已存在的文件 / 记忆一律跳过,
 * 从不覆盖(见 `service.ts` 文件头)。
 */
import type { ProjectInitDraft } from "@contracts/ipc/projectInit";

export interface ShippedInitializer {
  /** 固定 UUID —— 播种清单靠它认「播过没有」。**不要改**,改了等于换一份新模板重新播。 */
  id: string;
  draft: ProjectInitDraft;
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
- 主文献库文件固定叫 \`references.bib\`,写作时从这里引用。
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
};

export const SHIPPED_INITIALIZERS: readonly ShippedInitializer[] = [
  { id: "7a3c5e0b-2f4d-4b8a-9c1e-6d0f3a8b5c21", draft: RESEARCH },
];
