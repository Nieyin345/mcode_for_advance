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
  /** 声明式原始字节上界:只用 `Content-Length` / 磁盘文件大小做前置**快速拒绝**,非流内计量。 */
  maxRawBytes: number;
  /** 解压后**累计**字节上界:流内真实计量,到界即停止读取并断连。 */
  maxDecodedBytes: number;
  /** 交给模型的字符上界(= 工具的 `max_chars`)。 */
  maxOutputChars: number;
  /** 总时限(毫秒)。 */
  maxTimeMs: number;
  /**
   * 可选:表格/OOXML 输入枚举的**单元格总数**上界。与 `maxRawBytes`/`maxOutputChars` 同属
   * 一份预算 —— Excel 的 `max_rows`/`max_cols` 由它派生(行×列 ≤ `maxCells`),不再是各写
   * 各的散装常量。{@link clampCellBudget} 把它落成有效行列数。
   */
  maxCells?: number;
  /**
   * 可选:压缩容器(zip/OOXML)解压后**累计字节**上界 —— 高压缩比膨胀(deflate 炸弹)的兜底
   * 周界。小文件可解压成 GB 级 XML,故必须在交给解析器之前按**实际**解压字节数封顶。
   */
  maxDecompressedBytes?: number;
  /** 可选:子进程(stdout/stderr **各自**)累计输出字节上界;到界即终止子进程。 */
  maxChildOutputBytes?: number;
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

/** 一次本地文档读取枚举的**单元格总数**上界(Excel:行×列 ≤ 此值)。 */
export const MAX_DOCUMENT_CELLS = 100_000;

/**
 * 压缩容器(OLE/OOXML zip)解压后**累计字节**上界。
 *
 * 手写的 `.xlsx`/`.docx` 可以极小(几十 KB)却解压成几百 MB 的 XML(deflate 炸弹):
 * 磁盘大小与 `Content-Length` 式声明完全拦不住它。故在**交给解析器之前**按实际/声明的
 * 解压字节数封顶 —— 与 URL 那条 `maxDecodedBytes` 是同一个"解压后计量"的思想。
 */
export const MAX_DOCUMENT_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

/** 同一时刻在途的文档读取数上限 —— 多个大工作簿并发解析同样会累加峰值内存。 */
export const MAX_CONCURRENT_DOCUMENT_READS = 4;

/**
 * 本地文档读取的默认预算 —— 把 Excel 单元格数、OOXML 解压后字节、子进程输出**收进同一份
 * {@link ReadBudget}**,不再各写各的散装常量(台账 MC-065 的改造目标)。
 */
export const DOCUMENT_READ_BUDGET: ReadBudget = {
  maxRawBytes: MAX_DOCUMENT_DECOMPRESSED_BYTES, // 声明式快速拒绝(磁盘文件/成员声明大小)
  maxDecodedBytes: MAX_DOCUMENT_DECOMPRESSED_BYTES,
  maxOutputChars: 100_000,
  maxTimeMs: 60_000,
  maxCells: MAX_DOCUMENT_CELLS,
  maxDecompressedBytes: MAX_DOCUMENT_DECOMPRESSED_BYTES,
  maxChildOutputBytes: MAX_CHILD_OUTPUT_BYTES,
};

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

/** `agent_read_document` 共用的那条在途计数闸门(多个大工作簿并发解析会累加峰值内存)。 */
export const documentReadGate = new ResponseReadGate(MAX_CONCURRENT_DOCUMENT_READS);

/** 一次表格枚举被夹紧后的有效边界 + 是否发生了夹紧(用于显式回执,不静默假装读全)。 */
export interface ClampedCellBudget {
  maxRows: number;
  maxCols: number;
  /** 请求的行/列超出 `maxCells`(或调用方上限)从而被下调 —— 结果只是部分区域。 */
  cellBudgetTruncated: boolean;
}

/**
 * 把「请求的行 × 列」夹进 `maxCells`(单元格总数)预算,返回**有效**行列数。
 *
 * Excel 的 `max_rows`/`max_cols` 从前是各自独立的常量,合起来没有总数约束:1000 行 × 200 列
 * = 20 万格,叠加公式文本可以任意膨胀。这里让"行×列 ≤ `maxCells`"成为与 `maxRawBytes`/
 * `maxOutputChars` **同一条** {@link ReadBudget} 上的约束,并显式回报是否夹紧。
 *
 * 采用「先满足列、再按剩余预算折列」的确定性策略:列是较窄的维,折列比悄悄砍行更不容易让
 * 用户误以为拿到了完整表头行。
 */
export function clampCellBudget(reqRows: number, reqCols: number, maxCells: number): ClampedCellBudget {
  // Invalid caller/IPC numbers must not silently become NaN, Infinity or a
  // 1-cell result that already exceeds a zero/negative resource budget.
  if (!Number.isFinite(reqRows) || !Number.isFinite(reqCols) || !Number.isSafeInteger(maxCells)
    || reqRows <= 0 || reqCols <= 0 || maxCells <= 0) {
    throw new RangeError("单元格预算与请求行列必须是有限正数，预算必须为正整数");
  }
  const rows = Math.max(1, Math.floor(reqRows));
  const cols = Math.max(1, Math.floor(reqCols));
  if (rows * cols <= maxCells) return { maxRows: rows, maxCols: cols, cellBudgetTruncated: false };
  // 先保列(较窄的维),按剩余预算折行;再据折后的行数反推列数,保证 行×列 ≤ maxCells。
  // 列本身超出预算的单列极端情形由最后一步继续折列兜住;两者都 ≥1。
  const effRows = Math.min(rows, Math.max(1, Math.floor(maxCells / cols)));
  const effCols = Math.min(cols, Math.max(1, Math.floor(maxCells / effRows)));
  return { maxRows: effRows, maxCols: effCols, cellBudgetTruncated: true };
}

/** 扫描 zip 中央目录得到的解压膨胀结论。 */
export interface ZipInflationCheck {
  /** 各成员**声明**的解压后字节之和(超预算时只累到刚超的那一刻)。 */
  declaredBytes: number;
  /** 是否已超过给的 `budgetBytes`(是 → 调用方应在交给解析器之前拒绝)。 */
  exceededBudget: boolean;
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD64_SIG = 0x06064b50;
const ZIP_EOCD64_LOCATOR_SIG = 0x07064b50;
const ZIP_CDH_SIG = 0x02014b50;
// 中央目录本身超过此大小才放弃扫描(≈100 万成员):这么多个成员已属病态,直接按超预算处理。
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;

/**
 * 【MC-065】读一个 zip/OOXML 容器的**中央目录**,累加各成员**声明**的解压后大小,一旦超过
 * `budgetBytes` 即停 —— 把「压缩膨胀(解压炸弹)」并在**同一份** {@link ReadBudget} 上
 * (`maxDecompressedBytes`),在**交给 openpyxl / ET / pandoc 之前**拒绝。
 *
 * 手写的 `.xlsx`/`.docx` 可以几百 KB 却声明解压成几百 MB(甚至 GB)的 XML:磁盘大小拦不住它。
 * 这是**声明式快速拒绝**(与 URL 那条 `Content-Length` 同一个思想)——中央目录里的声明大小
 * 理论上可伪造,故它是**第一道**、不是唯一一道;真正兜底是子进程输出字节预算
 * ({@link ReadBudget.maxChildOutputBytes},到界即 killTree)。
 *
 * 不是 zip / 无法解析时返回 `{declaredBytes:0, exceededBudget:false}`(交给解析器报它自己的
 * 格式错误,不在这里把"解析不出来"冒充成"超预算")。
 */
export function checkZipInflation(fileBytes: Buffer, budgetBytes: number): ZipInflationCheck {
  const none: ZipInflationCheck = { declaredBytes: 0, exceededBudget: false };
  try {
    // 找 EOCD(在末尾 ≤ 22+0xffff 字节内,从后往前)。
    const tailStart = Math.max(0, fileBytes.length - (22 + 0xffff));
    let eocd = -1;
    for (let i = fileBytes.length - 22; i >= tailStart; i--) {
      if (fileBytes.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return none;
    let totalEntries = fileBytes.readUInt16LE(eocd + 10);
    let cdOffset = fileBytes.readUInt32LE(eocd + 16);
    let cdSize = fileBytes.readUInt32LE(eocd + 12);
    // zip64:标准字段被填成 0xFFFF/0xFFFFFFFF 时,真实值在 EOCD64 里。
    if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const locator = eocd - 20;
      if (locator >= 4 && fileBytes.readUInt32LE(locator) === ZIP_EOCD64_LOCATOR_SIG) {
        const eocd64 = Number(fileBytes.readBigUInt64LE(locator + 8));
        if (eocd64 >= 0 && eocd64 + 56 <= fileBytes.length && fileBytes.readUInt32LE(eocd64) === ZIP_EOCD64_SIG) {
          totalEntries = Number(fileBytes.readBigUInt64LE(eocd64 + 32));
          cdSize = Number(fileBytes.readBigUInt64LE(eocd64 + 40));
          cdOffset = Number(fileBytes.readBigUInt64LE(eocd64 + 48));
        }
      }
    }
    if (cdSize > MAX_CENTRAL_DIR_BYTES || cdOffset + cdSize > fileBytes.length) {
      // 中央目录异常大(病态成员数)→ 保守地按超预算处理,不把它当"没问题"。
      return { declaredBytes: cdSize, exceededBudget: true };
    }
    // 遍历中央目录条目,累加解压后大小;一超预算立即停。
    let p = cdOffset;
    let sum = 0;
    const end = cdOffset + cdSize;
    for (let n = 0; n < totalEntries && p + 46 <= end; n++) {
      if (fileBytes.readUInt32LE(p) !== ZIP_CDH_SIG) break;
      let uncompressed = fileBytes.readUInt32LE(p + 24);
      const fnLen = fileBytes.readUInt16LE(p + 28);
      const extraLen = fileBytes.readUInt16LE(p + 30);
      const commentLen = fileBytes.readUInt16LE(p + 32);
      if (uncompressed === 0xffffffff) {
        // zip64:在 extra 字段里找 header id 0x0001,其首个 8 字节即解压后大小。
        let ep = p + 46 + fnLen;
        const epEnd = ep + extraLen;
        while (ep + 4 <= epEnd) {
          const hid = fileBytes.readUInt16LE(ep);
          const hsz = fileBytes.readUInt16LE(ep + 2);
          if (hid === 0x0001 && ep + 4 + 8 <= epEnd) { uncompressed = Number(fileBytes.readBigUInt64LE(ep + 4)); break; }
          ep += 4 + hsz;
        }
      }
      sum += uncompressed;
      if (sum > budgetBytes) return { declaredBytes: sum, exceededBudget: true };
      p += 46 + fnLen + extraLen + commentLen;
    }
    return { declaredBytes: sum, exceededBudget: false };
  } catch {
    return none;
  }
}

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
      // ReadableStream can deliver a huge single chunk (including an
      // already-decompressed chunk). Decoding it *before* checking the quota
      // defeats the memory bound even though the returned text is sliced.
      // Decode in small pieces, never accepting more bytes than remain.
      for (let offset = 0; offset < value.byteLength;) {
        const remainingBytes = budget.maxDecodedBytes - bytesRead;
        const remainingChars = budget.maxOutputChars - text.length;
        if (remainingBytes <= 0 || remainingChars <= 0) {
          truncated = true;
          break;
        }
        // UTF-8 needs at most 4 bytes/code point. Even when the character
        // quota is tiny, allow enough bytes to finish multibyte characters.
        const size = Math.min(value.byteLength - offset, remainingBytes,
          Math.max(4, remainingChars * 4), 4096);
        const decoded = decoder.decode(value.subarray(offset, offset + size), { stream: true });
        offset += size;
        bytesRead += size;
        if (decoded.length > remainingChars) {
          let accepted = decoded.slice(0, remainingChars);
          // Never return half of a UTF-16 surrogate pair at the boundary.
          if (/[\uD800-\uDBFF]$/.test(accepted)) accepted = accepted.slice(0, -1);
          text += accepted;
          truncated = true;
          break;
        }
        text += decoded;
        if (bytesRead >= budget.maxDecodedBytes || text.length >= budget.maxOutputChars) {
          truncated = true;
          break;
        }
      }
      if (truncated) {
        // Active budget cancellation is not an upstream read failure.
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
