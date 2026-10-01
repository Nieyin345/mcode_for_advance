/**
 * pair.ts — standalone (dependency-free) pairing page entry for the mobile web.
 *
 * The phone lands here by scanning the QR shown on the PC (`http://…/?nonce=…`).
 * Unlike the desktop renderer entry (main.tsx → AppMobile), this page pulls in
 * NO React, NO sessionStore, NO webApi — just a code form and one POST to
 * `/api/pair/verify`. Keeping it dependency-free is the whole point: the phone
 * gets the pairing UI in a few KB, so the first paint after scanning is
 * immediate even over a slow VPS/relay link. The heavy app bundle only loads
 * AFTER pairing succeeds (redirect to the bare origin), when the user already
 * has context and the assets are cached.
 *
 * The localStorage keys MUST stay in sync with lib/webApi.ts (TOKEN_KEY /
 * ENDPOINT_KEY) — after pairing we drop the device token there and redirect to
 * the full app, which reads them via isPaired()/readAuth(). The same build
 * emits both entry and pair bundle, so the drift risk is limited to a
 * deliberate key rename.
 */

const TOKEN_KEY = "mcode-web-token";
const ENDPOINT_KEY = "mcode-web-endpoint";

type Locale = "zh" | "en";

/** Tiny built-in dictionary — this module cannot import lib/i18n (it would
 *  drag in the whole store graph). Mirror the wording of PairingScreen.tsx. */
const I18N = {
  zh: {
    title: "连接 Mcode",
    missingNonce:
      "此链接缺少配对信息。请用手机相机扫描电脑端「连接手机」弹窗中的二维码后重新打开。",
    desc: "在电脑端「连接手机」弹窗中查看 6 位验证码，输入后即可开始使用。",
    codeLabel: "验证码",
    nameLabel: "设备名称（可选）",
    submit: "完成配对",
    busy: "配对中…",
    foot: "配对码有效期 5 分钟 · 服务器：",
    codeShort: "请输入电脑端显示的验证码",
    network: "无法连接服务器，请检查网络后重试",
    done: "配对成功，正在加载…",
    loginDesc: "输入在电脑端「连接手机」里设置的账号和密码。",
    noLogin: "想直接用账号密码登录：在电脑端「连接手机」弹窗里设置账号密码后，刷新本页。",
    userLabel: "账号",
    passLabel: "密码",
    login: "登录",
    loggingIn: "登录中…",
    loginShort: "请输入账号和密码",
    tabCode: "验证码配对",
    tabLogin: "账号密码",
  },
  en: {
    title: "Connect to Mcode",
    missingNonce:
      "This link is missing the pairing info. Scan the QR code in the \"Connect phone\" dialog on your computer and reopen it.",
    desc: "Open the 6-digit code shown in the \"Connect phone\" dialog on your computer, then enter it below.",
    codeLabel: "Verification code",
    nameLabel: "Device name (optional)",
    submit: "Pair device",
    busy: "Pairing…",
    foot: "Code expires in 5 minutes · Server: ",
    codeShort: "Enter the verification code shown on your computer",
    network: "Cannot reach the server. Check your network and try again.",
    done: "Paired successfully, loading…",
    loginDesc: "Enter the account and password set in the \"Connect phone\" dialog on your computer.",
    noLogin: "To sign in with an account instead, set one in the \"Connect phone\" dialog on your computer, then reload this page.",
    userLabel: "Account",
    passLabel: "Password",
    login: "Sign in",
    loggingIn: "Signing in…",
    loginShort: "Enter the account and password",
    tabCode: "Pairing code",
    tabLogin: "Account",
  },
} as const;

function locale(): Locale {
  try {
    return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) return "Android Phone";
  return "Browser";
}

/** Strict getElementById returning the expected element or null. */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const node = el<HTMLElement>(id);
  if (node) node.textContent = text;
}

function showError(message: string, id = "error"): void {
  const node = el<HTMLParagraphElement>(id);
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

/** POST a pairing / login request and store the issued device token. Both
 *  routes answer with the same `{ deviceToken, endpoint }` shape. */
async function submitAuth(
  path: "/api/pair/verify" | "/api/auth/login",
  payload: Record<string, string>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: body?.error ?? `HTTP ${res.status}` };
    }
    const result = (await res.json()) as { deviceToken: string; endpoint: string };
    try {
      localStorage.setItem(TOKEN_KEY, result.deviceToken);
      localStorage.setItem(ENDPOINT_KEY, result.endpoint);
    } catch {
      // private mode etc. — pairing still completed this session; the pairing
      // gate just reappears on reload (same behavior as webApi.ts writeAuth).
    }
    return { ok: true };
  } catch {
    return { ok: false, message: I18N[locale()].network };
  }
}

/** Is password login switched on on the PC? Failure ⇒ treat as off. */
async function passwordLoginEnabled(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/methods");
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { password?: unknown } | null;
    return body?.password === true;
  } catch {
    return false;
  }
}

/** Show a brief success state, then load the full app at the bare origin root
 *  (no `?nonce=` — otherwise the server would serve this pairing page again). */
function finishPairing(): void {
  const t = I18N[locale()];
  const card = el<HTMLElement>("card");
  if (!card) {
    location.replace("/");
    return;
  }
  card.innerHTML = "";
  const done = document.createElement("div");
  done.className = "done";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  const label = document.createElement("p");
  label.textContent = t.done;
  done.appendChild(spinner);
  done.appendChild(label);
  card.appendChild(done);
  window.setTimeout(() => location.replace("/"), 700);
}

function boot(): void {
  const t = I18N[locale()];
  const lang = locale() === "zh" ? "zh-CN" : "en";
  document.documentElement.lang = lang;
  document.title = t.title;

  const nonce = new URLSearchParams(window.location.search).get("nonce");
  setText("title", t.title);
  setText("foot", `${t.foot}${window.location.origin || "unknown"}`);
  const descEl = el<HTMLParagraphElement>("desc");
  if (descEl) descEl.textContent = nonce ? t.desc : "";

  const form = el<HTMLFormElement>("form");
  const codeInput = el<HTMLInputElement>("code");
  const nameInput = el<HTMLInputElement>("name");
  if (form) form.hidden = !nonce;
  const footEl = el<HTMLElement>("foot");
  if (footEl) footEl.hidden = !nonce;

  setText("userLabel", t.userLabel);
  setText("passLabel", t.passLabel);
  setText("loginNameLabel", t.nameLabel);
  setText("loginSubmitText", t.login);
  setText("tabCode", t.tabCode);
  setText("tabLogin", t.tabLogin);
  const loginName = el<HTMLInputElement>("loginName");
  if (loginName && !loginName.value) loginName.value = defaultDeviceName();
  setupPasswordLogin(nonce, t);

  const submitBtn = el<HTMLButtonElement>("submit");
  const submitText = el<HTMLElement>("submitText");
  if (nameInput && !nameInput.value) nameInput.value = defaultDeviceName();
  if (!codeInput) return;

  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!nonce || !submitBtn) return;
    const code = codeInput.value.replace(/\D/g, "").trim();
    if (code.length < 4) {
      showError(t.codeShort);
      return;
    }
    submitBtn.disabled = true;
    if (submitText) submitText.textContent = t.busy;
    void submitAuth("/api/pair/verify", {
      nonce,
      code,
      deviceName: nameInput?.value.trim() || defaultDeviceName(),
    }).then((out) => {
      submitBtn.disabled = false;
      if (submitText) submitText.textContent = t.submit;
      if (!out.ok) {
        showError(out.message);
        return;
      }
      finishPairing();
    });
  });

  codeInput.addEventListener("input", () => {
    const err = el<HTMLParagraphElement>("error");
    if (err) err.hidden = true;
  });
}

/** 账号密码登录:问服务器开没开;开了就显示表单(有 nonce 时和验证码表单二选一)。 */
function setupPasswordLogin(nonce: string | null, t: (typeof I18N)[Locale]): void {
  const loginForm = el<HTMLFormElement>("loginForm");
  const codeForm = el<HTMLFormElement>("form");
  const sw = el<HTMLElement>("switch");
  const tabCode = el<HTMLButtonElement>("tabCode");
  const tabLogin = el<HTMLButtonElement>("tabLogin");
  const descEl = el<HTMLParagraphElement>("desc");
  const footEl = el<HTMLElement>("foot");
  const userInput = el<HTMLInputElement>("username");
  const passInput = el<HTMLInputElement>("password");
  const nameInput = el<HTMLInputElement>("loginName");
  const submitBtn = el<HTMLButtonElement>("loginSubmit");
  const submitText = el<HTMLElement>("loginSubmitText");
  if (!loginForm || !userInput || !passInput || !submitBtn) return;

  const show = (mode: "code" | "login"): void => {
    loginForm.hidden = mode !== "login";
    if (codeForm) codeForm.hidden = mode !== "code" || !nonce;
    if (footEl) footEl.hidden = mode !== "code" || !nonce;
    tabCode?.setAttribute("aria-pressed", String(mode === "code"));
    tabLogin?.setAttribute("aria-pressed", String(mode === "login"));
    if (descEl) descEl.textContent = mode === "login" ? t.loginDesc : t.desc;
    if (mode === "login" && !nonce) userInput.focus();
  };

  void passwordLoginEnabled().then((on) => {
    if (!on) {
      if (!nonce && descEl) descEl.textContent = `${t.missingNonce} ${t.noLogin}`;
      return;
    }
    if (nonce && sw) sw.hidden = false;
    show(nonce ? "code" : "login");
  });

  tabCode?.addEventListener("click", () => show("code"));
  tabLogin?.addEventListener("click", () => show("login"));

  const clearErr = (): void => {
    const err = el<HTMLParagraphElement>("loginError");
    if (err) err.hidden = true;
  };
  userInput.addEventListener("input", clearErr);
  passInput.addEventListener("input", clearErr);

  loginForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const username = userInput.value.trim();
    const password = passInput.value;
    if (!username || !password) {
      showError(t.loginShort, "loginError");
      return;
    }
    submitBtn.disabled = true;
    if (submitText) submitText.textContent = t.loggingIn;
    void submitAuth("/api/auth/login", {
      username,
      password,
      deviceName: nameInput?.value.trim() || defaultDeviceName(),
    }).then((out) => {
      submitBtn.disabled = false;
      if (submitText) submitText.textContent = t.login;
      if (!out.ok) {
        showError(out.message, "loginError");
        return;
      }
      finishPairing();
    });
  });
}

boot();
