/**
 * `sherpa-onnx-node` 的替身 —— 默认**不抛**,于是「模型没选 / 文件不全」那两条
 * RPC 能验到底(真包一加载就去找原生 `.node`,在这台机器上不一定找得到)。
 *
 * ## 与真包的差别(唯一一处,写在这里免得日后误读)
 *
 * 真包找不到原生 addon 时是在 **模块体里抛**(`addon.js` 末尾那句
 * `throw new Error('Could not find sherpa-onnx-node...')`),也就是 `require()`
 * 的那一刻;`speechRecognizer.ts` 里那句 require **没有 try/catch**,于是它变成
 * `startSession()` 的一次 rejection。
 *
 * 这里由 `__failNextLoad()` 改成**在构造线上**抛同一段原文。原因是 esbuild 的
 * `--alias:` 会把 stub 内联成惰性初始化,模块体在抛之后**每次访问都会重跑**
 * (esbuild 的 `__esm` 只在成功后才把初始化函数置空)——「模块体里抛一次」在打包
 * 产物里做不到。观测结果是一样的:`getOnlineRecognizer()` 抛出一段原生加载器的
 * 原文,`startSession` reject。§5(c) 断的就是这个。
 *
 * ## 类型上故意"不干净"
 *
 * 这个文件被 `apps/desktop/tsconfig.json` 的 `include: ["scripts/**\/*")` 收进去,
 * 所以它也得过 tsc。但它**不能** `import type { OnlineRecognizer } from "@main/…"`
 * ——那是被测模块的内部接口,写进来就成了自己给自己出题。所以下面用 `any`:
 * 这个桩只保证**形状**与被测代码里那几个 duck-type 接口对得上。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

let failNextConstruct = false;

/** 下一次 `new OnlineRecognizer(cfg)` 抛 —— 模拟原生 addon 加载失败。 */
export function __failNextLoad(): void {
  failNextConstruct = true;
}

/** 每一次 `new OnlineRecognizer(cfg)` 的配置 —— 断言拿它看路径拼对了没有。 */
export const builtConfigs: any[] = [];

/** 每一次 `createStream()` —— 验"停止/取消之后有没有把流放干净"。 */
export const createdStreams: FakeStream[] = [];

/** 每一次 `acceptWaveform` / `decode` / `reset` / `inputFinished`。 */
export const calls: string[] = [];

export function resetRecorder(): void {
  builtConfigs.length = 0;
  createdStreams.length = 0;
  calls.length = 0;
}

/** `getResult()` 返回的文本(脚本按需摆)。 */
let resultText = "";
/** 还要返回几次真文本,然后变空 —— 真的 `getResult()` 在 `reset()` 之后就是空的。 */
let resultLeft = Number.POSITIVE_INFINITY;
/** `isReady()` 还会返回几次 true。0 = 永远不 ready(默认,不 decode)。 */
let readyLeft = 0;

export function __setResultText(text: string): void {
  resultText = text;
}
/** 只让这一个会话的 `reset()` 好使,之后 `isReady()` 归零 —— 停掉 decoder。 */
export function __stopDecoder(): void {
  readyLeft = 0;
  resultLeft = 1;
}
/** 让 `while (isReady())` 循环跑 `n` 圈然后停。真的 `isReady()` 会在排空之后
 *  变 false,这里必须自己收敛,否则 `while` 是个死循环。 */
export function __setReady(n: number): void {
  readyLeft = n;
}

interface FakeStream {
  handle: { id: number };
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

let streamSeq = 0;

class FakeStreamImpl implements FakeStream {
  handle = { id: ++streamSeq };
  acceptWaveform(): void {
    calls.push("acceptWaveform");
  }
  inputFinished(): void {
    calls.push("inputFinished");
  }
}

/** 与真包同名同形:`new (cfg)` → `createStream/isReady/decode/isEndpoint/reset/getResult`。 */
export class OnlineRecognizer {
  constructor(cfg: any) {
    if (failNextConstruct) {
      failNextConstruct = false;
      // 真包 `addon.js` 里那句原文 —— 一段没有"我该做什么"的原生加载器措辞。
      throw new Error(
        "Could not find sherpa-onnx-node. Tried\n\n" +
          "  ../build/Release/sherpa-onnx.node\n" +
          "  ./node_modules/sherpa-onnx-win-x64/sherpa-onnx.node\n",
      );
    }
    // 真的那一个在这里去读 tokens/encoder/decoder/joiner 四个 ONNX 文件。
    // 本套**故意不读磁盘** —— 不碰真模型,也不该因为夹具是空壳文件就挂。
    builtConfigs.push(cfg);
  }
  createStream(): FakeStream {
    const s = new FakeStreamImpl();
    createdStreams.push(s);
    return s;
  }
  isReady(): boolean {
    if (readyLeft <= 0) return false;
    readyLeft -= 1;
    return true;
  }
  decode(): void {
    calls.push("decode");
  }
  isEndpoint(): boolean {
    return false;
  }
  reset(): void {
    calls.push("reset");
    // 真的 `reset()` 之后 `getResult()` 是空的 —— 这一条**必须**有,否则
    // `commitSegment` 里那句"reset 之后还有文字就换掉整条流"会被触发,而那条
    // 分支本套没打算验(它会给每个会话换流,污染"没有多开流"那条断言)。
    resultLeft = 0;
  }
  getResult(): { text: string } {
    if (resultLeft <= 0) return { text: "" };
    resultLeft -= 1;
    return { text: resultText };
  }
}
