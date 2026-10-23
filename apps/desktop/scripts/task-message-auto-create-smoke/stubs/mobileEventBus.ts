/**
 * `mobileEventBus` 的替身 —— 真的那个会开 SSE 服务端 / 拉进 electron。
 *
 * 本套验的是「任务被建出来、状态对」,不验手机端推送。广播是**顺带的**,丢掉它
 * 不影响被测的那两件事。所以这里只把广播收进一个数组:需要时套件可以断言
 * 「建任务之后确实广播了」,但**不**用真的传输层。
 */
import type { RuntimeEvent } from "@contracts/runtime";

export const __broadcast: RuntimeEvent[] = [];

export const mobileEventBus = {
  broadcast(e: RuntimeEvent): void {
    __broadcast.push(e);
  },
};
