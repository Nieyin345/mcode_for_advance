/**
 * T22: one-shot, human-approved Mcode download for Docs images.
 * Vendor never fetches remote URLs. DNS resolution is pinned to a vetted
 * public IPv4 address for the TCP connection (no DNS rebinding / redirects).
 * Private, local and nonstandard-port targets fail closed.
 */
import { dialog, BrowserWindow } from "electron";
import { lookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";

const LIMIT = 5 * 1024 * 1024;
function publicV4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 && a !== 169 &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19));
}
export async function fetchApprovedDocsImage(raw: string): Promise<{ base64: string; mime: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw Error("图片 URL 不合法"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))) {
    throw Error("只允许标准端口的 http(s) 图片 URL");
  }
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) throw Error("没有可用于真人批准的 Mcode 窗口");
  const approval = await dialog.showMessageBox(win, {
    type: "warning", message: "允许 Mcode 下载这张网络图片？",
    detail: "仅下载本次图片（最多 5 MiB）：\n" + url.origin + url.pathname.slice(0, 300),
    buttons: ["拒绝", "仅批准本次"], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (approval.response !== 1) throw Error("网络图片默认禁止：未获用户本次批准");
  // DNS results are checked before socket connect and the same address is
  // supplied to the request's lookup callback (not resolved a second time).
  const addresses = isIP(url.hostname) === 4
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { family: 4, all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicV4(address))) {
    throw Error("网络图片目标不是公共 IPv4 地址，已拒绝");
  }
  const ip = addresses[0].address;
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, {
      lookup: (_host, _options, callback) => callback(null, ip, 4),
      timeout: 15000, agent: false,
      headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(Error("图片下载失败（HTTP " + res.statusCode + "；不自动跟随重定向）"));
        return;
      }
      const kind = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(kind) ||
          Number(res.headers["content-length"] ?? 0) > LIMIT) {
        res.destroy();
        reject(Error("网络响应不是受支持且不超过 5 MiB 的图片"));
        return;
      }
      const chunks: Buffer[] = [];
      let count = 0;
      res.on("data", (part: Buffer) => {
        count += part.length;
        if (count > LIMIT) {
          res.destroy(Error("图片超过 5 MiB"));
          return;
        }
        chunks.push(part);
      });
      res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const gif = bytes.subarray(0, 4).toString("ascii") === "GIF8";
        const webp = bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP";
        if (!bytes.length || !({ "image/png": png, "image/jpeg": jpeg, "image/gif": gif, "image/webp": webp } as Record<string, boolean>)[kind]) {
          reject(Error("图片字节与 MIME 类型不匹配"));
        } else resolve({ base64: bytes.toString("base64"), mime: kind });
      });
    });
    req.on("timeout", () => req.destroy(Error("图片下载超时")));
    req.on("error", reject);
  });
}
