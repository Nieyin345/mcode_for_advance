/**
 * 【ARC-005 V2】**Escape 的层级仲裁** —— "Esc 关最内层"。
 *
 * ## 它在补哪个洞（源码可确认的旧行为）
 *
 * 渲染端有 70+ 处各自 `addEventListener("keydown")` 处理 Escape。其中一部分是
 * **捕获阶段**（`ActivityCluster`、`FileMentionPicker`、`LibraryPicker`、
 * `PlanViewer`…），一部分是冒泡阶段。捕获阶段里 `stopPropagation()` 只能拦住
 * **同一节点上后注册的监听**与向下传播，而分处不同子树的两个捕获监听器都会收到
 * 同一个事件。实测形态：
 *
 *   - 活动弹层开着（自己关了），同一次 Esc 继续传到 `PlanViewer`，把计划面板也关了；
 *   - 文件提及选择器开着（自己关了），同一次 Esc 把输入框里的草稿状态也清了。
 *
 * 用户看到的是"按一次 Esc 关了两层"。这就是台账说的"Esc 最内层"。
 *
 * ## 判据为什么不能靠 event.stopPropagation()
 *
 * 因为两个监听器可能挂在**同一节点**（都是 `document` 捕获）且**注册顺序固定**
 * （组件挂载顺序），而"谁最内层"是**渲染树**的事实，不是挂载顺序的事实。
 * 活动弹层可能比计划面板更晚挂载、也可能更早 —— 依赖顺序等于把正确性押在
 * 组件树的偶然形状上。
 *
 * ## 这份实现
 *
 * - `openEscapeLayer(id)` 返回一个 `close()`，layer 按**打开顺序**入栈；
 * - `isTopEscapeLayer(id)` 回答"这次 Esc 该不该由我处理" —— 只有栈顶能处理；
 * - `dispatchEscape()` 交给栈顶处理（组件在 handler 里调 `isTopEscapeLayer` 或
 *   `claimEscape`）。
 *
 * 为什么"打开顺序 = 内层顺序"成立：后打开的一定画在先打开的上面（模态/弹层
 * 的常识，也是本仓库所有弹层的实际行为 —— 后开的 portal 节点在 DOM 末尾、
 * 层级更高）。若哪天出现"打开顺序 ≠ 视觉层级"的弹层，应该改的是那个弹层，
 * 而不是把仲裁退回按 DOM 深度猜。
 *
 * 纯模块：不碰 DOM、不 import React，可在无头套件里直接驱动。
 */

const stack: string[] = [];

/** 打开一层。返回的 `close()` 幂等；层被以其它方式移除后调用无副作用。 */
export function openEscapeLayer(id: string): () => void {
  const existing = stack.indexOf(id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(id);
  return () => {
    const i = stack.indexOf(id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 这一层是不是当前最内层（只有它能响应 Esc）。 */
export function isTopEscapeLayer(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/**
 * 尝试认领这次 Esc：是栈顶则返回 true（调用方应当 `preventDefault()` 并关闭自己），
 * 否则返回 false（调用方**必须原样返回**，把事件留给更内层 / 系统）。
 *
 * ⚠️ 调用方**不要**在返回 false 时也 `stopPropagation()` —— 那会把事件拦在
 * 外层，栈顶永远收不到。
 */
export function claimEscape(id: string): boolean {
  return isTopEscapeLayer(id);
}

/** 当前层栈快照（诊断与套件用；顺序 = 外→内）。 */
export function escapeLayerStack(): readonly string[] {
  return [...stack];
}

/** 清空（只给无头套件用 —— 生产里层由组件卸载时 close）。 */
export function resetEscapeLayersForTests(): void {
  stack.length = 0;
}
