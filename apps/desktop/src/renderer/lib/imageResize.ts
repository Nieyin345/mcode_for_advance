/**
 * Send-time image preparation for user-attached composer images.
 *
 * Everything the user stages (paste / OS picker) is held as a `data:` URL in
 * the composer. Right before send, `prepareImageForSend` normalizes each one
 * into a `PromptImage` that fits the SendTurn allowlist AND the model APIs'
 * per-image limits:
 *   - decoded bytes ≤ ~4.5MB (under Anthropic's 5MB/image ceiling),
 *   - longest edge ≤ 2048px (Anthropic recommends ~1568; we allow a bit more),
 *   - mime type within the jpeg/png/gif/webp allowlist.
 *
 * Anything over the byte/dimension caps — or outside the allowlist (e.g. a
 * pasted BMP) — is re-encoded through a canvas: scaled to fit 2048px and
 * written as JPEG q0.85. GIFs survive untouched only when small enough;
 * an oversized animated GIF becomes a static first-frame JPEG (documented
 * trade-off — animation is lost, the content isn't). This mirrors how the
 * big agent harnesses behave: the local side shrinks the image before it
 * goes anywhere near the model, the model only ever sees base64.
 */
import type { PromptImage } from "@renderer/stores/sessionStore.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { SEND_TURN_IMAGE_MAX_B64_CHARS } from "@contracts/ipc";

/** 送图前的字符上限 —— **与主进程 `SendTurnImageSchema` 锚同一个常量**。
 *
 *  ⚠️ 从前这里写的是「解码字节 ≤ 4.5MiB」,换算回 base64 字符是 6,291,456,比契约
 *  那边的 6,000,000 **大**:`[6_000_000, 6_291_456]` 这一段的图**渲染端放行、主进程
 *  `SendTurnSchema.parse` 当场拒** —— 用户在点发送那一步才看到"没反应"。按字符数同锚,
 *  就不会再有那道缝。(`approxBytes` 那个换算仍然只用于"要不要压",不再是放行判据。) */
const MAX_SEND_CHARS = SEND_TURN_IMAGE_MAX_B64_CHARS;
/** Longest-edge ceiling — anything larger is downscaled to fit this. */
const MAX_DIMENSION = 2048;
/** JPEG re-encode quality after downscale. */
const JPEG_QUALITY = 0.85;

/** Mime types we can forward verbatim (mirrors SendTurnImageSchema.mimeType). */
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type ImagePrepResult =
  | { ok: true; image: PromptImage }
  | { ok: false; error: string };

/** Load a data URL into an HTMLImageElement (rejects on corrupt bytes). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
}

/**
 * Normalize a staged image for sending. Returns `{ ok: false }` (with a
 * user-facing reason) when the payload can't be decoded or re-encoded —
 * the caller shows a toast and keeps the image staged.
 */
export async function prepareImageForSend(
  dataUrl: string,
  name: string,
): Promise<ImagePrepResult> {
  const locale = useSessionStore.getState().locale;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return { ok: false, error: translate(locale, "lib.image.invalidData", { name }) };
  const mimeType = match[1].toLowerCase();
  const raw = match[2];

  let img: HTMLImageElement;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return { ok: false, error: translate(locale, "lib.image.decodeFailed", { name }) };
  }

  const oversized =
    raw.length > MAX_SEND_CHARS ||
    img.naturalWidth > MAX_DIMENSION ||
    img.naturalHeight > MAX_DIMENSION;
  const allowed = ALLOWED_MIME.has(mimeType);

  // Small, in-allowlist image → forward verbatim (GIF keeps its animation).
  if (!oversized && allowed) {
    return { ok: true, image: { data: raw, mimeType: mimeType as PromptImage["mimeType"] } };
  }

  // Downscale / re-encode through a canvas. Fill white first so transparent
  // PNGs don't come out as black JPEGs.
  const scale = Math.min(
    1,
    MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, error: translate(locale, "lib.image.canvasFailed", { name }) };
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const out = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const outMatch = /^data:image\/jpeg;base64,(.+)$/s.exec(out);
  if (!outMatch) return { ok: false, error: translate(locale, "lib.image.compressFailed", { name }) };
  if (outMatch[1].length > MAX_SEND_CHARS) {
    return { ok: false, error: translate(locale, "lib.image.stillTooLarge", { name }) };
  }
  return { ok: true, image: { data: outMatch[1], mimeType: "image/jpeg" } };
}
