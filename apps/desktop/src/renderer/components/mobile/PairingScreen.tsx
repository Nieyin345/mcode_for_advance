/**
 * PairingScreen — the pre-auth gate of the web (phone) shell.
 *
 * Two ways in:
 *  1. **扫码配对** — the phone scans the QR shown in the PC's "connect phone"
 *     dialog: `http://<lan-ip>:<port>/?nonce=<nonce>`. The nonce pins the page
 *     to the pairing session the PC just started; the user types the 6-digit
 *     code displayed on the PC.
 *  2. **账号密码** — if the PC has set a login account (connect-phone dialog →
 *     「账号密码登录」), opening the bare address (e.g. a public tunnel domain)
 *     shows a username/password form instead; no QR or PC-side action needed.
 *
 * Either way the server issues the same device token that everything
 * afterwards rides on (Authorization: Bearer). Token → localStorage, so a
 * reload skips this screen entirely.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconKey, IconLoader2, IconAlertCircle, IconDeviceMobile, IconEye, IconEyeOff } from "@renderer/lib/icons.js";
import { fetchAuthMethods, loginWithPassword, pairWithCode } from "@renderer/lib/webApi.js";

/** Same shape as the hook's `t` — the module-level helpers below need it
 *  passed in (they run outside the component). */
type Translator = (key: MessageId, params?: Record<string, string | number>) => string;

/** The pairing nonce embedded in the QR URL (`?nonce=…`). Null when the page
 *  was opened without it (typed URL, stale link, or wrong QR). */
function readNonce(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("nonce");
  } catch {
    return null;
  }
}

/** A friendly default device name from the UA — shown to the PC so the user
 *  can tell paired devices apart. */
function defaultDeviceName(t: Translator): string {
  const ua = navigator.userAgent;
  // "iPhone" / "iPad" are product names — the same string in every locale.
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) return t("mobile.pair.deviceAndroid");
  return t("mobile.pair.deviceBrowser");
}

const INPUT_CLS =
  "w-full rounded-lg border border-input-edge bg-surface px-3 py-2.5 text-base text-content outline-none focus:border-accent";

export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const { t } = useI18n();
  const nonce = useMemo(readNonce, []);
  // null = still asking the server whether password login is on.
  const [passwordOn, setPasswordOn] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"code" | "password">(nonce ? "code" : "password");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Lazy initializer: the default name is computed once, from the locale
  // that was active when the pairing screen mounted.
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName(t));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchAuthMethods().then((m) => {
      if (alive) setPasswordOn(m.password);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Reset the error when the input changes (the "wrong code" state shouldn't
  // stick while the user is typing the next attempt).
  useEffect(() => {
    setError(null);
  }, [code, username, password, mode]);

  const submitCode = async () => {
    if (!nonce || busy) return;
    if (code.trim().length < 4) {
      setError(t("mobile.pair.codeRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairWithCode({
        nonce,
        code: code.trim(),
        deviceName: deviceName.trim() || defaultDeviceName(t),
      });
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (busy) return;
    if (!username.trim() || !password) {
      setError(t("mobile.pair.loginRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await loginWithPassword({
        username: username.trim(),
        password,
        deviceName: deviceName.trim() || defaultDeviceName(t),
      });
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showCodeForm = mode === "code" && !!nonce;
  const showPasswordForm = mode === "password" && passwordOn === true;
  const canSwitch = !!nonce && passwordOn === true;

  let hint: string;
  if (showCodeForm) hint = t("mobile.pair.hint");
  else if (showPasswordForm) hint = t("mobile.pair.loginHint");
  else if (passwordOn === null) hint = "";
  else hint = t("mobile.pair.noPairInfo") + " " + t("mobile.pair.noLoginHint");

  const deviceNameField = (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-content-muted">
        {t("mobile.pair.deviceName")}
      </span>
      <input
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
        placeholder={t("mobile.pair.deviceNamePlaceholder")}
        maxLength={64}
        className="w-full rounded-lg border border-input-edge bg-surface px-3 py-2 text-base text-content outline-none focus:border-accent"
      />
    </label>
  );

  const errorLine = error && (
    <div className="flex items-start gap-1.5 text-xs leading-relaxed text-danger">
      <IconAlertCircle size={14} className="mt-0.5 shrink-0" />
      <span>{error}</span>
    </div>
  );

  const submitBtnCls = cn(
    "flex h-10 items-center justify-center gap-1.5 rounded-lg bg-accent text-sm font-medium text-surface",
    "hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50",
  );

  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-surface px-6 py-8 text-content">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted">
            <IconDeviceMobile size={28} className="text-accent" />
          </div>
          <h1 className="text-lg font-semibold">{t("mobile.pair.title")}</h1>
          {hint ? (
            <p className="text-sm leading-relaxed text-content-muted">{hint}</p>
          ) : (
            <IconLoader2 size={18} className="animate-spin text-content-muted" />
          )}
        </div>

        {canSwitch && (
          <div className="flex rounded-lg bg-surface-muted p-1 text-sm">
            {(["code", "password"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "flex-1 rounded-md py-1.5 transition-colors",
                  mode === m ? "bg-surface font-medium text-content shadow-sm" : "text-content-muted",
                )}
              >
                {m === "code" ? t("mobile.pair.useCode") : t("mobile.pair.usePassword")}
              </button>
            ))}
          </div>
        )}

        {showCodeForm && (
          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-muted/50 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-content-muted">
                {t("layout.verifyCode")}
              </span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="••••••"
                className="w-full rounded-lg border border-input-edge bg-surface px-3 py-2.5 text-center font-mono text-xl tracking-[0.4em] text-content outline-none focus:border-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode();
                }}
              />
            </label>
            {deviceNameField}
            {errorLine}
            <button type="button" onClick={() => void submitCode()} disabled={busy} className={submitBtnCls}>
              {busy ? <IconLoader2 size={16} className="animate-spin" /> : <IconKey size={16} />}
              {busy ? t("mobile.pair.pairing") : t("mobile.pair.submit")}
            </button>
          </div>
        )}

        {showPasswordForm && (
          <form
            className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-muted/50 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassword();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-content-muted">{t("mobile.pair.username")}</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={!nonce}
                maxLength={64}
                className={INPUT_CLS}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-content-muted">{t("mobile.pair.password")}</span>
              <div className="relative">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  maxLength={256}
                  className={cn(INPUT_CLS, "pr-10")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-content-muted"
                  aria-label={showPassword ? t("mobile.pair.hidePassword") : t("mobile.pair.showPassword")}
                >
                  {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </div>
            </label>
            {deviceNameField}
            {errorLine}
            <button type="submit" disabled={busy} className={submitBtnCls}>
              {busy ? <IconLoader2 size={16} className="animate-spin" /> : <IconKey size={16} />}
              {busy ? t("mobile.pair.loggingIn") : t("mobile.pair.login")}
            </button>
          </form>
        )}

        {showCodeForm && (
          <p className="text-center text-xs text-content-subtle">
            {t("mobile.pair.expiry", {
              origin: window.location.origin || t("mobile.pair.unknown"),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
