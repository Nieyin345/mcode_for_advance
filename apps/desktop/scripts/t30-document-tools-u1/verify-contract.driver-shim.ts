/** 静态自检专用的 driver 入口：只转发**纯数据 / 纯判定**，不碰 runner（electron）。 */
export { defineU1Journey, step, stepName } from "../electron-u1/driver/steps.js";
export { classifyJourney, literalStatus, suiteExitCode } from "../electron-u1/driver/verdict.js";
