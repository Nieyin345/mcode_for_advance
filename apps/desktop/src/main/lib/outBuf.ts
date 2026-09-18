/**
 * 命令输出的**字节缓冲 + 编码判定** —— 钩子与命令节点共用这一份。
 *
 * ## 为什么收口在一处
 *
 * 这两处都会起进程、收输出,而"怎么把一段字节变成文字"是个**有正确答案**的问题:
 *
 *  - 输出**未必是 UTF-8**。Windows 上 `cmd.exe` 自己的提示(「'xxx' 不是内部或外部
 *    命令」、`taskkill` 的结果……)用的是**控制台的代码页**,中文机器上是 GBK。按
 *    UTF-8 硬解,那半行中文就变成一串 U+FFFD,而用户唯一能得到的线索正是那句话。
 *  - 分块到达的流里,**一个多字节字符可能跨在两个 chunk 之间**。按块
 *    `chunk.toString("utf-8")` 就会把它解成两个替换字符 —— 中文输出必踩。
 *
 * 原先只有钩子那一处做对了(`hooks/runCommand.ts` 的本地实现),命令节点那一处是按块
 * 解码的。所以搬到这里,两边共用同一份。
 *
 * ## 两条规矩
 *
 * 1. **收原始字节,到结束时才解码**(`text()`)。分块时任何"先解一段"的做法都会在
 *    半个字符上翻车。
 * 2. **窗口只留尾部**(`limitBytes` 是**字节**上限)。长任务的日志几万行,全留着就是
 *    拿内存换一条没人看的内容,而错误栈与结果都在尾部。
 */

/**
 * 一块**只留尾部**的字节缓冲。
 *
 * 上限是字节数(不是字符数)—— 判据要能在 `push` 里**不看内容**就算出来,而"这段字节
 * 解码后是多少个字符"恰恰要解码才知道。想要"保住 N 个字符"的调用方自己按 UTF-8 的
 * 上界开窗口(见 `commandRunner.ts` 的 `COMMAND_OUTPUT_TAIL_CHARS * 4`)。
 */
export class OutBuf {
  private chunks: Buffer[] = [];
  private size = 0;
  /** 丢过东西。 */
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    // 从**头**丢,直到装得下。`subarray` 不复制 —— 一次大输出不会因为反复拼接而翻倍。
    while (this.size > this.limitBytes && this.chunks.length > 0) {
      const head = this.chunks[0] as Buffer;
      const over = this.size - this.limitBytes;
      this.truncated = true;
      if (head.length <= over) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.size -= over;
      }
    }
  }

  text(): string {
    if (this.size === 0) return "";
    return decodeOutput(Buffer.concat(this.chunks, this.size));
  }
}

/**
 * 去掉开头**落单的续字节**(`0b10xxxxxx`)—— **只在整段确实是 UTF-8 时才该做**。
 *
 * ## 为什么它不能无条件调用(这是踩过的坑)
 *
 * 这个判据假设"每个字节都属于 UTF-8"。可 **GBK 的首字节也可能落在 `0x80-0xBF`**
 * (GBK 双字节的首字节范围是 `0x81-0xFE`,与 UTF-8 续字节的区间重叠)。于是 `0xbb`
 * 这种合法的 GBK 首字节会被当成"落单的续字节"削掉,后面整段跟着错位 ——
 * 「或批处理文件。」被削成「蚺砦募」。
 *
 * 它是为**窗口场景**写的:窗口从中间截出来,开头可能正好落在某个多字节字符的中间。
 * 那种情况下确实该削。但"这段字节是 GBK 还是 UTF-8"要**解过才知道**,而这一刀在解之前
 * 就落下了 —— 所以判据不能只看字节形状。
 *
 * 现在改成:**先按原样试严格 UTF-8**;失败了才说明这段可能不是 UTF-8,那时才允许削
 * (见 {@link decodeOutput} 的调用顺序)。一刀切在 GBK 上的代价比留下半个字符大得多,
 * 因为半个字符只会毁掉一个字符,而错位会毁掉整段。
 */
function trimLeadingOrphans(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start += 1;
  return start === 0 ? buf : buf.subarray(start);
}

/** 砍掉结尾**一个**不完整的 UTF-8 序列(见 {@link decodeUtf8Strict} 的第二步)。 */
function trimTrailingPartialUtf8(buf: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= buf.length; back += 1) {
    const byte = buf[buf.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // 续字节 —— 还在序列中间,继续往回找
    const need = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

/**
 * 严格解 UTF-8 —— **解不出来就返回 `null`,不返回乱码**。
 *
 * 用 `fatal: true`(遇到非法字节直接抛)而不是"数替换字符",是因为后者的判据太软:
 * 一个正好切在半个字符上的窗口只会产生**一个** U+FFFD,却足以让整段输出被判成"不是
 * UTF-8"。让解码器自己回答"这是不是合法的 UTF-8",边界清楚得多。
 *
 * 两步:先原样试;失败则砍掉结尾那**一个**不完整的序列(那只是窗口切在了半个字符上,
 * 不是编码不对)再试。再失败就说明真的不是 UTF-8。
 */
function decodeUtf8Strict(buf: Buffer): string | null {
  const strict = new TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(buf);
  } catch {
    const trimmed = trimTrailingPartialUtf8(buf);
    if (trimmed.length === buf.length) return null;
    try {
      return strict.decode(trimmed);
    } catch {
      return null;
    }
  }
}

/**
 * 把一条流的字节解成文本。
 *
 * ## 顺序是有讲究的(踩过坑)
 *
 * 1. **先原样试严格 UTF-8。** 这是唯一"解得出就一定对"的判据。**不能先削开头那几个
 *    续字节** —— GBK 的首字节会落在 `0x80-0xBF`,先削就等于把一段好端端的 GBK 削错位
 *    (见 {@link trimLeadingOrphans} 的注释)。
 * 2. 失败了,才说明这段①可能不是 UTF-8,或者②开头确实落在半个字符上。削掉开头那几个
 *    落单续字节**再试一次**严格 UTF-8 —— 这一支兜的是窗口从中间截出来的情况。
 * 3. 还不行,就真的不是 UTF-8:在"GBK 的结果"和"有损 UTF-8 的结果"之间挑**替换字符少**
 *    的那个。命令前半段吐 UTF-8、后半段吐 GBK 这种混着来的情况,只能这样挑一个不那么烂的。
 *
 * **不能穷举代码页**:非中文 Windows(Shift_JIS / CP866……)仍然会是乱码,因为 Node 的
 * ICU 认哪些编码要看构建,而每多试一个就多一分把好输出判成坏的风险。中文机器是这一版
 * 的目标。
 */
export function decodeOutput(raw: Buffer): string {
  if (raw.length === 0) return "";

  const utf8 = decodeUtf8Strict(raw);
  if (utf8 !== null) return utf8;

  // 原样解不出 —— 这时才允许怀疑"开头落在半个字符上"。削完再试一次严格 UTF-8。
  const trimmed = trimLeadingOrphans(raw);
  if (trimmed.length !== raw.length && trimmed.length > 0) {
    const retried = decodeUtf8Strict(trimmed);
    if (retried !== null) return retried;
  }

  // ⚠️ GBK 那一支**必须用原始字节**,不能用削过的 `trimmed` —— 削的判据是 UTF-8 的
  // 续字节形状,而 GBK 的首字节正落在同一个区间。拿削过的字节去解 GBK,就是把一段
  // 好端端的中文错位(见 `trimLeadingOrphans` 的注释:这正是「或批处理文件。」变成
  // 「蚺砦募」的原因)。
  const lossy = new TextDecoder("utf-8").decode(raw);
  try {
    const gbk = new TextDecoder("gbk").decode(raw);
    return countReplacement(gbk) < countReplacement(lossy) ? gbk : lossy;
  } catch {
    // 这份 Node 的 ICU 没带 gbk。退回有损 UTF-8 —— 至少 ASCII 部分是对的。
    return lossy;
  }
}

const REPLACEMENT = "\uFFFD";

function countReplacement(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === REPLACEMENT) count += 1;
  return count;
}