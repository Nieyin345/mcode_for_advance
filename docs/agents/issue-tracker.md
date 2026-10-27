# Issue Tracker: Local Markdown

## Primary tracker

Engineering Skill specifications and planning tickets are stored as local Markdown files in `.scratch/`.

GitHub Issues are not the default tracker for these skills, even if the repository has a Git remote.

## Directory conventions

Each engineering effort has its own directory:

```text
.scratch/<feature-slug>/
├── spec.md
├── map.md
└── issues/
    ├── 01-<slug>.md
    ├── 02-<slug>.md
    └── ...
```

- `spec.md`: approved problem statement, intended behavior, scope, and testing decisions.
- `map.md`: optional Wayfinder planning map containing decisions, dependencies, unresolved questions, and out-of-scope items.
- `issues/NN-<slug>.md`: one ticket per file, numbered from `01` in dependency order.
- `Blocked by`: references the numbered tickets that must resolve before this ticket can start.
- `## Comments`: append relevant follow-up discussion without overwriting prior history.

### Ticket header format

Use the same header in every `.scratch/<effort>/issues/` file so the two skills
that read them (`triage`, `wayfinder`) and a human scanning the directory all
see the same fields:

```markdown
# <NN>：<ticket title>

Type: task            # research | prototype | grilling | task
Status: ready-for-agent
Category: enhancement # bug | enhancement
Labels: wayfinder:task

**Blocked by:** None (can start immediately).

<goal / what to build>

## Comments

- <date>: <note>
```

`Type:` and `Status: claimed|resolved` are required for Wayfinder tickets.
`Status: <triage role>` is used for ordinary implementation tickets; the two
conventions share the field name but not the vocabulary, so read `Type:` first.
`Labels:` is a local addition carrying a `wayfinder:*` marker; it is not a
triage role and does not replace `Status:`.

## Triage conventions

Use these five state values:

- `needs-triage`
- `needs-info`
- `ready-for-agent`
- `ready-for-human`
- `wontfix`

Implementation and planning tickets should also record a category when triaged:

- `Category: bug`
- `Category: enhancement`

For ordinary implementation tickets, `Status:` records the Triage state.
For Wayfinder decision tickets, `Type:` records the ticket type and
`Status:` records `claimed` or `resolved`, as required by the Wayfinder skill.

Do not confuse a planning decision being resolved with an implementation
task being completed and accepted.

## Relationship with Mcode execution tasks

**Functional goals live in `docs/功能文档.md`** (numbered entries such as `EDIT-04`). There is no execution-card index: the old `tasks/` tree and `audit-ledgers/` were deleted on 2026-10-26 — do not recreate them, and read progress from the code and the smoke suites instead.

- Planning tickets live under `.scratch/<feature-slug>/` (`spec.md` + `map.md` + `issues/`).
- When reporting a gap, cite the `功能文档` entry it belongs to, plus the code location and how to reproduce.
- Use `.scratch/` when engineering skills need a feature specification, exploratory questions, or a dependency graph.
- When an approved planning ticket must be delegated to an independent Mcode execution conversation, create a bounded `tasks/T<number>-*.md` card and link the planning spec/ticket path when applicable.
- Link the planning spec/ticket path from the execution card.
- Do not duplicate the entire specification in the execution card. Include
  only the context required to execute the bounded task.
- The T task card is authoritative for writable file boundaries, acceptance
  criteria, required tests, commit requirements, and result writeback.
- The `.scratch/` spec and map are authoritative for the broader goal,
  planning decisions, and dependency relationships.

## Required Skills in new T task cards

- Every newly created T-numbered execution card must include a `## Required Skills` section.
- List exact skill names and a short explanation of when and why each skill applies.
- Select only skills relevant to the task; do not list every installed skill by default.
- Tell the execution agent to read the listed skill's `SKILL.md` before applying its workflow.
- Do not retrofit existing task cards unless explicitly requested.

If a planning ticket and a T task disagree about execution scope, stop and
reconcile the conflict before modifying code. Do not silently broaden a task.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket. This section was missing from this repo's tracker doc; it is restored here from the canonical setup skill (`setup-matt-pocock-skills/issue-tracker-local.md`) because `wayfinder` explicitly requires it.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body. One map per effort; it is the canonical artifact, not a summary of the tickets.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research` / `prototype` / `grilling` / `task`); a `Status:` line records `claimed` / `resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; lowest number wins.
- **Claim**: set `Status: claimed` and save **before** any work starts, so a parallel session does not pick the same ticket.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

Wayfinding tickets resolve **decisions**, not implementation slices. Resolving one does not close any `tasks/` card; when an approved decision needs code, create a bounded `tasks/T<number>-*.md` card per the section above.

## Publishing

When an engineering skill says "publish to the issue tracker", write to
`.scratch/<feature-slug>/` following the conventions above.

Never publish to GitHub or another external tracker unless the user
explicitly changes this configuration.
