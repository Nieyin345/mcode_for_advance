/**
 * 注入页面**主世界**的抓流脚本（document-start）。
 *
 * 它只干三件"粗活"：判断这条请求是不是目标流 → 把响应的原始文本增量送回来 →
 * 报告开始/结束/出错。**不做任何解析** —— `data:` 提取、JSON 解码、`{p,v}` 路由
 * 全在主进程的纯函数里（`sseFramer.ts` + `parsers/`）。这样切分的好处：
 *
 *  1. 解析逻辑能在无头 smoke 里穷举边界（这里跑不了测试）；
 *  2. 站点改版时改 parser 即可，不用动注入脚本 —— 注入脚本一旦出问题，症状是
 *     "什么都收不到"，是最难查的一类故障；
 *  3. 页面里少做事，被页面自身的错误处理牵连的概率更低。
 *
 * ## 为什么两条路都要堵
 * 页面在不同场景会交替使用 `fetch` 与 `XMLHttpRequest`（同一站点既有流式 fetch
 * 也有 XHR 轮询）。只堵一条必然出现"某些操作抓不到"的偶发问题。
 *
 * ## 防重入（必须）
 * `runImmediately` 与"导航后补注入"都可能让本脚本在同一文档里跑第二次。第二次
 * 会重新包装**已经被包装过**的 `fetch` —— 于是每个 chunk 被上报两次，表现为
 * 界面里每个字都重复。所以开头先看版本标记，重复注入直接返回。
 */
import type { SiteAdapter } from "./adapters/types.js";

/** 脚本版本。改动注入逻辑时递增 —— 它同时是防重入标记（见文档注释）。 */
export const TAP_SCRIPT_VERSION = "1";

/**
 * 页面回传的数据形状。
 *
 * 刻意保持"哑"（只有文本与标签，没有结构化语义）：页面只负责搬运，语义在主进程
 * 的 parser 里赋予。
 */
export type TapPayload =
  /** SSE 原始文本增量（可能含半帧，由主进程分帧）。 */
  | { t: "chunk"; label: string; text: string }
  /** 命中一条目标流请求（新的一轮从这里开始）。 */
  | { t: "open"; label: string; url: string }
  /** 流结束（正常结束或连接断开）。 */
  | { t: "close"; label: string }
  /** 抓流层出错（克隆失败、读流出错、包装 install 失败）。 */
  | { t: "error"; label: string; message: string }
  /** 脚本已就位（诊断用：证明注入抢在了页面脚本前）。 */
  | { t: "ready"; version: string };

const TAP_SOURCE = `(function () {
  var VERSION = %VERSION%;
  // 防重入：见文件头注释（重复包装会让每个 chunk 上报两次）。
  if (window.__mcodeTap && window.__mcodeTap.version === VERSION) return;
  var PATTERNS = %PATTERNS%;

  var hits = 0;
  var chunks = 0;

  function send(payload) {
    try {
      if (window.mcodeBridge && typeof window.mcodeBridge.dsTapEvent === "function") {
        window.mcodeBridge.dsTapEvent(payload);
      }
    } catch (e) {
      /* 桥不可用时静默：上报失败绝不能弄坏页面本身的行为 */
    }
  }

  function isTarget(url) {
    if (!url) return false;
    for (var i = 0; i < PATTERNS.length; i++) {
      if (url.indexOf(PATTERNS[i]) !== -1) return true;
    }
    return false;
  }

  function pump(reader, label) {
    var decoder = new TextDecoder();
    function step() {
      reader.read().then(
        function (result) {
          if (result.done) {
            send({ t: "close", label: label });
            return;
          }
          var text = "";
          try {
            // stream: true 让 TextDecoder 记住跨 chunk 的多字节字符残片 ——
            // 少了它，一个中文字符被切在两个 chunk 里就会变成乱码。
            text = decoder.decode(result.value, { stream: true });
          } catch (e) {
            text = "";
          }
          if (text) {
            chunks++;
            send({ t: "chunk", label: label, text: text });
          }
          step();
        },
        function (err) {
          send({ t: "error", label: label, message: String((err && err.message) || err) });
        }
      );
    }
    step();
  }

  /* ── fetch ── */
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function () {
        var args = arguments;
        var url = "";
        try {
          var first = args[0];
          url = typeof first === "string" ? first : (first && first.url) || "";
        } catch (e) {
          url = "";
        }
        var promise = originalFetch.apply(this, args);
        if (isTarget(url) && promise && typeof promise.then === "function") {
          promise.then(
            function (response) {
              try {
                hits++;
                send({ t: "open", label: "fetch", url: url });
                // clone() 不能省：响应体只能读一次，直接读页面自己就拿不到了。
                var clone = response.clone();
                if (clone.body && clone.body.getReader) {
                  pump(clone.body.getReader(), "fetch");
                } else {
                  send({ t: "error", label: "fetch", message: "response.body 不是流" });
                }
              } catch (e) {
                send({ t: "error", label: "fetch", message: "clone 失败: " + String(e) });
              }
            },
            function () {
              /* 请求本身失败：交给页面自己处理，我们不掺和 */
            }
          );
        }
        return promise;
      };
    }
  } catch (e) {
    send({ t: "error", label: "install", message: "fetch 包装失败: " + String(e) });
  }

  /* ── XMLHttpRequest ── */
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var originalOpen = XHR.prototype.open;
      var originalSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__mcodeTapUrl = typeof url === "string" ? url : String(url || "");
        } catch (e) {
          /* 存不上就抓不到这条，不影响页面本身 */
        }
        return originalOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var xhr = this;
        try {
          var url = xhr.__mcodeTapUrl || "";
          if (isTarget(url)) {
            var seen = 0;
            var opened = false;
            xhr.addEventListener("progress", function () {
              try {
                // responseType 必须是默认的 ""，否则 responseText 取不到；页面若
                // 设成 blob/arraybuffer，这里只会空转 —— 那种情况靠 fetch 那条路。
                var text = xhr.responseText || "";
                if (text.length > seen) {
                  if (!opened) {
                    opened = true;
                    hits++;
                    send({ t: "open", label: "xhr", url: url });
                  }
                  var delta = text.slice(seen);
                  seen = text.length;
                  chunks++;
                  send({ t: "chunk", label: "xhr", text: delta });
                }
              } catch (e) {
                /* 读不到就跳过这一拍 */
              }
            });
            xhr.addEventListener("loadend", function () {
              send({ t: "close", label: "xhr" });
            });
          }
        } catch (e) {
          /* 包装失败不影响页面本身 */
        }
        return originalSend.apply(this, arguments);
      };
    }
  } catch (e) {
    send({ t: "error", label: "install", message: "XHR 包装失败: " + String(e) });
  }

  window.__mcodeTap = {
    version: VERSION,
    stats: function () {
      return { version: VERSION, patterns: PATTERNS, hits: hits, chunks: chunks };
    }
  };

  send({ t: "ready", version: VERSION });
})();`;

/**
 * 生成注入源码。`streamUrlPatterns` 来自站点适配器 —— 每个站点只关心自己那几条
 * 接口路径，注入脚本本身与站点无关。
 */
export function buildTapScript(streamUrlPatterns: string[]): string {
  return TAP_SOURCE.replace("%VERSION%", JSON.stringify(TAP_SCRIPT_VERSION)).replace(
    "%PATTERNS%",
    JSON.stringify(streamUrlPatterns),
  );
}

/** 生成某适配器的注入源码（便捷入口）。 */
export function buildTapScriptFor(adapter: SiteAdapter): string {
  return buildTapScript(adapter.streamUrlPatterns);
}

/**
 * 校验页面回传的数据。
 *
 * preload 那一侧的数据形状不受我们控制（页面里的脚本可能被页面自身影响），
 * 所以进主进程先过一道形状检查 —— 一个 `undefined.text` 直接把 provider 打崩，
 * 比"丢掉一条抓流数据"严重得多。
 */
export function parseTapPayload(raw: unknown): TapPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const t = obj["t"];
  const label = typeof obj["label"] === "string" ? obj["label"] : "";
  switch (t) {
    case "chunk":
      return typeof obj["text"] === "string" ? { t: "chunk", label, text: obj["text"] } : null;
    case "open":
      return { t: "open", label, url: typeof obj["url"] === "string" ? obj["url"] : "" };
    case "close":
      return { t: "close", label };
    case "error":
      return {
        t: "error",
        label,
        message: typeof obj["message"] === "string" ? obj["message"] : "未知抓流错误",
      };
    case "ready":
      return { t: "ready", version: typeof obj["version"] === "string" ? obj["version"] : "" };
    default:
      return null;
  }
}