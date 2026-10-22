/**
 * T16 —— 旅程注册表（本套件的默认入口）。后续任务卡**不要改这里**去 import
 * 它们的旅程；而是把三个文件（driver/ + 自己的 journeys/ + 自己的 build 入口）
 * 复制到自己的套件，或参考 README 的 registry 用法。
 */
import { uiProjectSwitch } from "./01-ui-project-switch.js";
import { fileSideEffect } from "./02-file-side-effect.js";
import { deliberateFailure } from "./03-deliberate-failure.js";

export const journeys = [uiProjectSwitch, fileSideEffect, deliberateFailure];
export default { journeys };
