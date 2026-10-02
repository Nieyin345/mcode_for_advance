/**
 * 自定义面板的 `mcode-panel://` 协议(R41,契约见 `@contracts/customUiPanel`)。
 *
 * 渲染端把包好的面板文档 stage 进来,换一个**内容寻址**的地址(同一份文档 → 同一个地址,
 * 重开面板不会越攒越多);iframe 去加载这个地址,这里吐出文档,并附上**面板自己的** CSP。
 *
 * 为什么不直接 `srcdoc`:srcdoc / blob / data 文档继承主窗口的 CSP(`script-src 'self'`),
 * 面板里的内联脚本一行都跑不起来。自定义协议的响应是独立文档,CSP 只看它自己的响应头。
 *
 * 只在内存里:重启后旧地址失效 —— iframe 每次挂载都会重新 stage,不依赖它活过重启。
 */
import { protocol } from "electron";
import { createHash } from "node:crypto";
import { PANEL_SCHEME, panelCsp } from "@contracts/customUiPanel";

interface StagedPanel {
  html: string;
  network: boolean;
  bytes: number;
}

const MAX_ENTRIES = 48;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const staged = new Map<string, StagedPanel>();
let totalBytes = 0;

/** **必须在 app ready 之前**调(Electron 的硬性要求),所以放在 main/index.ts 顶层。 */
export function registerPanelSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    // standard:有正常的 URL 结构(host / path);secure:当安全上下文对待(clipboard 等 API)。
    // 不给 bypassCSP / corsEnabled / supportFetchAPI —— 面板文档只需要被 iframe 加载。
    { scheme: PANEL_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/** 存一份面板文档,返回 iframe 用的地址。同内容同地址(LRU 往后挪一位)。 */
export function stagePanel(html: string, network: boolean): string {
  const key = createHash("sha256").update(network ? "net:1\n" : "net:0\n").update(html).digest("hex").slice(0, 40);
  const prev = staged.get(key);
  if (prev) {
    staged.delete(key);
    staged.set(key, prev);
  } else {
    const bytes = Buffer.byteLength(html, "utf8");
    staged.set(key, { html, network, bytes });
    totalBytes += bytes;
    // 先进先出地挤掉最旧的;刚放进去的那份永远留着(哪怕它一份就超了总额)。
    for (const [k, v] of staged) {
      if (staged.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
      if (k === key) continue;
      staged.delete(k);
      totalBytes -= v.bytes;
    }
  }
  return `${PANEL_SCHEME}://panel/${key}`;
}

/** app ready 之后调:挂上协议处理。 */
export function initPanelProtocol(): void {
  // 用小写局部名转一手:ipc-parity-smoke 把 `.handle(SCREAMING_CASE)` 当 IPC 渠道收,
  // 而这是协议处理,不是 ipcMain.handle。
  const scheme: string = PANEL_SCHEME;
  protocol.handle(scheme, (request) => {
    let key = "";
    try {
      key = new URL(request.url).pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    } catch {
      key = "";
    }
    const entry = staged.get(key);
    if (!entry) {
      return new Response("This panel has expired. Reopen it.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(entry.html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": panelCsp(entry.network),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
