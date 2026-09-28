/**
 * 右栏 Files 文件右键里**可配置的那一段**(挂载位 `files.context`)。
 *
 * 三种来源拼在一起,按「设置 → 自定义 UI」的配置排:
 *
 *   - 内置项:加入对话、用浏览器打开(HTML)—— 由 FileTree 递进来;
 *   - 模块项:v1 JSON 模块清单声明的文件工具,按扩展名筛(从前 `ModuleMenuItems` 那一段);
 *   - 自定义项:用户建的。
 *
 * 复制路径 / 在文件管理器中显示 / 重命名 / 删除这类管理项不在这里,仍是 FileTree 固定的。
 */
import { useMemo, type ReactNode } from "react";
import { moduleKey, type CustomUiTarget } from "@contracts/customUi";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useModuleSurface } from "@renderer/components/modules/ModuleSurface.js";
import { CustomUiMenuEntries, type BuiltinRuntime, type ModuleEntryRuntime } from "./CustomUiMenuItems.js";

export function FileMenuEntries({
  path,
  projectPath,
  itemClass,
  builtins,
  before,
  after,
}: {
  path: string;
  projectPath: string;
  itemClass: string;
  builtins: Readonly<Record<string, BuiltinRuntime | undefined>>;
  before?: ReactNode;
  after?: ReactNode;
}) {
  const { locale } = useI18n();
  const surface = useModuleSurface();
  const modules = useMemo<ModuleEntryRuntime[]>(() => {
    if (!surface?.catalog) return [];
    const lower = path.toLowerCase();
    return surface.catalog.modules.flatMap((module) =>
      module.contributions
        .filter((c) => !c.extensions || c.extensions.some((ext) => lower.endsWith(ext)))
        .map((contribution) => ({
          key: moduleKey(module.id, contribution.id),
          label: contribution.title[locale],
          disabled: surface.busy,
          run: () => void surface.invoke(module, contribution, path),
        })),
    );
  }, [surface, path, locale]);
  const target = useMemo<CustomUiTarget>(() => ({ kind: "file", projectPath, path }), [projectPath, path]);
  return (
    <CustomUiMenuEntries
      slot="files.context"
      target={target}
      builtins={builtins}
      modules={modules}
      itemClass={itemClass}
      before={before}
      after={after}
    />
  );
}
