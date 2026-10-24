/**
 * `@mcode/vscode-compat` —— VS Code API 兼容层的契约骨架。
 *
 * ## 现状（2026-10-24，F018）
 *
 * **这个包目前没有任何实现。** 它存在的目的有三个：
 *
 * 1. **命名空间清单**：`@types/vscode@1.140.0` 是官方类型定义，`src/_gate.ts`
 *    逐命名空间用裸 `satisfies` 断言「实现必须完整」—— 缺一个成员编译就红。
 * 2. **缺口表**：每个命名空间还差多少成员、能映射到 Mcode 哪个底层，
 *    记在 `tasks/F/F018-vscode-compat-skeleton.md` 的结果回写区。
 * 3. **闸门纪律**：套件 `apps/desktop/scripts/vscode-compat-gate-smoke`
 *    验证 `as` / `satisfies Partial<>` 会放过缺成员 —— 所以本包只许用裸 `satisfies`。
 *
 * ## 为什么不导出任何东西
 *
 * 导出 `commands` / `window` 之类会让下游以为「这能用」。在它们真的能用之前，
 * 让 import 失败比让调用静默 no-op 好。**本包的类型只通过 `_gate.ts` 起作用，
 * 而 `_gate.ts` 被 `tsconfig` exclude —— 这是故意的。**
 */

export const PACKAGE_STATUS = "skeleton-only" as const;
