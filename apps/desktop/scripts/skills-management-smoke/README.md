# Skill management filesystem regression

Run `node apps/desktop/scripts/run-smokes.mjs skills-management-smoke`.

Uses real skill discovery, contracts, IPC handler implementations and temporary
files. HOME and USERPROFILE both point to a unique test directory before module
import. The test checks that isolation before touching files. Only Electron,
logging, plugin-source enumeration and the project repository are isolated.
No model, network, real app, user Skill directory or user database is used.

Covers hidden/system folders, readable SKILL.md qualification, frontmatter-name
versus folder identity, full untruncated source, empty-versus-failed reads,
logical-name collisions, per-project read/save/delete isolation, independent
copy/no-overwrite, readonly contributed skills, link-only deletion, and unchanged
name/traversal rejection. Artifacts and exit status remain in `.tmp/skills-management-*`.

The old implementation ran these assertions: 4 passed / 15 failed (19 cases).
This is not an installed-Electron application or real-user-data acceptance test.
