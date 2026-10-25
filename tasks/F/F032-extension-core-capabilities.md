# F032｜扩展功能批量补齐：工作区、文件系统、配置、输入、状态栏、右键菜单

- Status: **E1 core feature batch implemented and acceptance recorded; product-wide COMPLETE not claimed**
- Depends: F029–F031
- Owner: F extension track
- Required Skills: mcode-smoke, codebase-design
- Exclusive source: `apps/desktop/src/main/modules/theiaHost/`, `apps/desktop/src/main/ipc/theiaInstalled.ts`, contracts modules/events/rpcMap (if changed), preload, renderer App/FileEditor/extension panels and new adapters, extension fixtures / dedicated tests. Other uncommitted work must remain unchanged.

## Core functionality implemented (actual code)

1. **Workspace binding**: launching an installed VSIX with the selected Mcode project's real absolute path passes an opened `McodeWorkspaceFs` to Theia. After host initialization, the workspace-folder event publishes a real `file:` workspace folder before extension activation; no dummy project. With no project path, file operations explicitly reject.
2. **`vscode.workspace.fs`**: actual async stat, readdir, readFile, writeFile, mkdir, rename, copy and nonrecursive delete within the workspace. Validates URI scheme/root traversal, rejects symlink components and workspace root deletion. Bounded 8MiB per file. This adapter does **not** confer a Node runtime sandbox: installed extensions can still access other local files via their own `fs` imports.
3. **`workspace.findFiles`**: bounded asynchronous glob search in the active Mcode workspace; ignores `.git`, `node_modules`, temp/cache dirs and symlink entries; 10,000 visited / max 500 returned. Basic glob syntax is implemented, not full VS Code include/exclude semantics.
4. **VS Code configuration**: `PreferenceRegistryMain.update/remove` actually writes extension-scoped JSON under Mcode-managed installation storage; `PreferenceRegistryExt.$acceptConfigurationChanged` updates the live host. Settings survive restart. The Mcode VSIX manager can list/edit declared **string/number/boolean** settings while enforcing manifest-declared keys and owner session; no overwriting global Mcode preferences. Full VS Code resource/language-scoped settings and object/array editing are not yet implemented.
5. **`showQuickPick` and `showInputBox`**: real Theia `QUICK_OPEN_MAIN` RPC to Mcode root-mounted native input/pick layer, sender/session-bound broker, cancel/timeout, bounded choices and arrays, native focus management, no polling or second Theia window. Advanced streamed quick input, async validation, button contributions not yet supported.
6. **Status bar contributions**: real `STATUS_BAR_MESSAGE_REGISTRY_MAIN.$setMessage/$dispose` routed into Mcode root status strip, supports command invocation through the same session/editor bridge and session-stop invalidation.
7. **Editor menu contributions**: resolves verified VSIX manifest `contributes.menus["editor/context"]`, gets authentic command title/registration, adds supported unconditional/`editorTextFocus` items to Mcode's real Monaco `addAction` context menu. Owner-scoped contribution change events refresh without polling. Full VS Code `when` expression engine, explorer/context and other menu placements not implemented.

## Tests and evidence

- Real Theia child / installed extension E1 **87/87 PASS**, exercises workspace.fs write/read/readdir/stat + search, blocks `..` escapes; extension private configuration persists and updates live; real quickPick chooses `Beta`, inputBox returns typed value; status item emits/disposes; editor/context menu metadata recognized; existing two independent VSIX lifecycle, editor edits and messages remain passing.
- Native palette/broker E1 **51/51 PASS**, includes cross-sender/expired Quick Pick replies, no polling, context menu source installation and native inputs/status wiring.
- Real Theia host boot: PASS.
- Integrated regression **11/12 PASS**, path `apps/desktop/.tmp/smoke-runs/1792919455009-34200-YJ6OzD/`. **One FAIL is unrelated concurrent document-view IPC wiring**: `ipc-wiring-smoke` reports missing preload forwarding for `mcode:document-view:write-recovery`. Do not modify or waive owner team's handler to force green.
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`: PASS. Full desktop `tsc` is currently **blocked by concurrent code**: `apps/desktop/scripts/library-search-preview-smoke/main.ts:82` TS2367 and `apps/desktop/src/main/document/genofficeCli.ts:738` TS2339. Both outside F-owned modifications; not edited.
- Diff check: PASS. `vendor/theia`: clean.
- **Electron real-window U1 not run**. A code-level source/assertion test cannot replace actual Monaco right-click/dropdown/focus/visual QA.

## Remaining acceptance gaps / NOT COVERED

- Full VS Code API coverage (many reverse `*Main` services remain stubs): webviews, language services, diagnostics, debugger, terminal, file watchers, custom editor, task integration, advanced QuickInput, explorer menus, `when` grammar, full settings scopes, extension upgrades, conflict recovery.
- Runtime packaged Theia still depends on built `vendor/theia`; no full release distribution check.
- Extension process is unsandboxed Node; install-time disclosure is not runtime isolation.
- Unified ModuleHost lifecycle/permissions, shared extension worker, real Electron U1, startup/RSS performance numbers not yet finished.
- Preserve all unrelated dirty files and parallel git activity.

- Source commit SHA: `469f5d8a`（20 个扩展专属源码/测试文件精准提交，保留所有并行对话未提交修改）。任务台账另行提交。
