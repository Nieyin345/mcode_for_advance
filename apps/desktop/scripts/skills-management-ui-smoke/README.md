# Skill management browser regression

Run `node apps/desktop/scripts/run-smokes.mjs skills-management-ui-smoke`.

Renders the real SkillsPanel and ProjectSkillsView, useRpc, UI primitives,
bilingual translations and CSS in an independently launched Chromium profile.
The API and session are explicitly in-memory fixtures; real filesystem behavior
is tested separately in skills-management-smoke. No models or external network.
Uses the existing readonly browser driver, not the concurrently edited shared
ui-interaction test entrypoints. It never attaches to or closes the user browser.

Covers direct row deletion/cancellation/error without reading a Skill, retained
group deletion and readonly guards, global versus project copies, read failure
versus true empty source, out-of-order reads, scoped project dropdown/copy/edit/
delete, late project replies, busy-target lock, retries, English and keyboard
selection. Additional checks preserve group partial-failure reporting, active-
project node references, duplicate-name project paths and no-project handling.
Screenshots, source hashes and complete check results are retained
in `.tmp/skills-management-ui-*`.

The unmodified UI ran the same suite: 1 passed / 12 failed (13 cases).
The expanded suite has 17 cases; the scope-split regression was first reproduced
as 16 PASS / 1 FAIL before fixing the node-overview inventory.
Browser fixtures are not proof of native Electron IPC or installed-app behavior.
