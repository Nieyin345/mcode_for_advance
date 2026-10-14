/**
 * **按会话种类派生本轮的工具画像(生产侧的画像来源)** —— MC-100/101 残余。
 *
 * ## 它修的是什么(「接上了却没人用」那一类)
 *
 * 上一轮把「工具选择 → 三引擎 SDK 形态」接好了(`orchestration/toolSelection.ts` 的
 * `resolveEngineToolSelection`,三个 provider 都消费)。但复核指出:生产侧**没有任何
 * 地方设过 `StartTurnRequest.toolProfile`** —— 于是每一轮都走缺省 `full`,裁剪链虽然
 * 接通了却**从不真的裁**。这正是本仓反复点名要消灭的假接线。
 *
 * 这份模块就是那条缺失的**派生**:在生产路径上**发起** `StartTurnRequest` 的地方
 * (`claude/RuntimeManager.ts` 的 `sendTurnBound`)按会话种类给一个画像。
 *
 * ## 判据:确定性、可解释、绝不「猜不出就悄悄裁」
 *
 *  - **`side`(右栏「子会话」的 Q&A)** → `chat` 桶。契约把 `side` 定义为
 *    「side-chat **Q&A** session」(见 `@contracts/session` 的 `kind`):它是就**当前对话**
 *    提问 / 讲解 / 规划的一轮,正对应 `chat` 桶(提问、进出计划模式、待办、子代理、网页
 *    读写、UI 口令、技能)。它**不跑工作流**(`runner.ts` 里 `workflowPrompt` 对非 chat
 *    恒为 `none`),故 `workflow` 桶确非所需。**能力不丢**:floor(`app_api_list → describe
 *    → call`)恒在,任何被裁掉的能力都能经统一发现通道**按需**取回 —— 这正是 MC-100
 *    「最小上下文 + 按需发现」的设计,不是「少给工具」。
 *  - **其余三种 → 显式 `full`**:
 *      · `chat`  —— 用户驱动的主对话,**任务任意**,不替它猜一个窄画像;
 *      · `node`  —— 图上的某一格,「该格要哪些桶」由**节点参数**(`capability` 等)决定,
 *                   这个入口(`sendTurnBound`)拿不到节点,推不出来;
 *      · `automation` —— 后台自动化,桶由它跑的工作流 / 节点决定,同样推不出来。
 *    推不出来就**显式**选 `full`(`FULL_PROFILE_NAME`),而**不是**省略参数 —— 省略正是
 *    「某个分支忘了传参」的成因(见 `@contracts/toolProfile` 文件头那条)。**绝不因为
 *    「猜不出」就把工具悄悄裁掉**:模型少工具而没人知道,是本仓明确要消灭的一类坏法。
 *
 * ## 边界(别越)
 *
 * **纯函数**:只吃 `session.kind`,回一份 `ToolProfile`。不碰磁盘、不起 SDK、不 import
 * 主进程的重链 —— 只 import 契约。这一条是**装配约束**:`RuntimeManager` 要能静态
 * import 它而**不成环**(工具**清单**那条链会经 `appControl/tools.ts` 绕回
 * `RuntimeManager`,所以派生层**不能**去拉那份清单,只能拿种类这个轻信号)。
 */
import { FULL_PROFILE_NAME, type ToolProfile } from "@contracts/toolProfile";
import type { Session } from "@contracts/session";

/** `side`(Q&A 子会话)用的小画像名。见文件头:契约把 side 定义为 Q&A,对应 `chat` 桶。 */
export const SIDE_CHAT_TOOL_PROFILE_NAME = "chat" as const;

/**
 * **生产侧唯一的画像来源**。给定会话行,回本轮该用的 `ToolProfile`。
 *
 * 规则只有一条、且**是显式分支**(不是「拿不到就用默认」):
 *   - `kind === "side"` → `{ name: "chat" }`(Q&A 子会话,chat 桶);
 *   - 其余一切(含 `chat` / `node` / `automation`)→ `{ name: "full" }`(显式全量)。
 *
 * 返回的永远是**具体的名字**,绝不留 `undefined` 让下游去猜 —— 下游
 * (`resolveEngineToolSelection`)也据此按名字判,不再有「省略 = 全量」这条隐式路。
 */
export function toolProfileForSession(session: Pick<Session, "kind">): ToolProfile {
  if (session.kind === "side") return { name: SIDE_CHAT_TOOL_PROFILE_NAME };
  return { name: FULL_PROFILE_NAME };
}
