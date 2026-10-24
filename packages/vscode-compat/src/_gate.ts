/**
 * 编译期闸门 —— **本文件不是实现，是缺口清单的可执行形式。**
 *
 * ## 怎么读这个文件
 *
 * 每条 `satisfies typeof vscode.X` 都是一个「必须有全部成员才能通过」的断言。
 * 我们**故意**只写出少数几个成员（或一个都不写），所以每一行都应当编译失败，
 * 报错会点名缺哪些方法。那份报错就是「这个命名空间还差什么」的机器答案。
 *
 * 16 个命名空间全部在此（`@types/vscode@1.140.0` 的顶层 `export namespace`，
 * 用 TypeScript compiler API 数出来的，见任务卡回写区「怎么数的」）。
 *
 * ⚠️ **`_gate.ts` 被 `tsconfig.json` 的 `exclude` 排除了。**
 * 少了那行，整包 `tsc` 永远编译不过 —— 因为下面每一行都本意是红的。
 * 它只由 `apps/desktop/scripts/vscode-compat-gate-smoke` 单独编译。
 *
 * ## ⚠️ 为什么必须用裸 `satisfies`，不能写 `as` / `satisfies Partial<>`
 *
 * | 写法 | 缺成员时的行为 |
 * |---|---|
 * | `{...} as typeof vscode.commands` | **编译通过**（类型足够重叠时）—— 断言被 `as` 抹掉 |
 * | `{...} satisfies Partial<typeof vscode.commands>` | **编译通过** —— 部分满足就算满足 |
 * | `{...} satisfies typeof vscode.commands` | **编译失败**，报错点名缺的成员 |
 *
 * 套件第 4 组现场验证前两种会假绿，附加组逐命名空间断言本文件用的是第三种。
 *
 * ## ⚠️ 本文件不是实现
 *
 * 一行 API 实现都没有。出现的方法体只是让对象字面量「像一个成员」，没有任何行为语义
 * （没有注册表、没有事件、没有 IPC）。**不要 import 这个文件的任何导出。**
 */

import type * as vscode from "vscode";

// ═══════════════════════════════════════════════════════════════════════════
// 有「最小可写形状」的命名空间 —— 实现一个成员，让报错点名其余全部缺口
// ═══════════════════════════════════════════════════════════════════════════

// ── commands ── 4 个成员；已写 1 个，缺口：registerTextEditorCommand / executeCommand / getCommands
const _commands_impl = {
  registerCommand: (_command: string, _callback: (...args: any[]) => any, _thisArg?: any) => ({ dispose() {} }),
};
export const _commands = _commands_impl satisfies typeof vscode.commands; // ← 必须红

// ═══════════════════════════════════════════════════════════════════════════
// 全空对象 —— 每个命名空间的缺口数见回写区表格
// ═══════════════════════════════════════════════════════════════════════════

// ── window ── 缺口：未实现（57 个唯一成员）
const _window_impl = {};
export const _window = _window_impl satisfies typeof vscode.window; // ← 必须红

// ── workspace ── 缺口：未实现（45 个唯一成员）
const _workspace_impl = {};
export const _workspace = _workspace_impl satisfies typeof vscode.workspace; // ← 必须红

// ── languages ── 缺口：未实现（40 个唯一成员）
const _languages_impl = {};
export const _languages = _languages_impl satisfies typeof vscode.languages; // ← 必须红

// ── env ── 缺口：未实现（21 个唯一成员）
const _env_impl = {};
export const _env = _env_impl satisfies typeof vscode.env; // ← 必须红

// ── debug ── 缺口：未实现（18 个唯一成员）
const _debug_impl = {};
export const _debug = _debug_impl satisfies typeof vscode.debug; // ← 必须红

// ── tasks ── 缺口：未实现（8 个唯一成员）
const _tasks_impl = {};
export const _tasks = _tasks_impl satisfies typeof vscode.tasks; // ← 必须红

// ── lm ── 缺口：未实现（7 个唯一成员）
const _lm_impl = {};
export const _lm = _lm_impl satisfies typeof vscode.lm; // ← 必须红

// ── authentication ── 缺口：未实现（4 个唯一成员）
const _authentication_impl = {};
export const _authentication = _authentication_impl satisfies typeof vscode.authentication; // ← 必须红

// ── notebooks ── 缺口：未实现（3 个唯一成员）
const _notebooks_impl = {};
export const _notebooks = _notebooks_impl satisfies typeof vscode.notebooks; // ← 必须红

// ── extensions ── 缺口：未实现（3 个唯一成员）
const _extensions_impl = {};
export const _extensions = _extensions_impl satisfies typeof vscode.extensions; // ← 必须红

// ── l10n ── 缺口：未实现（3 个唯一成员）
const _l10n_impl = {};
export const _l10n = _l10n_impl satisfies typeof vscode.l10n; // ← 必须红

// ── scm ── 缺口：未实现（2 个唯一成员）
const _scm_impl = {};
export const _scm = _scm_impl satisfies typeof vscode.scm; // ← 必须红

// ── comments ── 缺口：未实现（1 个唯一成员：createCommentController）
const _comments_impl = {};
export const _comments = _comments_impl satisfies typeof vscode.comments; // ← 必须红

// ── tests ── 缺口：未实现（1 个唯一成员：createTestController）
const _tests_impl = {};
export const _tests = _tests_impl satisfies typeof vscode.tests; // ← 必须红

// ── chat ── 缺口：未实现（1 个唯一成员：createChatParticipant）
const _chat_impl = {};
export const _chat = _chat_impl satisfies typeof vscode.chat; // ← 必须红
