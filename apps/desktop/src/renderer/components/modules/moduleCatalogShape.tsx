/**
 * 【T41】模块目录的**形状判据**与它的用户可见出口。
 *
 * ## 为什么单独一个文件
 *
 * 这两样东西被四个消费点共用(右栏 / 命令面板 / 模块视图坞 / 设置页),而它们住在
 * `ModuleContributions.tsx` 里的话,任何要单独验证"坏目录时用户看到什么"的套件都得
 * 把整棵渲染树(monaco、store、图标注册表……)一起拖进 esbuild。判据本身是纯的,
 * 就该放在一个纯的模块里 —— 这同时也是硬规矩 2「共享实现只有一份」的落点。
 *
 * ## 为什么不是一句 `?.`
 *
 * `catalog?.modules.flatMap(...)` 只挡住「目录还没读到」,没挡住「回包存在但
 * `modules` 缺失」。对它调 `.flatMap` 会**同步抛错**,而 `RightPanel` 是常驻面板、
 * 渲染期直接调用、主界面没有错误边界 —— 整棵树卸载,主界面白屏。
 *
 * 但只加可选链又会退化成另一种静默:返回空数组 → 用户已经打开的扩展视图无声消失。
 * 所以这里**分成两半**:
 *
 *   - {@link moduleCatalogShapeError} 说"这份数据不能信";
 *   - {@link contributionsOf} 在不能信时返回空(不抛,不炸页面);
 *   - {@link ModuleCatalogNotice} 把原因**渲染出来**,让用户知道不是自己没装扩展。
 *
 * 三者的判据同源 —— 都读同一个 `moduleCatalogShapeError`,不存在两套说法。
 */
import type { ModuleCatalog, ModuleContribution, ModuleManifest } from "@contracts/modules";
import { ErrorNote } from "@renderer/components/ui/error-note.js";
import { Button } from "@renderer/components/ui/button.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * 目录回包的**形状**校验 —— `modules` 必须是一个数组。
 *
 * 返回 `null` 表示"没有可判定的形状问题":要么 `undefined`(还没读到,是加载态,
 * 不是坏数据),要么形状正常。返回字符串表示**契约破坏**,字符串本身是给用户看的
 * 具体原因(缺字段 / 类型不对)。
 */
export function moduleCatalogShapeError(catalog: ModuleCatalog | undefined): string | null {
  if (catalog === undefined) return null; // 还没读到 —— 不是形状错误,加载态由 useRpc 管
  const modules = (catalog as { modules?: unknown }).modules;
  if (Array.isArray(modules)) return null;
  return modules === undefined ? "modules 字段缺失" : `modules 不是数组(${typeof modules})`;
}

export function contributionsOf<S extends ModuleContribution["slot"]>(
  catalog: ModuleCatalog | undefined, slot: S,
): Array<{ module: ModuleManifest; contribution: Extract<ModuleContribution, { slot: S }> }> {
  // 形状不对时**返回空而不是抛**。抛会让调用方(尤其 RightPanel 那条渲染期直接调用)
  // 整棵子树卸载;返回空至少不炸页面。「不炸」本身不构成本卡的验收 —— 调用方必须
  // 用 {@link ModuleCatalogNotice} 把原因显式渲染出来,那才是"不静默"。
  //
  // ⚠️【T49】`undefined` 单独判:它**不是**形状错误(那是"还没读到"的加载态,
  // `moduleCatalogShapeError` 对它返回 null),但下面要解引用 `catalog.modules`。
  // 四个生产调用点(RightPanel/CommandPalette/两个 Module 面板)都把 `useRpc` 的
  // `data` 直接传进来,而 `data` 在**第一次请求成功之前恒为 `undefined`** ——
  // 少了这一句,主界面首帧就 TypeError 白屏(实测复现见
  // `scripts/t49-contributions-undefined-smoke/`)。
  if (catalog === undefined || moduleCatalogShapeError(catalog) !== null) return [];
  return catalog.modules.flatMap(module => module.contributions.filter(
    (c): c is Extract<ModuleContribution, { slot: S }> => c.slot === slot,
  ).map(contribution => ({ module, contribution })));
}

/**
 * 把「目录读失败」与「目录形状异常」渲染成一条提示。
 *
 * 四个消费点共用这一份,不各写一遍文案与判据。没有问题时返回 `null`,调用方照常
 * 渲染自己的内容。
 *
 * `tone` 分两档:`catalog.error` 是"某次请求失败"(面板其余部分仍可用,黄色);
 * 形状异常是"这份数据不能信"(红色)。混成一档会让用户分不清"再试一次就好"和
 * "这次拿到的东西本身是坏的"。
 */
export function ModuleCatalogNotice({ catalog, className }: {
  /** `useModuleContributions()` 的返回值 —— 只取这三项,不把整个 hook 类型拖进来
   *  (那会把 ModuleContributions 的整棵 import 图带进无头套件的 esbuild)。 */
  catalog: { data: ModuleCatalog | undefined; error: globalThis.Error | null; refetch: () => Promise<void> };
  className?: string;
}) {
  const { t } = useI18n();
  const shapeError = moduleCatalogShapeError(catalog.data);
  const requestError = catalog.error;
  if (!shapeError && !requestError) return null;
  const fatal = shapeError !== null;
  return (
    <ErrorNote
      tone={fatal ? "danger" : "warning"}
      className={className}
      title={t(fatal ? "ide.modules.catalogInvalid" : "ide.modules.catalogError")}
      action={
        <Button size="sm" variant="ghost" onClick={() => void catalog.refetch()}>
          {t("common.retry")}
        </Button>
      }
    >
      {fatal
        ? t("ide.modules.catalogInvalidDetail", { detail: shapeError })
        : requestError?.message}
    </ErrorNote>
  );
}
