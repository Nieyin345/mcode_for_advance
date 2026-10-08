/**
 * IPC handler 的 `catch` 出口 —— **一份,给所有 handler 共用**。
 *
 * ## `errText`:zod 走人话,别的照原样
 *
 * handler 抛出的错误分两类:
 *
 * - **zod 校验失败**(入参不合法)→ 用 {@link describeInputError} 翻译成一句人能读的话,
 *   而不是把 zod 的 `[{code, path, message}]` 原样丢给渲染端;
 * - **别的**(业务错误)→ 照原样取 `message`。那些 message 本来就是人手写的,比如
 *   「更新一个不存在的配置」「新建时必须给密钥」。
 *
 * ## 为什么单开一个文件
 *
 * 这段从前在 **6 个 handler 文件里逐字各写一份**(`ipc/{browser,customModel,institutionAuth,
 * runtimes,terminal,toolchain}.ts`),而其中 `customModel.ts` 那份的括号悄悄改成了**全角**
 * `(…)`,其余五份是半角 —— 同一个「入参不合法」消息在有的面板上标点半角、有的全角,
 * 没有任何东西会报出来。收在一处,以后改文案只有一处。
 */
import { z } from "zod";

/** zod 校验失败 → 一句人能读的「入参不合法(字段: 原因)」。 */
export function describeInputError(err: z.ZodError): string {
  const first = err.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `入参不合法(${where}${first?.message ?? "没通过校验"})`;
}

/** `catch` 里唯一的出口。 */
export function errText(err: unknown): string {
  if (err instanceof z.ZodError) return describeInputError(err);
  return err instanceof Error ? err.message : String(err);
}
