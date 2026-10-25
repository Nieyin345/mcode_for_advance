# ARC-005 native pane / Monaco / xterm Electron U1

Run on Windows with project-local dependencies (no external network):

```bat
node apps/desktop/scripts/arc005-pane-electron-smoke/build.mjs
```

The suite mounts the **real Mcode App, ThreePaneLayout, FileEditor, Monaco
instance, TerminalPanel and TerminalView/xterm** under a real Electron
BrowserWindow. It loads base CSS and the production ARC-005 workspace
stylesheet. Only unrelated left sidebar rendering and external transport,
native PTY backend and Monaco workers are replaced by isolated stubs.

The positive `green` run verifies:

- Real app, xterm and Monaco TextModel mounted
- Real Electron mouse drag of the right pane from right to left and back
- **No recreated Monaco DOM**, no repeated `terminal.create` / `kill`
- In-memory *unsaved* Monaco text persists after right-pane drag
- Closing/reopening the actual bottom terminal and right panel via store
  actions preserves terminal DOM, session identity, Monaco DOM and draft
- Native Chromium keyboard input creates a second xterm tab and uses ArrowLeft / ArrowRight to switch without additional PTY spawn/kill; the right toolbar's ArrowRight moves focus without invoking a tab action
- Both collapsed areas are inert / hidden from accessibility
- Corrupt pane-layout JSON or structure restores defaults and renders a
  user-visible warning rather than silently discarding preference data

Two **negative mutation runs** are compulsory: `rekey` adds a wrong React
`key` to the real center pane and must cause PTY/Monaco identity failures;
`silent` removes the visible corruption warning and must fail the notice
check. Their expected nonzero exit codes are *test evidence*, not flaky
production failures. A green run passes only if all 15 checks pass, and the
source-file SHA comparison confirms no project source mutations.

`MCODE_PANE_U1_ONLY=green` can limit quick diagnostic execution; full
acceptance **must** omit that environment variable. Evidence is written to
`apps/desktop/.tmp/arc005-pane-electron-*/result.json` and per-variant logs.
The test uses synthetic project paths and an **RPC PTY stub**. It does not
start a real operating-system shell, execute user commands, load a Monaco
language-service worker or access the user's files. These need separate
production E2E validation. Do not report this suite as proof of real PTY
process lifecycle or real backend persistence.

The visual-only baseline is a different suite:
`node apps/desktop/scripts/arc005-visual-baseline/build.mjs`.
It measures the full 18×3 theme/layout matrix and includes a 640-message
virtualized ChatPane sample. Its editor and terminal *visual scenes* remain
explicit static fixtures; only this pane U1 suite mounts Monaco/xterm.
