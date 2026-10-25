import { useEffect, useRef, useState } from "react";
import type { TheiaPreviewResult } from "@contracts/ipc/modules.js";
import { TheiaInstalledPanel } from "./TheiaInstalledPanel.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

/**
 * 【F006】从 `.vsix` 安装真实 VS Code 扩展。
 *
 * ## 为什么先把限制写在按钮上面
 *
 * 当前宿主只接受**可执行入口 ≤ 24 KiB** 的扩展（`SOURCE_LIMIT`），而真实市场扩展
 * 普遍 100 KB 以上 —— `rainbow-csv` 的 `extension.js` 是 136 KB。也就是说：
 * **用户从市场下载的绝大多数扩展，在这里会被拒绝。**
 *
 * 所以这段说明必须在**选文件之前**就可见。如果等他选完、转一圈、再看到一句
 * 「exceeds the L1 source limit」，那比没有入口更糟 —— 他会以为是 bug 或者自己
 * 选错了文件。**先说清楚，是他自己决定要不要试。**
 *
 * 这条不是临时的免责声明：它是这个宿主**当前的真实能力边界**。等哪天真能装下
 * 136 KB 的扩展了，这段文案要跟着改，而不是悄悄留着。
 */
export function VsixInstallSection({ onInstalled }: { onInstalled: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type Inspected = Extract<TheiaPreviewResult, {kind: "inspection"}>;
  type Started = Extract<TheiaPreviewResult, {kind: "started"}>;
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] = useState<string | null>(null);
  const held = useRef<{ticket?: string; sessionId?: string}>({});
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const {ticket, sessionId} = held.current;
      held.current = {};
      // Closing the panel must not leave an unsandboxed child running.
      if (ticket) void api.modules.theiaPreview({op:"cancel", ticket}).catch(() => {});
      if (sessionId) void api.modules.theiaPreview({op:"stop", sessionId}).catch(() => {});
    };
  }, []);

  /** Explicitly a temporary compatibility preview, not an installed module. */
  const inspectTheia = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await api.pickFiles({
        title: "选择要试运行的 VSIX（Theia 兼容预览）",
        filters: [{name: "VS Code 扩展", extensions: ["vsix"]}],
      });
      if (!picked.paths[0]) return;
      if (inspected) {
        await api.modules.theiaPreview({op: "cancel", ticket: inspected.ticket});
        held.current.ticket = undefined;
        setInspected(null);
      }
      const result = await api.modules.theiaPreview({op: "inspect", path: picked.paths[0]});
      if (result.kind !== "inspection") throw Error("未获得有效的扩展权限报告");
      if (unmounted.current) {
        await api.modules.theiaPreview({op:"cancel", ticket: result.ticket});
        return;
      }
      held.current.ticket = result.ticket;
      setInspected(result);
      setAgreed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const cancelTheia = async () => {
    if (!inspected) return;
    setBusy(true);
    try {
      await api.modules.theiaPreview({op: "cancel", ticket: inspected.ticket});
      held.current.ticket = undefined;
      setInspected(null);
      setAgreed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const startTheia = async () => {
    if (!inspected || !agreed) return;
    setBusy(true);
    try {
      held.current.ticket = undefined; // ticket consumed on invocation, including failure
      const result = await api.modules.theiaPreview({op: "start", ticket: inspected.ticket, accepted: true});
      setInspected(null); // ticket is single-use even if startup fails
      if (result.kind !== "started") throw Error("Theia 没有完成扩展激活");
      if (unmounted.current) {
        await api.modules.theiaPreview({op:"stop", sessionId:result.sessionId});
        return;
      }
      held.current.sessionId = result.sessionId;
      setStarted(result);
      setCommand(result.commands[0] ?? "");
      setCommandResult(null);
    } catch (cause) {
      setInspected(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const executeTheia = async () => {
    if (!started || !command) return;
    setBusy(true);
    setCommandResult(null);
    try {
      const result = await api.modules.theiaPreview({op: "execute", sessionId: started.sessionId, commandId: command});
      if (result.kind !== "executed") throw Error("Theia 命令未返回结果");
      setCommandResult(result.result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const stopTheia = async () => {
    if (!started) return;
    setBusy(true);
    try {
      await api.modules.theiaPreview({op: "stop", sessionId: started.sessionId});
      held.current.sessionId = undefined;
      setStarted(null);
      setCommandResult(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const pickAndInstall = async () => {
    setError(null);
    // 文件选择走既有的 dialog 薄包装（`ipc/dialog.ts` 的 `pickFilesForUser`），
    // 不直接 import electron 的 dialog —— 那会绕过围栏与测试桩。
    const picked = await api.pickFiles({
      title: t("ide.modules.vsixTitle"),
      filters: [{ name: t("ide.modules.vsixFilter"), extensions: ["vsix"] }],
    });
    const path = picked.paths[0];
    if (!path) return; // 用户取消：不是错误，什么都不做

    setBusy(true);
    try {
      const result = await api.modules.installVsix({
        path,
        confirmReadAccess: true,
        // vsix 里的 `extension.js` 是要在本机跑的程序。这里的确认由下面的按钮
        // 承载（用户点「选择 .vsix 文件…」就等于同意安装它的可执行入口），
        // 与 `modules.install` 对 `program` 模块的处理是同一条规矩。
        confirmExecutableCode: true,
        installConsent: "allow-once",
      });
      useToastStore.getState().push({
        kind: "info",
        title: t("ide.modules.vsixInstalled", { id: result.moduleId ?? "" }),
      });
      // 【F012】**装上 ≠ 全都能用。** 真实扩展的 `menus` / `configuration` 等
      // 本宿主接受了但不会实现 —— 用户如果不知道，会以为自己装坏了，
      // 然后去查权限、查版本、重装。
      //
      // 两类**分开说**，因为对用户意味着不同的事：
      //   declarative → 「设置项改了没用」
      //   runtime     → 「菜单项不会出现」
      // 合并成一句会丢掉这个区分，而那个区分正是他判断「还要不要用」的依据。
      const ignored = result.ignoredContributions ?? [];
      const declarative = ignored.filter((c) => c.kind === "declarative").map((c) => c.section);
      const runtime = ignored.filter((c) => c.kind === "runtime").map((c) => c.section);
      if (declarative.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("ide.modules.vsixIgnoredDeclarative", { sections: declarative.join("、") }),
        });
      }
      if (runtime.length > 0) {
        useToastStore.getState().push({
          kind: "warning",
          title: t("ide.modules.vsixIgnoredRuntime", { sections: runtime.join("、") }),
        });
      }
      onInstalled();
    } catch (cause) {
      // 失败原因**原样显示**，尤其是「源码超 24 KiB」那条 —— 它是当前最可能的失败，
      // 而且用户需要知道那不是随机错误。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded border border-edge p-3" data-testid="module-vsix-install">
      <p className="text-body font-semibold">{t("ide.modules.vsixTitle")}</p>
      {/* ⚠️ 这段必须在按钮**之前** —— 见文件头。删掉它，套件的诚实性断言会红。 */}
      <p className="text-code text-content-muted" data-testid="module-vsix-limit-notice">
        {t("ide.modules.vsixLimitNotice")}
      </p>
      <Button disabled={busy} onClick={() => void pickAndInstall()}>
        {busy ? t("ide.modules.vsixInstalling") : t("ide.modules.vsixPick")}
      </Button>
      <TheiaInstalledPanel />
      <section className="space-y-2 rounded border border-edge p-3" data-testid="theia-vsix-preview">
        <p className="text-body font-semibold">Theia 兼容试运行（多文件 VSIX）</p>
        <p className="text-code text-content-muted">
          这是临时兼容实验，<strong>不是正式安装</strong>，不会进入扩展目录。扩展会在不受沙箱保护的 Node 子进程里运行，能访问你的本机文件、网络和程序；关闭试运行后清理临时目录。当前不保证 Webview、语言服务等功能可用。
        </p>
        {!started && <Button disabled={busy} onClick={() => void inspectTheia()}>选择 VSIX 并检查权限</Button>}
        {inspected && !started && (
          <div className="space-y-2 rounded border border-edge p-2" data-testid="theia-vsix-consent">
            <p className="text-body font-semibold">{inspected.extensionId} · {inspected.fileCount} 个文件</p>
            <p className="text-code">{inspected.prompt.headline}</p>
            <ul className="list-disc pl-5 text-code">
              {inspected.prompt.capabilities.map(item => <li key={item.capability}>{item.label}{item.evidence.length > 0 && <span className="block text-content-muted">{item.evidence.slice(0, 4).join("、")}</span>}</li>)}
            </ul>
            <p className="text-code text-warning">{inspected.prompt.disclosure}</p>
            <ul className="list-disc pl-5 text-code text-content-muted">
              {inspected.prompt.limits.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
            <label className="flex items-start gap-2 text-code">
              <input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />
              <span>我已阅读权限报告，理解这是不完整的静态扫描、没有运行时沙箱，并明确同意在本机执行该扩展代码。</span>
            </label>
            <div className="flex gap-2">
              <Button disabled={busy || !agreed} onClick={() => void startTheia()}>确认并启动临时宿主</Button>
              <Button disabled={busy} onClick={() => void cancelTheia()}>拒绝并清理</Button>
            </div>
          </div>
        )}
        {started && (
          <div className="space-y-2" data-testid="theia-vsix-running">
            <p className="text-code">临时运行：{started.extensionId}（注册 {started.commands.length} 条命令）</p>
            {started.activationErrors.map((message, index) => <p key={index} className="text-code text-warning">{message}</p>)}
            <p className="text-code text-content-muted">手动执行命令可能修改文件或启动其他程序；请只执行你信任的命令。</p>
            <select className="w-full rounded border border-edge bg-surface px-2 py-1 text-code" value={command} onChange={event => setCommand(event.target.value)}>
              {started.commands.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            <div className="flex gap-2">
              <Button disabled={busy || !command} onClick={() => void executeTheia()}>执行选中命令</Button>
              <Button disabled={busy} onClick={() => void stopTheia()}>停止并清理</Button>
            </div>
            {commandResult !== null && <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-code">{commandResult}</pre>}
          </div>
        )}
      </section>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}
