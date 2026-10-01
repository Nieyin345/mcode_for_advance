/**
 * 文档工具链面板(挂「设置 → 内核」页,在三个 agent 内核下面)。
 *
 * ## 它解决的是什么
 *
 * 四个内置文档技能随应用发布,但它们要调的**工具**是机器级的:pandoc、python 的
 * 若干包、zip、LibreOffice、poppler。换一台干净电脑,技能在那里、工具不在,一到
 * 要读 Word 就失败 —— 而且失败得莫名其妙。这一块把"能不能跑"变成看得见的状态,
 * 并且能装的应用自己装。
 *
 * ## 为什么是独立文件而不是塞进 RuntimesPanel
 *
 * 两件事的**数据源不同**:内核状态在 sessionStore(启动时水合、全局共享),工具链
 * 状态是这一块自己拉的(它是本机探测,和会话无关)。塞一起会让那个 store 多背一份
 * 与它会话模型无关的状态。至于渲染,它就在同一个页面、同一个视觉层级里。
 *
 * ## 网络与桌面独占
 *
 * `api.toolchain` 在手机端的 web shim 里**不存在**,访问会同步抛错 —— 所以
 * check() 与事件订阅都包在 try/catch 里(见 webApi.ts 顶部那条纪律:effect 里
 * 漏出去的同步异常会让 React 19 整棵卸载)。这个面板本身是桌面端专属,但包一层
 * 的成本是零,收益是"以后有人在别处复用它不会炸"。
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { SettingsSection } from "./SettingsSection.js";
import { OnlyOfficeConfigCard } from "./OnlyOfficeConfigCard.js";
import type { ToolchainToolId, ToolchainToolState } from "@contracts/ipc";
import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconLoader2,
  IconPackage,
  IconRefresh,
  IconTrash,
} from "@renderer/lib/icons.js";

/** 显示名 —— 除 Python 那一项以外都是专有名词,原样显示(与同页的 AGENT_META
 *  同一约定);Python 那一项是**说法**不是名词("Python 文档处理库"指的是这堆包
 *  *给什么用*),所以走词典键。表在模块顶层,拿不到语言 hook,故存键、渲染时 t()。 */
const TOOL_META: Record<ToolchainToolId, { label: string } | { labelKey: MessageId }> = {
  pandoc: { label: "Pandoc" },
  latex: { label: "LaTeX" },
  "python-deps": { labelKey: "settings.toolchain.tool.pythonDeps.label" },
  "zip-tools": { label: "zip / unzip" },
  soffice: { label: "LibreOffice" },
  pdftoppm: { label: "poppler" },
  onlyoffice: { label: "ONLYOFFICE" },
};

/** 文案键写死在这里,而不是 `t(\`settings.toolchain.tool.${id}.what\`)`。
 *  拼接出来的键在类型上是 `string`,得 `as never` 才过 —— 那等于把"键名打错"
 *  这件事从编译期推到运行期(运行期只会显示成键名本身,很难发现)。写成字面量
 *  映射,拼错任何一条都编译不过。 */
const TOOL_TEXT: Record<ToolchainToolId, { what: MessageId; howto: MessageId }> = {
  pandoc: {
    what: "settings.toolchain.tool.pandoc.what",
    howto: "settings.toolchain.tool.pandoc.howto",
  },
  latex: {
    what: "settings.toolchain.tool.latex.what",
    howto: "settings.toolchain.tool.latex.howto",
  },
  "python-deps": {
    what: "settings.toolchain.tool.pythonDeps.what",
    howto: "settings.toolchain.tool.pythonDeps.howto",
  },
  "zip-tools": {
    what: "settings.toolchain.tool.zip.what",
    howto: "settings.toolchain.tool.zip.howto",
  },
  soffice: {
    what: "settings.toolchain.tool.soffice.what",
    howto: "settings.toolchain.tool.soffice.howto",
  },
  pdftoppm: {
    what: "settings.toolchain.tool.pdftoppm.what",
    howto: "settings.toolchain.tool.pdftoppm.howto",
  },
  onlyoffice: {
    what: "settings.toolchain.tool.onlyoffice.what",
    howto: "settings.toolchain.tool.onlyoffice.howto",
  },
};

export function ToolchainSection() {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolchainToolState[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  // 下载进度是瞬时渲染态,不往 store 里放(与 RuntimesPanel 同一取舍)。
  const [progress, setProgress] = useState<Partial<Record<ToolchainToolId, number>>>({});

  const reload = useCallback(async () => {
    try {
      const res = await api.toolchain.check();
      setTools(res.tools);
      setFatal(null);
    } catch (err) {
      // 桌面端正常不会走到这里;手机端 / 主进程异常时兜住,不让它冒到 effect 外
      setFatal((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let unsubscribe: () => void = () => {};
    try {
      unsubscribe = api.on.toolchainEvent((msg) => {
        const p = msg.payload;
        if (p.phase === "downloading" || p.phase === "installing") {
          setProgress((prev) => ({ ...prev, [p.tool]: p.progress }));
        } else {
          // done / error:把这一项的进度清掉,并整表重查 —— 主进程那边才是真相
          setProgress((prev) => ({ ...prev, [p.tool]: undefined }));
          void reload();
        }
      });
    } catch {
      /* 没有推送通道的宿主 —— 面板本来也不该在这儿出现 */
    }
    return () => unsubscribe();
  }, [reload]);

  return (
    <SettingsSection
      title={t("settings.toolchain.section")}
      icon={IconPackage}
      desc={t("settings.toolchain.desc")}
    >
      {fatal ? (
        <div className="px-4 py-6 text-center text-[0.85em] text-content-subtle">{fatal}</div>
      ) : loading && tools.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-[0.85em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("settings.toolchain.checking")}
        </div>
      ) : (
        <>
          {tools.map((tool) => (
            <ToolRow key={tool.id} state={tool} progress={progress[tool.id]} onReload={reload} />
          ))}
          <div className="flex items-center justify-end px-3 py-2">
            <Button variant="ghost" size="sm" onClick={() => void reload()} className="gap-1">
              <IconRefresh size={12} />
              {t("settings.toolchain.recheck")}
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/* ───────────────────────── 单行 ───────────────────────── */

function ToolRow({
  state,
  progress,
  onReload,
}: {
  state: ToolchainToolState;
  /** 0..1,或 -1 = 进度未知。undefined = 没在装。 */
  progress: number | undefined;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const meta = TOOL_META[state.id];
  const metaLabel = "labelKey" in meta ? t(meta.labelKey) : meta.label;
  const installing = busy || state.installing;
  const missing = state.components.filter((c) => !c.found).map((c) => c.name);

  const doInstall = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.toolchain.install({ tool: state.id });
      if (!res.ok) setActionError(res.error ?? t("settings.toolchain.installFailed"));
      await onReload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async () => {
    if (!confirm(t("settings.toolchain.removeConfirm", { name: metaLabel }))) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.toolchain.remove({ tool: state.id });
      if (!res.ok) setActionError(res.error ?? t("settings.toolchain.removeFailed"));
      await onReload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          {installing ? (
            <IconLoader2 size={15} className="animate-spin text-accent" />
          ) : state.ok ? (
            <IconCheck size={15} className="text-success" />
          ) : (
            <IconAlertTriangle size={15} className="text-warning" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[0.8571em] font-medium text-content">{metaLabel}</span>
            <span
              className={cn(
                "shrink-0 rounded px-1 text-[9px] leading-tight",
                state.ok ? "bg-success/12 text-success" : "bg-warning/12 text-warning",
              )}
            >
              {state.ok ? t("settings.toolchain.ready") : t("settings.toolchain.missing")}
            </span>
          </div>

          {/* 细节行:一句用途 + 事实(版本 / 缺什么 / 路径)。缺什么用机器名拼,
              措辞在这里决定 —— 主进程只回数据。

              缺项**不论整项是否就绪都要显示**:LaTeX 那一项的判据是"至少有一个
              引擎",所以它可能是 ok 但缺 biber —— 那种情况不列出来的话,用户要到
              编译参考文献时才撞上。 */}
          <div className="mt-0.5 text-[0.7857em] leading-relaxed text-content-subtle">
            {t(TOOL_TEXT[state.id].what)}
            {missing.length > 0 && (
              <>
                {" · "}
                <span className="text-warning/90">
                  {t("settings.toolchain.missingParts", { names: missing.join(", ") })}
                </span>
              </>
            )}
            {state.ok && state.version && <> · v{state.version}</>}
          </div>

          {state.path && (
            <div className="mt-0.5 truncate font-mono text-[0.7143em] text-content-subtle" title={state.path}>
              {state.path}
            </div>
          )}

          {/* 装不了的东西说清楚为什么 + 怎么自己装 —— 比一个禁用的按钮有用 */}
          {!state.installable && !state.ok && (
            <div className="mt-1 text-[0.7857em] leading-relaxed text-content-subtle">
              {t(TOOL_TEXT[state.id].howto)}
            </div>
          )}

          {(actionError || state.lastError) && (
            <div className="mt-1 text-[0.7857em] leading-relaxed text-danger">
              {actionError || state.lastError}
            </div>
          )}

          {/* ONLYOFFICE 不是一个 PATH 上的可执行文件而是一套服务,所以它比别的项
              多一块**连接配置**:地址 / 密钥 / 回连主机名。默认由它自己探本机安装
              填好,展开只为 Docker、局域网、非 Windows 这三种装法留一条手动入口。 */}
          {state.id === "onlyoffice" && <OnlyOfficeConfigCard onReload={onReload} />}

          {installing && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-hover">
              <div
                className={cn(
                  "h-full rounded-full bg-accent transition-[width] duration-200",
                  progress === -1 || progress === undefined ? "w-1/3 animate-pulse" : "",
                )}
                style={
                  progress !== undefined && progress >= 0
                    ? { width: `${Math.round(progress * 100)}%` }
                    : undefined
                }
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {state.installable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={installing}
              onClick={() => void doInstall()}
              className="gap-1"
            >
              <IconDownload size={12} />
              {state.id === "onlyoffice" &&
              state.source === "system" &&
              state.components.some((component) => component.name === "Mcode server URL" && !component.found)
                ? t("settings.toolchain.useInstalled")
                : state.ok
                  ? t("settings.toolchain.reinstall")
                  : t("settings.toolchain.install")}
            </Button>
          )}
          {state.source === "managed" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={installing}
              onClick={() => void doRemove()}
              title={t("settings.toolchain.removeTitle")}
            >
              <IconTrash size={12} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
