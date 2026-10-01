/**
 * 设置 → 项目初始化。
 *
 * 每个「场景」是一套初始化方案:要建的文件夹、预置文件、项目记忆,以及要不要在初始化后
 * 让 AI 分析项目、写项目说明文件(AGENTS.md / CLAUDE.md,对应 Claude Code / Codex 的
 * `/init`)。对话里输入 `/init` 选场景(预选这里设的默认场景),或 `/init-场景名` 直接用。
 * 编辑器本身在 memory/ProjectInitManager(以前挂在「记忆与上下文」的一个标签页里)。
 */
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconTemplate } from "@renderer/lib/icons.js";
import { ProjectInitManager } from "../memory/ProjectInitManager.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { PanelHeader } from "./PanelHeader.js";

export function ProjectInitPanel() {
  const { t } = useI18n();
  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form}`}>
      <PanelHeader title={t("init.title")} icon={IconTemplate} />
      <p className="px-4 pt-3 text-sm leading-relaxed text-content-muted">{t("init.panelIntro")}</p>
      <ProjectInitManager />
    </section>
  );
}
