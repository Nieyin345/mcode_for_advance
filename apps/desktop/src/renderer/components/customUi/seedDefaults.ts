/**
 * 首次启动的**文献菜单预置**(2026-09-28,"你来给我搭好"):用户从没配置过自定义 UI
 * (设置键为空 / items 为空)时,按他**现有的自动化**自动搭出常用项,开箱即用。
 *
 * ## 绑定规则(必须可解释,绑错比不绑更糟)
 *
 *   - **转录**:`kind === "event"` 的触发器(库事件自动化的结构特征,与
 *     `runWithTarget` 的事件同形假设一致);多条时优先名字像转录的
 *     (转录/markdown/mineru)，且必须只有一个候选；不猜测无关或歧义绑定。
 *   - **文献导入**:名字含 下载/download/doi 的任意触发器 —— 没有结构特征可依,
 *     只认名字;认不出**如实说缺**,不瞎绑。
 *   - 两条都**先认内置自动化的 id**(见 `BUILTIN_TRANSCRIBE` / `BUILTIN_IMPORT`),名字规则
 *     只给用户自建的自动化兜底。
 *
 * 纯函数(只依赖 contracts 类型):冒烟直接钉规则(custom-ui-smoke)。
 * 调用方在 `customUiStore.load()`:构建 → save → 按 notes 弹 toast。
 */
import type { CustomUiItem } from "@contracts/customUi";
import type { Locale } from "@contracts/ipc";
import { translate } from "@renderer/lib/i18n/core.js";

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

/**
 * 内置自动化的固定落点 —— 与 `main/orchestration/builtins.ts` 的
 * `AUTO_CONVERT_WORKFLOW_ID` / `AUTO_CONVERT_TRIGGER_NODE_ID`、
 * `AUTO_DOWNLOAD_WORKFLOW_ID` / `AUTO_DOWNLOAD_TRIGGER_NODE_ID` 同值(渲染端不能 import main;
 * custom-ui-smoke 拿**真的** `BUILTIN_WORKFLOWS` 钉住,两边漂了会红)。
 *
 * **先认 id,名字只是兜底。** 只按名字认时,内置「转 Markdown」的触发器标题
 * 「文件导入或下载完成触发」含「下载」,和内置「文献导入(PDF / DOI)」一起命中导入规则 →
 * 两个候选 → 按歧义规则不绑 —— 全新安装的用户右键分类看不到「文献导入」,首启 toast
 * 还说「没找到导入自动化」(2026-09-30)。
 */
const BUILTIN_TRANSCRIBE = { workflowId: "wf_auto_convert", nodeId: "auto-convert-trigger" } as const;
const BUILTIN_IMPORT = { workflowId: "wf_auto_download", nodeId: "auto-download-trigger" } as const;

function isAt(t: SeedTrigger, at: { workflowId: string; nodeId: string }): boolean {
  return t.workflowId === at.workflowId && t.nodeId === at.nodeId;
}

/** 条目信息卡正文。**按当前界面语言取词典**,不再硬编码中文 —— 英文界面的用户
 *  首次启动右键看到的是一整张中文卡(`**语言**` / `**链接**`……),而设置页里同一个
 *  模板(`CustomUiPanel` 的 itemInfo)一直是走 `customUi.template.itemInfo.body` 的,
 *  两处正文本来就该同源。这里是模板变量拼的 Markdown,走 `translate` 纯函数即可
 *  (与 `CustomUiPanel.templateDraft` 同一条路)。 */
function infoBody(locale: Locale): string {
  return translate(locale, "customUi.template.itemInfo.body");
}

export function buildDefaultLibraryItems(
  workflows: readonly SeedWorkflow[],
  triggers: readonly SeedTrigger[],
  locale: Locale = "zh",
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
    action: { type: "view", title: "{{item.title}}", body: infoBody(locale) },
  });

  // 2) 转录(手动兜漏 + 分类/小类批量,全部带 skipWhen: 已有转录跳过)。
  const eligible = triggers.filter(t => workflows.some(w => w.id === t.workflowId && w.hasTrigger));
  const candidates = eligible.filter(t => t.kind === "event" && (RE_TRANSCRIBE.test(t.title) || RE_TRANSCRIBE.test(nameOf(t.workflowId))));
  const transcribe = eligible.find((t) => t.kind === "event" && isAt(t, BUILTIN_TRANSCRIBE))
    ?? (candidates.length === 1 ? candidates[0] : undefined);
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
  // 已被认作「转录」的触发器不再参与导入的名字匹配(它的标题里常带「下载完成」)。
  const downloads = eligible.filter(
    (t) => !candidates.includes(t) && t !== transcribe
      && (RE_DOWNLOAD.test(t.title) || RE_DOWNLOAD.test(nameOf(t.workflowId))),
  );
  const download = eligible.find((t) => isAt(t, BUILTIN_IMPORT))
    ?? (downloads.length === 1 ? downloads[0] : undefined);
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

