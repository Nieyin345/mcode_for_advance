/**
 * `kind: "code"` 的参数控件 —— 画布上一小块**只读预览**,点开是一扇挂着 IDE 那同一个
 * 编辑器(Monaco)的模态窗。
 *
 * ## 为什么不直接把编辑器摆在检查器里
 *
 * 检查器是一条**窄栏**(节点参数一条挨一条),而代码要的是宽和高:一段三十行的转录
 * 脚本在 90px 高的 textarea 里翻,和在记事本里改没有区别。摆进去还会把它下面的参数
 * 顶到屏幕外 —— 「超时」「输出变量」这些是同一次配置里要一起看的东西。
 *
 * 所以这里的分工是:**那一栏只回答"这一格现在是什么"**(前几行 + 行数),要动手就
 * 进模态窗。
 *
 * ## 为什么编辑器是懒加载的
 *
 * Monaco 是整个应用里最大的一块 JS。设置页本身不该为"有可能要改代码"付这笔钱 ——
 * 打开工作流列表、看一眼节点、关掉,这条路一次都用不到编辑器。所以模态窗整个走
 * `lazy()`:**点了「在编辑器中打开」才去取**。这也是渲染进程既有的规矩(见
 * `monacoSetup.ts` 与那次 "defer heavy editors off the first-paint path")。
 *
 * ## 值什么时候写回
 *
 * **每一次击键都写回**,和它取代的那个 `<textarea>` 完全一样。
 *
 * 曾经想过"确定才生效、取消就丢弃" —— 那样模态窗要自己管一份草稿,还要在关窗时
 * 判断脏不脏、要不要拦一下。而它换来的好处是假的:工作流本来就有自己的保存态
 * (`SaveStateLine`),用户心里的"还没存"指的是那一个,不是这扇窗。两套"存"叠在一起,
 * 只会让人搞不清关掉窗到底算不算数。
 */
import { Suspense, lazy, useId, useState } from "react";
import { Button, Spinner } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCode } from "@renderer/lib/icons.js";

const CodeParamDialog = lazy(async () => ({
  default: (await import("./CodeParamDialog.js")).CodeParamDialog,
}));

/** 预览里最多印几行。再多也没用:那一栏就那么宽,读完前几行就该点开了。 */
const PREVIEW_LINES = 6;

export function CodeParamField({
  label,
  value,
  language,
  onChange,
}: {
  label: string;
  value: string;
  /** 节点上「Language」那一格此刻的值(python / node / shell / powershell)。 */
  language: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 每个挂载实例一个,免得两个节点的「代码」共用一个 Monaco model —— 那会串内容。
  const modelId = useId();
  const lines = value === "" ? 0 : value.split("\n").length;
  const preview = value.split("\n").slice(0, PREVIEW_LINES).join("\n");

  return (
    <div className="rounded border border-edge bg-surface">
      {value === "" ? (
        <p className="px-2 py-3 text-[0.7143em] text-content-subtle">
          {t("settings.workflows.codeParam.empty")}
        </p>
      ) : (
        <pre
          aria-label={label}
          className="max-h-[132px] overflow-hidden whitespace-pre px-2 py-1.5 font-mono text-[0.7143em] leading-relaxed text-content-muted"
        >
          {preview}
        </pre>
      )}
      <div className="flex items-center justify-between border-t border-edge px-2 py-1">
        <span className="text-[0.7143em] text-content-subtle">
          {t("settings.workflows.codeParam.lines", { count: String(lines) })}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <IconCode size={13} className="mr-1" />
          {t("settings.workflows.codeParam.open")}
        </Button>
      </div>
      {/* 关掉就整个卸载 —— 编辑器不常驻(它是这一页里最贵的东西)。 */}
      {open && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <CodeParamDialog
            label={label}
            value={value}
            language={language}
            modelId={modelId}
            onChange={onChange}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
