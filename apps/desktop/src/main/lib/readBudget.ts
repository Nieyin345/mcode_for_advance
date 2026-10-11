/**
 * 「读取网络响应 / 子进程输出」的**唯一一份**输入资源预算协议(台账 MC-065)。
 *
 * ## 它把两件常被混为一谈的事分开
 *
 *  - **显示裁剪**:给模型看多少个字符(`maxOutputChars`,即工具入参 `max_chars`);
 *  - **输入资源上界**:实际允许从网络/子进程拉进内存多少(bytes、时限、并发)。
 *
 * 从前 `agent_read_url` 先 `await res.text()` 把**整份**响应读进内存、再 `slice` ——
 * 于是 `max_chars` 只约束了"给模型看多少",约束不了下载/解压时的内存峰值与并发。
 * 更糟的是:读流**中途失败**会被折成一个 `truncated:false` 的"完整短文",一次中途断网
 * 被当成 READ 成功返回,模型以为拿到了整篇(见台账 §34.3 复审失败)。
 *
 * ## 结论收口成一个判别联合
 *
 * {@link ReadOutcome} 让四种结局**形状不同、绝不互相伪装**:
 * COMPLETE 是正常 EOF;TRUNCATED_BY_BUDGET 是按预算主动停止(部分正文,预期内);
 * READ_ERROR_AFTER_PARTIAL / READ_ERROR 是真实失败(TIMEOUT 另列)。
 * {@link readResponseWithinBudget} 在**流层**逐块累计,达到任一周界即 `cancel()` 主动
 * 停止并断开连接。{@link ResponseReadGate} 给"按端点"的并发设上界,不让很多**小预算**
 * 并发累加出无界总内存。
 *
 * ## 边界(不假装能做的)
 *
 * `Content-Length` 只作**声明式快速拒绝**({@link ReadBudget.maxRawBytes});它可能缺失、
 * 也可能被伪造,所以**绝不**拿它当真实计量 —— 真实上界来自流内累计的
 * {@link ReadBudget.maxDecodedBytes}。`undici` 会自动解压 gzip/br,故流内看到的字节
 * 是**解压后**的;字符上界(≤300k)通常先于字节上界触发,字节上界是更高的兜底周界。
 * 本协议不承诺阻止任意压缩炸弹,只保证"读进内存的量有界、到界即停"。
 *
 * 叶子模块:不 import 任何 electron / db / 业务模块,无头 smoke 直接打得到、测得准。
 */

/** 一次输入读取的资源预算 —— 字节/字符/时间三重周界。 */
export interface ReadBudget {
  /** 声明式原始字节上界:只用 `Content-Length` 做前置**快速拒绝**,非流内计量。 */
  maxRawBytes: number;
  /** 解压后**累计**字节上界:流内真实计量,到界即停止读取并断连。 */
  maxDecodedBytes: number;
  /** 交给模型的字符上界(= 工具的 `max_chars`)。 */
  maxOutputChars: number;
  /** 总时限(毫秒)。 */
  maxTimeMs: number;
}

/** 一次输入读取的结局 —— 判别联合,失败形态绝不伪装成"完整短文"。 */
export type ReadOutcomeKind =
  | "COMPLETE" // 正常读到 EOF
  | "TRUNCATED_BY_BUDGET" // 触及字节/字符上限,主动停止 —— 部分正文(预期内)
  | "READ_ERROR_AFTER_PARTIAL" // 读到一半真实失败(网络中断等),已有部分内容
  | "READ_ERROR" // 首块之前就失败,没有任何内容
  | "TIMEOUT"; // 总时限到达(可能已有部分内容)

export interface ReadOutcome {
  kind: ReadOutcomeKind;
  text: string;
  /** 从流里消费的(解压后)字节数。 */
  bytesRead: number;
  /** 解码累计的字符数(裁剪到 maxOutputChars 之前)。 */
  charsRead: number;
  /** 失败时的底层原因(仅失败形态有)。 */
  error?: string;
}

/** `agent_read_url` 的默认预算。`maxOutputChars` / `maxTimeMs` 由工具入参覆盖。 */
export const URL_READ_BUDGET: ReadBudget = {
  maxRawBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 16 * 1024 * 1024,
  maxOutputChars: 100_000,
  maxTimeMs: 15_000,
};

/** 手动跟随重定向的次数上限(不交给 undici 的默认 20 次无界跟随)。 */
export const MAX_URL_REDIRECTS = 5;

/** 同一时刻在途的 URL 正文读取数上限 —— 按端点做总内存/并发控制。 */
export const MAX_CONCURRENT_URL_READS = 8;

/**
 * 单条子进程输出(stdout/stderr 各自)累计进内存的字节上界;到界即终止子进程。
 *
 * 取值明显高于任何**合法**文档读取所需:工具的显示预算 `max_chars` 最高 300k 字符,
 * 而捕获的是子进程**原始输出**——即便按 UTF-8 多字节(≤4 字节/字符)放大也远小于此。
 * 它是**失控兜底**(超大文档/ZIP 膨胀/公式文本爆炸),不是正常路径的裁剪点;一旦触发
 * 就**显式报错**而非静默返回一份被砍掉的正文。
 */
export const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

/** 3xx 是否是需要手动跟随的重定向。 */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export type ContentKind = "text" | "binary";

// 只对**明确二进制**的家庭硬拒绝(把调用者引向 agent_read_document / agent_read_image)。
// 刻意**不**含 application/octet-stream —— 现实中太多服务器拿它冒充文本,硬拒会误伤。
const BINARY_TYPE_PREFIXES = [/^image\//, /^audio\//, /^video\//, /^font\//];
const BINARY_TYPES_EXACT = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/wasm",
]);

/** 按 `Content-Type` 粗分文本 / 二进制。缺头或未知一律当文本。 */
export function classifyContentType(contentType: string): ContentKind {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (!ct) return "text";
  if (BINARY_TYPE_PREFIXES.some((re) => re.test(ct))) return "binary";
  if (BINARY_TYPES_EXACT.has(ct)) return "binary";
  return "text";
}

/**
 * 按端点的并发闸门 —— 到上限时**立即拒绝**(而不是排队攒内存)。
 * 用真实单例 `urlReadGate` 让调用方共用同一条"在途计数"。
 */
export class ResponseReadGate {
  private inFlight = 0;
  constructor(private readonly limit: number = MAX_CONCURRENT_URL_READS) {}
  tryAcquire(): boolean {
    if (this.inFlight >= this.limit) return false;
    this.inFlight++;
    return true;
  }
  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }
  get active(): number {
    return this.inFlight;
  }
}

/** `agent_read_url` 共用的那条在途计数闸门。 */
export const urlReadGate = new ResponseReadGate(MAX_CONCURRENT_URL_READS);

/**
 * 在**流层**有界地读取一个响应体,返回判别式的 {@link ReadOutcome}。
 *
 * 达到 `maxDecodedBytes` 或 `maxOutputChars` 即 `cancel()` 主动停止读取(不再无界缓冲)。
 * 读流中途失败**不**退化成"完整短文":已有内容 → `READ_ERROR_AFTER_PARTIAL`,空 →
 * `READ_ERROR`;`AbortError` → `TIMEOUT`。已经**按预算**停止(`truncated`)之后发生的
 * cancel/abort 报错一律忽略 —— 那是我们自己的停止,不是失败。
 *
 * `res.body` 为 null(如 204)→ 空且 `COMPLETE`。
 */
export async function readResponseWithinBudget(res: Response, budget: ReadBudget): Promise<ReadOutcome> {
  const body = res.body;
  if (!body) return { kind: "COMPLETE", text: "", bytesRead: 0, charsRead: 0 };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let truncated = false;
  let errored = false;
  let timedOut = false;
  let error: string | undefined;

  try {
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      try {
        step = await reader.read();
      } catch (err) {
        if (truncated) break; // 我们已决定停止;后续 cancel/abort 报错不算失败
        errored = true;
        error = err instanceof Error ? err.message : String(err);
        if ((err as { name?: string } | null)?.name === "AbortError") timedOut = true;
        break;
      }
      if (step.done) break;
      const value = step.value!;
      bytesRead += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytesRead > budget.maxDecodedBytes || text.length >= budget.maxOutputChars) {
        truncated = true;
        // 主动断连;cancel 自己报错无所谓(外层 catch 与 truncated 短路都会兜住)——这里
        // 只表达"不再需要这条连接",不把它的失败当成读取失败。
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!truncated && !errored) text += decoder.decode(); // flush 尾部残字节
  } catch (err) {
    errored = true;
    error = err instanceof Error ? err.message : String(err);
  }

  const charsRead = text.length;
  const bounded = text.slice(0, Math.max(0, budget.maxOutputChars));
  if (truncated) return { kind: "TRUNCATED_BY_BUDGET", text: bounded, bytesRead, charsRead };
  if (timedOut) return { kind: "TIMEOUT", text: bounded, bytesRead, charsRead, error };
  if (errored) {
    return {
      kind: charsRead > 0 ? "READ_ERROR_AFTER_PARTIAL" : "READ_ERROR",
      text: bounded,
      bytesRead,
      charsRead,
      error,
    };
  }
  return { kind: "COMPLETE", text: bounded, bytesRead, charsRead };
}
