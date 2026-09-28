/**
 * 首次启动的**文献菜单预置**(2026-09-28,"你来给我搭好"):用户从没配置过自定义 UI
 * (设置键为空 / items 为空)时,按他**现有的自动化**自动搭出常用项,开箱即用。
 *
 * ## 绑定规则(必须可解释,绑错比不绑更糟)
 *
 *   - **转录**:`kind === "event"` 的触发器(库事件自动化的结构特征,与
 *     `runWithTarget` 的事件同形假设一致);多条时优先名字像转录的
 *     (转录/markdown/mineru),再退到第一条。绑了哪条写进 `notes`,toast 打印。
 *   - **文献导入**:名字含 下载/download/doi 的任意触发器 —— 没有结构特征可依,
 *     只认名字;认不出**如实说缺**,不瞎绑。
 *
 * 纯函数(只依赖 contracts 类型):冒烟直接钉规则(custom-ui-smoke)。
 * 调用方在 `customUiStore.load()`:构建 → save → 按 notes 弹 toast。
 */
import type { CustomUiItem } from "@contracts/customUi";

export interface SeedWorkflow {
  id: string;
  name: string;
  hasTrigger: boolean;
}
export interface SeedTrigger {
  workflowId: string;
  nodeId: string;
  title: string;
  kind: string;
}

/** 绑定结果说明(结构化 —— 文案在调用方过 i18n,这里不硬编码用户可见字符串)。 */
export type SeedNote =
  | { kind: "transcribe"; workflowName: string }
  | { kind: "import"; workflowName: string }
  | { kind: "missingTranscribe" }
  | { kind: "missingImport" };

export interface SeedResult {
  items: CustomUiItem[];
  notes: SeedNote[];
}

const RE_TRANSCRIBE = /转录|markdown|mineru/i;
const RE_DOWNLOAD = /下载|download|doi/i;

/** 条目信息卡正文(view 模板;与设置页 itemInfo 模板同一张卡)。 */
const INFO_BODY = [
  "**语言**:{{item.language}}",
  "",
  "**链接**:{{item.url}}",
  "",
  "**PDF**:{{item.pdfPath}}",
  "",
  "**转录**:{{item.mdPath}}",
  "",
  "**文件**:{{item.filePath}}",
  "",
  "---",
  "",
  "{{item.abstract}}",
].join("\n");

export function buildDefaultLibraryItems(
  workflows: readonly SeedWorkflow[],
  triggers: readonly SeedTrigger[],
): SeedResult {
  const items: CustomUiItem[] = [];
  const notes: SeedNote[] = [];
  const nameOf = (wfId: string): string => workflows.find((w) => w.id === wfId)?.name ?? wfId;

  // 1) 条目信息卡:零依赖,永远预置(「文献信息」内置项退役后的替代)。
  items.push({
    id: "seed-item-info",
    slot: "library.item",
    label: { zh: "条目信息", en: "Item info" },
    icon: "eye",
    action: { type: "view", title: "{{item.title}}", body: INFO_BODY },
  });

  // 2) 转录(手动兜漏 + 分类/小类批量,全部带 skipWhen: 已有转录跳过)。
  const events = triggers.filter((t) => t.kind === "event");
  const transcribe =
    events.find((t) => RE_TRANSCRIBE.test(t.title) || RE_TRANSCRIBE.test(nameOf(t.workflowId))) ?? events[0];
  if (transcribe !== undefined) {
    const bind = { workflowId: transcribe.workflowId, triggerNodeId: transcribe.nodeId } as const;
    const skip = { skipWhen: { requires: "markdown" as const } };
    items.push({
      id: "seed-transcribe",
      slot: "library.item",
      label: { zh: "手动转录(漏转补齐)", en: "Transcribe (catch-up)" },
      icon: "file-text",
      action: { type: "automation", ...bind, ...skip },
    });
    items.push({
      id: "seed-batch-transcribe",
      slot: "library.collection",
      label: { zh: "批量转录(跳过已转录)", en: "Batch transcribe" },
      icon: "file-text",
      action: { type: "automation", ...bind, ...skip },
    });
    items.push({
      id: "seed-batch-transcribe-sub",
      slot: "library.subcategory",
      label: { zh: "批量转录(跳过已转录)", en: "Batch transcribe" },
      icon: "file-text",
      action: { type: "automation", ...bind, ...skip },
    });
    notes.push({ kind: "transcribe", workflowName: nameOf(transcribe.workflowId) });
  } else {
    notes.push({ kind: "missingTranscribe" });
  }

  // 3) 文献导入(选 PDF / 填 DOI → 下载自动化)。
  const download = triggers.find(
    (t) => RE_DOWNLOAD.test(t.title) || RE_DOWNLOAD.test(nameOf(t.workflowId)),
  );
  if (download !== undefined) {
    const bind = { workflowId: download.workflowId, triggerNodeId: download.nodeId } as const;
    const inputs = [
      { key: "files", kind: "files" as const, label: { zh: "文献文件(PDF 等,可多选)", en: "Literature files" } },
      { key: "doi", kind: "text" as const, label: { zh: "DOI 或 arXiv 号(可多个,用逗号分隔)", en: "DOI or arXiv ID (comma-separated)" } },
    ];
    // `targetMode: "context"`:右键的分类是**落点**(收进这儿),不是"这次要办的那一批"
    // —— 少了它,空分类会被「这个范围里没有条目」挡死,而往空分类里导文献正是最常见的
    // 用法(2026-09-28)。
    const asContext = { targetMode: "context" as const, inputs };
    items.push({
      id: "seed-lit-import",
      slot: "library.collection",
      label: { zh: "文献导入(PDF / DOI)", en: "Literature import" },
      icon: "download",
      action: { type: "automation", ...bind, ...asContext },
    });
    items.push({
      id: "seed-lit-import-sub",
      slot: "library.subcategory",
      label: { zh: "文献导入(PDF / DOI)", en: "Literature import" },
      icon: "download",
      action: { type: "automation", ...bind, ...asContext },
    });
    notes.push({ kind: "import", workflowName: nameOf(download.workflowId) });
  } else {
    notes.push({ kind: "missingImport" });
  }

  return { items, notes };
}

