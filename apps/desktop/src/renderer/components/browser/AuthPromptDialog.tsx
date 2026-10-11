import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/button.js";
import { Input } from "@renderer/components/ui/input.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { ErrorNote } from "@renderer/components/ui/error-note.js";
import { Spinner } from "@renderer/components/ui/spinner.js";
import { IconLock } from "@renderer/lib/icons.js";
import type { BrowserAuthRequest } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * HTTP Basic Auth prompt for the embedded browser. Shown when a page asks for
 * credentials (main pushes a browser:event "authRequest" and parks the
 * Electron login callback). On submit the answer goes back via
 * browser.authRespond and is used for that request only (nothing is
 * persisted).
 *
 * 【UI-015】应答不再"发出即关闭" —— 主进程可能因为 challenge 超时/已被消费
 * 而没有可投递的 callback。现在消费 `browser.authRespond` 的回执:
 *   - accepted / cancelled → 关闭;
 *   - expired / failed → **保持弹窗**、显示原因、允许重试(而不是骗用户"已提交")。
 * 提交途中禁用按钮并显示进行中,避免重复提交。
 */
export function AuthPromptDialog({
  request,
  onClose,
}: {
  request: BrowserAuthRequest | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<"expired" | "failed" | null>(null);

  useEffect(() => {
    if (request) {
      setUsername("");
      setPassword("");
      setSubmitting(false);
      setSubmitError(null);
    }
  }, [request]);

  if (!request) return null;

  /** Submit credentials and act on the receipt. Only a delivered answer
   *  (accepted/cancelled) closes the dialog; expired/failed keep it open with
   *  an explanation so the user isn't told "done" when nothing landed. */
  const submit = async (u: string, p: string) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.browser.authRespond({
        requestId: request.requestId,
        username: u,
        password: p,
      });
      if (res.status === "accepted" || res.status === "cancelled") {
        onClose();
        return;
      }
      setSubmitError(res.status === "expired" ? "expired" : "failed");
    } catch {
      setSubmitError("failed");
    }
    setSubmitting(false);
  };

  /** Cancel/dismiss path (cancel button, ESC, backdrop). Nothing is being
   *  delivered either way, so it always dismisses — no error to show. */
  const cancel = () => {
    if (submitting) return;
    void api.browser.authRespond({
      requestId: request.requestId,
      username: "",
      password: "",
    }).catch(() => {});
    onClose();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) cancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconLock size={16} className="text-accent" />
            <Dialog.Title className="text-sm font-semibold text-content">
              {t("browser.authTitle", { host: request.host })}
            </Dialog.Title>
          </div>
          <Dialog.Description className="mb-3 text-xs text-content-muted">
            {t("browser.authDesc", { origin: request.origin })}
          </Dialog.Description>
          <div className="space-y-2">
            <Input
              autoFocus
              disabled={submitting}
              placeholder={t("browser.username")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
            />
            <Input
              type="password"
              disabled={submitting}
              placeholder={t("browser.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              onKeyDown={(e) => {
                // 中文输入法里敲拼音、按回车**确认候选词**时 keydown 带 isComposing ——
                // 那不是"提交登录",是输入法自己的按键。少了守卫,用户名带中文(或
                // 密码框里用拼音输入法)的用户一确认候选词就把登录表单发了出去。
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && username) void submit(username, password);
              }}
            />
          </div>
          {submitError && (
            <div className="mt-3">
              <ErrorNote>
                {submitError === "expired" ? t("browser.authExpired") : t("browser.authFailed")}
              </ErrorNote>
            </div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={submitting} onClick={cancel}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!username || submitting}
              onClick={() => void submit(username, password)}
            >
              {submitting && <Spinner size="xs" className="mr-1.5" />}
              {t("browser.signIn")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
