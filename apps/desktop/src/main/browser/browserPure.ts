/**
 * `BrowserManager` 里**不碰 Electron 的纯函数** —— 抠出来单放,是为了让它们可测。
 *
 * ## 为什么单开一个文件
 *
 * `BrowserManager.ts` 顶层 `import ... from "electron"`,任何 import 它的无头脚本都起不来。
 * 而这里面这几个函数**没有一个**用到 Electron:键名/组合键映射、UA 清洗、下载落点去重、
 * 设备判定 —— 每一个都有能算错的真逻辑(组合键的平台分支、`CmdOrCtrl`、UA 尾串剥离、
 * 并发同名下载去重),却因此**一套测试都没有**(见 C1)。
 *
 * 抽出来之后直接 import 即可断言。判据立在**用户看到的行为**上:模型给的 `Control+Shift+Enter`
 * 到底按出了什么键、Google 登录页看到的 UA 是不是普通 Chrome、两个同名下载会不会互相覆盖。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDevicePreset } from "@contracts/ipc";

export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function chromeLikeUserAgent(ua: string): string {
  const m = ua.match(/^.*?Safari\/[\d.]+/);
  if (m) return m[0];
  return ua.replace(/\s*[\w.-]+\/[\d.]+\s+Electron\/[\d.]+\s*$|\s+Electron\/[\d.]+\s*$/, "").trim();
}

export function normalizeKeyName(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  // ⚠️ 右边的键名必须落在 Electron 认可的 `sendInputEvent` keyCode 表里
  // (https://www.electronjs.org/docs/latest/api/web-contents 的 "Valid keyCodes")。
  // 表里是 **Delete / Insert**,不是 `Del` / `Ins` —— 后者解析成 VKEY_UNKNOWN,键事件被
  // 悄悄丢掉:模型调 `browser_keys({keys:"Delete"})` 清输入框,工具回 `已按下 Delete`,
  // 而字段纹丝不动(把 no-op 报成成功)。`Esc` 是**唯一**有短别名的那个(等同 Escape)。
  const named: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    esc: "Esc",
    escape: "Esc",
    space: "Space",
    spacebar: "Space",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    insert: "Insert",
    ins: "Insert",
  };
  const lower = key.toLowerCase();
  if (named[lower]) return named[lower];
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return key.toUpperCase();
  if (key.length === 1) return key.toLowerCase();
  return null;
}

export function parseKeyCombo(
  combo: string,
): { modifiers: Array<"control" | "shift" | "alt" | "meta">; key: string } | { error: string } {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: "按键为空" };
  const modifiers: Array<"control" | "shift" | "alt" | "meta"> = [];
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "control" || lower === "ctrl" || lower === "cmdorctrl") {
      modifiers.push(process.platform === "darwin" ? "meta" : "control");
    } else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super" || lower === "win") {
      modifiers.push("meta");
    } else if (lower === "alt" || lower === "option") {
      modifiers.push("alt");
    } else if (lower === "shift") {
      modifiers.push("shift");
    } else if (key === null) {
      const norm = normalizeKeyName(part);
      if (!norm) return { error: `无法识别的按键 "${part}"(支持 Enter/Escape/Tab/Arrow*/PageUp/F1-F12/单字符等)` };
      key = norm;
    } else {
      return { error: `一次只能按一个主键:"${combo}"` };
    }
  }
  if (key === null) return { error: `组合键缺少主键:"${combo}"` };
  return { modifiers, key };
}

export function uniqueDownloadPath(
  dir: string,
  filename: string,
  reserved: ReadonlySet<string> = new Set<string>(),
): string {
  const safe = filename.replace(/[\\/:*?"<>|]/g, "_").trim() || "download";
  const taken = (candidate: string): boolean => {
    if (reserved.has(candidate)) return true;
    try {
      statSync(candidate);
      return true;
    } catch {
      return false; // does not exist — free
    }
  };
  const ext = join(dir, safe);
  if (!taken(ext)) return ext;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const tail = dot > 0 ? safe.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem}-${i}${tail}`);
    if (!taken(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${tail}`);
}

export function isMobileUa(device: BrowserDevicePreset, effWidth: number): boolean {
  if (device === "desktop") return false;
  if (device === "custom") return effWidth <= 1024;
  return true;
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
