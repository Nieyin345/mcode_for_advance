/**
 * 语音输入(ASR)RPC + 模型目录 / 下载进度。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { VoiceEngineSchema } from "./settings.js";

/* ── Voice input ── */

/**
 * Kick off an ASR session: ensure the model/engine is ready (downloading on
 * first use, lazily), create an online decoder for `lang`, and prepare to
 * receive PCM audio. `sessionId` lets the renderer run one live transcription
 * at a time per composer (a per-composer token); it is NOT the chat-session id.
 */
export const VoiceStartSchema = z.object({
  /** Opaque per-listen token chosen by the renderer (e.g. a random hex id). */
  sessionId: z.string().min(1),
  /** Speech language tag, e.g. "zh-CN" | "en-US". Picks the decoder language. */
  lang: z.string().min(1),
  /** Desired engine: "zipformer" (streaming, interim results) | "parakeet"
   *  (offline, higher accuracy). Falls back to zipformer when unavailable. */
  engine: VoiceEngineSchema,
});
export type VoiceStartInput = z.infer<typeof VoiceStartSchema>;

/** Feed a chunk of 16 kHz mono PCM samples to the active session's decoder.
 *  The Float32Array form is the preferred wire encoding (structured clone
 *  carries it at 4 bytes/sample and validation is a single instanceof check);
 *  the plain number[] form is still accepted for compatibility. */
export const VoiceFeedSchema = z.object({
  sessionId: z.string().min(1),
  pcm: z.union([z.instanceof(Float32Array), z.array(z.number()).max(65536 * 4)]),
});
export type VoiceFeedInput = z.infer<typeof VoiceFeedSchema>;

/** Stop the session and return the final (highest-confidence) transcript. */
export const VoiceStopSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceStopInput = z.infer<typeof VoiceStopSchema>;

/** Cancel/discard a session (no final result emitted; drops partials). */
export const VoiceCancelSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceCancelInput = z.infer<typeof VoiceCancelSchema>;

/** Result of voice.stop — the final recognized text ("" if nothing spoken). */
export const VoiceStopResultSchema = z.object({ text: z.string() });
export type VoiceStopResult = z.infer<typeof VoiceStopResultSchema>;

/** Main → renderer push: live recognition result for a voice session.
 *  `partial` = interim (streaming, possibly revised); `final` = committed
 *  segment for the current session. */
export const VoiceResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["partial", "final"]),
  text: z.string(),
});
export type VoiceResultPayload = z.infer<typeof VoiceResultPayloadSchema>;

/* ── Voice model catalog + download ── */

/** One downloadable ASR model. `files` carry the exact filenames the engine
 *  requires (mirroring {@link STREAMING_ZIPFORMER_FILES} in the sherpa-onnx
 *  model zoo) plus per-file download URLs. `dir` is the local subdir name. */
export interface VoiceModelInfo {
  id: string;
  name: string;
  /** Human label for the primary language, e.g. "中文 (zh-CN)". */
  langLabel: string;
  /** Approximate expanded size, shown in the settings list. */
  sizeLabel: string;
  /** Subdirectory under the voice model dir that this model's files live in. */
  dir: string;
  files: { rel: string; url: string }[];
}

/**
 * The set of models the app can download. All are free / open (Apache-2.0)
 * and run fully on-device. Streaming Zipformer models give live interim
 * results (the "文字边听边出" UX). Hosted on HuggingFace under `csukuangfj`;
 * per-file URLs may move — keep them in sync with the sherpa-onnx model zoo.
 * @see https://k2-fsa.github.io/sherpa/onnx/
 */
export const VOICE_MODEL_CATALOG: VoiceModelInfo[] = [
  {
    id: "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
    name: "Streaming Zipformer 中文",
    langLabel: "中文 (zh-CN)",
    sizeLabel: "~67 MB",
    dir: "streaming-zipformer-zh",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
  {
    id: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    name: "Streaming Zipformer 中英",
    langLabel: "中英双语 (zh + en)",
    sizeLabel: "~81 MB",
    dir: "streaming-zipformer-zh-en",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
];

/** Start downloading a catalog model (`modelId`). Main streams files into the
 *  model dir and reports progress on `voice:downloadProgress`. */
export const VoiceDownloadModelSchema = z.object({
  modelId: z.string().min(1),
});
export type VoiceDownloadModelInput = z.infer<typeof VoiceDownloadModelSchema>;

/** List the catalog + which models are downloaded + the active selection. */
export const VoiceModelListSchema = z.object({});
export type VoiceModelListInput = z.infer<typeof VoiceModelListSchema>;
export const VoiceModelListResultSchema = z.object({
  models: z.array(z.custom<VoiceModelInfo>()),
  downloaded: z.array(z.string()),
  selected: z.string().nullable(),
  /** Active model root (after the user's customization, if any). */
  modelDir: z.string(),
  /** True when the user has set a custom model root. */
  isCustom: z.boolean(),
});
export type VoiceModelListResult = z.infer<typeof VoiceModelListResultSchema>;

/** Main → renderer push: download progress for a model. `percent` is 0–100
 *  across the whole model (byte-weighted when per-file sizes are known,
 *  file-count-weighted otherwise). */
export const VoiceDownloadProgressPayloadSchema = z.object({
  modelId: z.string().min(1),
  stage: z.enum(["downloading", "done", "error", "cancelled"]),
  /** Whole-model progress 0–100 (includes file index weighting). */
  percent: z.number().min(0).max(100),
  /** 0-based index of the file currently downloading. */
  fileIndex: z.number().min(0),
  fileCount: z.number().min(1),
  /** Bytes so far for the current file (for small-file UIs). */
  fileBytes: z.number().min(0),
  /** Total bytes of the current file when known (Content-Length); lets the
   *  UI render "12.3 / 50.6 MB" instead of a bare percentage. */
  fileTotalBytes: z.number().min(0).optional(),
  error: z.string().optional(),
});
export type VoiceDownloadProgressPayload = z.infer<
  typeof VoiceDownloadProgressPayloadSchema
>;

