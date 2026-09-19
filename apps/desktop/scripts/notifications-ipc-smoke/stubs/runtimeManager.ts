/**
 * `@main/claude/RuntimeManager.js` 的替身。
 *
 * ⚠️ **只换这一个,`NotificationManager` 留真的。** 本套要验的一半就是"内存里那份
 * prefs" —— 把它换掉等于验桩自己(`getPrefs()` 回读的就是它)。而它 `import` 的
 * `runtimeManager` 会一路拖到三个引擎的 SDK,那是不必要且拉不动的东西。
 *
 * 真那个 `subscribe()` 返回取消订阅的函数(见 NotificationManager.start)。本套不
 * 从事件那条路验(那是 frontend-smoke 的活),给个空函数就够。
 *
 * `isTurnEndHeld` 也必须有:本套 §3 拿 `turn.done` 当"当前这次运行会不会弹"的探针,
 * 而 `evaluate` 在那条路上会问一句它。少了这个成员报的是
 * `isTurnEndHeld is not a function` —— 看起来像"被测代码调了个不存在的 API",其实
 * 只是替身不全(同 frontend-smoke 里那段注释)。本套不验"被扣住时",一律 false。
 */
export const runtimeManager = {
  subscribe(): () => void {
    return () => {};
  },
  isTurnEndHeld(_sessionId: string): boolean {
    return false;
  },
};
