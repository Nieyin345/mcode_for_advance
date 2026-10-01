/**
 * 只读终端视图 —— 「正在跑的」列表里点开一条终端时用。
 *
 * 以前这里是把 PTY 原始输出直接塞进一个 `<pre>`:PowerShell / ConPTY 的输出里满是
 * 控制序列(颜色 `ESC[32m`、光标移动、清屏 `ESC[2J`、窗口标题 `ESC]0;…BEL`),
 * 在 `<pre>` 里全成了「乱码」,回车覆盖(进度条)也变成一行行重复。现在交给 xterm
 * 来解析 —— 和终端面板同一套渲染、同一份配色,只是不接键盘输入。
 *
 * 输入是「到目前为止的全部文本」:变长就只写新增的那段;变短(重新取了主进程的
 * 缓冲尾巴)就清空重写。
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { monoFontStack, useUiPrefsStore } from "@renderer/lib/uiPrefs.js";
import { buildTheme, useIsDark } from "./TerminalView.js";

export function ReadonlyTerminal({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef("");
  const dark = useIsDark();
  const fontSize = useSessionStore((s) => s.rightPanelFontSize);
  const fontMono = useUiPrefsStore((s) => s.fontMono);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      fontSize: Math.max(10, useSessionStore.getState().rightPanelFontSize - 2),
      fontFamily: monoFontStack(useUiPrefsStore.getState().fontMono),
      lineHeight: 1.15,
      scrollback: 5000,
      convertEol: false,
      theme: buildTheme(document.documentElement.classList.contains("dark")),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = "";
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* host 还没有尺寸(面板收起)时 fit 会抛,下次尺寸变化再来 */
      }
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 只在挂载时建一次;字号 / 字体 / 配色在下面几个 effect 里单独同步。
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const prev = writtenRef.current;
    if (text.startsWith(prev)) {
      const add = text.slice(prev.length);
      if (add) term.write(add);
    } else {
      term.reset();
      term.write(text);
    }
    writtenRef.current = text;
  }, [text]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = buildTheme(dark);
  }, [dark]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = Math.max(10, fontSize - 2);
    term.options.fontFamily = monoFontStack(fontMono);
    try {
      fitRef.current?.fit();
    } catch {
      /* 同上 */
    }
  }, [fontSize, fontMono]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden bg-surface px-1 py-1" />;
}
