/**
 * 「账号密码登录」卡片(连接手机弹窗,所有标签页共用)。
 *
 * 扫码配对要求人在电脑旁;设好账号密码后,手机直接打开任一地址(局域网 / 远程 /
 * 自有域名)就能登录,不用二维码和验证码。登录成功的手机和配对的一样出现在下面的
 * 设备列表里,可以单独撤销。
 *
 * 密码只送进主进程做 scrypt 哈希,界面拿不回来(`mobile.getLogin` 只回账号名)。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconEye, IconEyeOff, IconLock } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MobileLoginStatus } from "@contracts/mobile";

const MIN_PASSWORD = 8;

export function MobileLoginCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MobileLoginStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.mobile.getLogin());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = () => {
    setUsername(status?.username ?? "");
    setPassword("");
    setConfirm("");
    setError(null);
    setNotice(null);
    setEditing(true);
  };

  const save = async () => {
    const name = username.trim();
    if (!name || /\s/.test(name)) {
      setError(t("layout.loginUsernameInvalid"));
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(t("layout.loginTooShort", { n: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t("layout.loginMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.mobile.setLogin({ username: name, password }));
      setEditing(false);
      setPassword("");
      setConfirm("");
      setNotice(t("layout.loginSaved"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.mobile.clearLogin());
      setEditing(false);
      setNotice(t("layout.loginDisabled"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled === true;

  return (
    <div className="mt-5 rounded border border-edge bg-surface-muted/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <IconLock size={14} className={cn("shrink-0", enabled ? "text-success" : "text-content-muted")} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-content">{t("layout.loginTitle")}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {status === null
              ? "…"
              : enabled
                ? t("layout.loginOn", { username: status.username })
                : t("layout.loginOff")}
          </div>
        </div>
        {!editing && status !== null && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant={enabled ? "secondary" : "primary"} onClick={startEdit} disabled={busy}>
              {enabled ? t("layout.loginChange") : t("layout.loginEnable")}
            </Button>
            {enabled && (
              <Button size="sm" variant="danger" onClick={() => void disable()} disabled={busy}>
                {t("layout.loginDisable")}
              </Button>
            )}
          </div>
        )}
      </div>

      {!editing && !enabled && status !== null && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-content-subtle">{t("layout.loginDesc")}</div>
      )}

      {editing && (
        <form
          className="mt-2.5 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-content-muted">{t("layout.loginUsername")}</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-content-muted">
              {t("layout.loginPassword", { n: MIN_PASSWORD })}
            </span>
            <div className="relative">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={show ? "text" : "password"}
                autoComplete="new-password"
                maxLength={256}
                className="pr-8"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-content-subtle hover:text-content"
                title={show ? t("layout.loginHide") : t("layout.loginShow")}
              >
                {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-content-muted">{t("layout.loginConfirm")}</span>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              maxLength={256}
            />
          </label>
          {error && <div className="text-[11px] text-danger">{error}</div>}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="md" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {t("layout.loginCancel")}
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={busy}>
              {t("layout.loginSave")}
            </Button>
          </div>
        </form>
      )}

      {!editing && error && <div className="mt-1.5 text-[11px] text-danger">{error}</div>}
      {!editing && notice && <div className="mt-1.5 text-[11px] text-success">{notice}</div>}
    </div>
  );
}
